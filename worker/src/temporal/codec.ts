// AES-256-GCM payload codec for Temporal.
//
// Per ADR-0006, anything that does cross into Temporal is encrypted at rest in workflow
// history. This codec runs on both the client side (server action that starts a workflow)
// and the worker side (that executes it); both must use the *same* key, so this file is
// mirrored byte-for-byte at `src/lib/temporal/codec.ts`. Keep the two in sync — a future
// shared workspace package is the obvious place to dedupe them.
//
// No codec server is configured: the Temporal Web UI therefore shows ciphertext, which is
// the intended behavior (sensitive prompts/outputs never sit in plaintext history).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  METADATA_ENCODING_KEY,
  type DataConverter,
  type Payload,
  type PayloadCodec,
} from "@temporalio/common";

const ENCRYPTED_ENCODING = "binary/encrypted";
const ENCRYPTION_KEY_ID_METADATA = "encryption-key-id";
const IV_LENGTH = 12; // GCM standard nonce length
const TAG_LENGTH = 16; // GCM auth tag length

function loadKey(): Buffer {
  const raw = process.env.TEMPORAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TEMPORAL_ENCRYPTION_KEY is not set. Generate one with " +
        "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"` " +
        "and set it (the same value) wherever the Temporal client and worker run."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TEMPORAL_ENCRYPTION_KEY must be 32 bytes (base64-encoded); got ${key.length} bytes.`
    );
  }
  return key;
}

function encrypt(data: Uint8Array, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

function decrypt(blob: Uint8Array, key: Buffer): Buffer {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// A Temporal Payload is { metadata: Record<string, Uint8Array>, data: Uint8Array }. We
// encrypt the whole inner payload (including its own encoding metadata, e.g. json/plain)
// so decryption restores it exactly. Serialize to a self-describing JSON envelope rather
// than pulling in @temporalio/proto for delimited encoding.
function serialize(payload: Payload): Buffer {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.metadata ?? {})) {
    metadata[k] = Buffer.from(v).toString("base64");
  }
  const data = payload.data ? Buffer.from(payload.data).toString("base64") : null;
  return Buffer.from(JSON.stringify({ metadata, data }), "utf8");
}

function deserialize(buf: Buffer): Payload {
  const obj = JSON.parse(buf.toString("utf8")) as {
    metadata: Record<string, string>;
    data: string | null;
  };
  const metadata: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(obj.metadata ?? {})) {
    metadata[k] = new Uint8Array(Buffer.from(v, "base64"));
  }
  return {
    metadata,
    data: obj.data ? new Uint8Array(Buffer.from(obj.data, "base64")) : undefined,
  };
}

export class EncryptionCodec implements PayloadCodec {
  private readonly key: Buffer;

  constructor(key: Buffer = loadKey()) {
    this.key = key;
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({
      metadata: {
        [METADATA_ENCODING_KEY]: new TextEncoder().encode(ENCRYPTED_ENCODING),
        [ENCRYPTION_KEY_ID_METADATA]: new TextEncoder().encode("baseline-default"),
      },
      data: encrypt(serialize(payload), this.key),
    }));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.[METADATA_ENCODING_KEY];
      if (!encoding || new TextDecoder().decode(encoding) !== ENCRYPTED_ENCODING) {
        return payload; // not ours (or already plaintext) — pass through untouched
      }
      return deserialize(decrypt(payload.data ?? new Uint8Array(), this.key));
    });
  }
}

// DataConverter that keeps the default (JSON) payload converter but layers encryption on
// top via the codec. Used by both the Temporal Client and Worker.
export function getDataConverter(): DataConverter {
  return { payloadCodecs: [new EncryptionCodec()] };
}
