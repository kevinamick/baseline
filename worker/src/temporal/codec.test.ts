import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { METADATA_ENCODING_KEY, type Payload } from "@temporalio/common";
import { EncryptionCodec } from "./codec.js";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

function jsonPayload(value: unknown): Payload {
  return {
    metadata: { [METADATA_ENCODING_KEY]: new TextEncoder().encode("json/plain") },
    data: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function decode(bytes: Uint8Array | null | undefined): string {
  return new TextDecoder().decode(bytes ?? new Uint8Array());
}

describe("EncryptionCodec", () => {
  const original = process.env.TEMPORAL_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.TEMPORAL_ENCRYPTION_KEY = KEY_B64;
  });
  afterEach(() => {
    process.env.TEMPORAL_ENCRYPTION_KEY = original;
  });

  it("round-trips a payload through encode → decode", async () => {
    const codec = new EncryptionCodec();
    const payload = jsonPayload({ message: "hello", n: 42 });

    const [encoded] = await codec.encode([payload]);
    const [decoded] = await codec.decode([encoded]);

    expect(decode(decoded.data)).toBe(decode(payload.data));
    expect(decode(decoded.metadata?.[METADATA_ENCODING_KEY])).toBe("json/plain");
  });

  it("marks encoded payloads as binary/encrypted and hides the plaintext", async () => {
    const codec = new EncryptionCodec();
    const payload = jsonPayload({ secret: "do-not-leak" });

    const [encoded] = await codec.encode([payload]);

    expect(decode(encoded.metadata?.[METADATA_ENCODING_KEY])).toBe("binary/encrypted");
    // Ciphertext must not contain the plaintext marker — this is what the Web UI shows.
    expect(Buffer.from(encoded.data ?? new Uint8Array()).toString("utf8")).not.toContain(
      "do-not-leak"
    );
  });

  it("produces a fresh IV each time (ciphertext differs for identical input)", async () => {
    const codec = new EncryptionCodec();
    const payload = jsonPayload({ message: "same" });

    const [a] = await codec.encode([payload]);
    const [b] = await codec.encode([payload]);

    expect(Buffer.from(a.data!).equals(Buffer.from(b.data!))).toBe(false);
  });

  it("passes through payloads it did not encrypt", async () => {
    const codec = new EncryptionCodec();
    const payload = jsonPayload({ message: "plain" });

    const [decoded] = await codec.decode([payload]);

    expect(decoded).toBe(payload);
  });

  it("rejects a missing or wrong-length key", () => {
    delete process.env.TEMPORAL_ENCRYPTION_KEY;
    expect(() => new EncryptionCodec()).toThrow(/TEMPORAL_ENCRYPTION_KEY is not set/);

    process.env.TEMPORAL_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => new EncryptionCodec()).toThrow(/must be 32 bytes/);
  });
});
