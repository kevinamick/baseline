import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { METADATA_ENCODING_KEY, type Payload } from "@temporalio/common";
import { EncryptionCodec, getDataConverter } from "../codec";

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

  it("round-trips a payload with no metadata and no data", async () => {
    const codec = new EncryptionCodec();
    const payload: Payload = {};

    const [encoded] = await codec.encode([payload]);
    const [decoded] = await codec.decode([encoded]);

    expect(decoded.data).toBeUndefined();
    expect(Object.keys(decoded.metadata ?? {})).toEqual([]);
  });

  it("marks encoded payloads as binary/encrypted and hides the plaintext", async () => {
    const codec = new EncryptionCodec();
    const payload = jsonPayload({ secret: "do-not-leak" });

    const [encoded] = await codec.encode([payload]);

    expect(decode(encoded.metadata?.[METADATA_ENCODING_KEY])).toBe("binary/encrypted");
    expect(decode(encoded.metadata?.["encryption-key-id"])).toBe("baseline-default");
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

  it("passes through a payload with no metadata at all on decode", async () => {
    const codec = new EncryptionCodec();
    const payload: Payload = { data: new TextEncoder().encode("x") };

    const [decoded] = await codec.decode([payload]);

    expect(decoded).toBe(payload);
  });

  it("handles multiple payloads in one encode/decode call", async () => {
    const codec = new EncryptionCodec();
    const payloads = [jsonPayload({ a: 1 }), jsonPayload({ b: 2 })];

    const encoded = await codec.encode(payloads);
    expect(encoded).toHaveLength(2);
    const decoded = await codec.decode(encoded);
    expect(decode(decoded[0].data)).toBe(decode(payloads[0].data));
    expect(decode(decoded[1].data)).toBe(decode(payloads[1].data));
  });

  it("throws decrypting a marked-encrypted payload with no data (auth tag / IV can't validate)", async () => {
    const codec = new EncryptionCodec();
    const malformed: Payload = {
      metadata: {
        [METADATA_ENCODING_KEY]: new TextEncoder().encode("binary/encrypted"),
      },
      // data intentionally omitted — exercises the `payload.data ?? new Uint8Array()` fallback.
    };
    await expect(codec.decode([malformed])).rejects.toThrow();
  });

  it("rejects a missing key", () => {
    delete process.env.TEMPORAL_ENCRYPTION_KEY;
    expect(() => new EncryptionCodec()).toThrow(/TEMPORAL_ENCRYPTION_KEY is not set/);
  });

  it("rejects a wrong-length key", () => {
    process.env.TEMPORAL_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => new EncryptionCodec()).toThrow(/must be 32 bytes/);
  });

  it("accepts an explicitly passed key, bypassing env loading", async () => {
    delete process.env.TEMPORAL_ENCRYPTION_KEY;
    const explicitKey = Buffer.alloc(32, 9);
    const codec = new EncryptionCodec(explicitKey);
    const payload = jsonPayload({ ok: true });
    const [encoded] = await codec.encode([payload]);
    const [decoded] = await codec.decode([encoded]);
    expect(decode(decoded.data)).toBe(decode(payload.data));
  });
});

describe("getDataConverter", () => {
  const original = process.env.TEMPORAL_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.TEMPORAL_ENCRYPTION_KEY = KEY_B64;
  });
  afterEach(() => {
    process.env.TEMPORAL_ENCRYPTION_KEY = original;
  });

  it("wires the EncryptionCodec as the sole payload codec", () => {
    const converter = getDataConverter();
    expect(converter.payloadCodecs).toHaveLength(1);
    expect(converter.payloadCodecs![0]).toBeInstanceOf(EncryptionCodec);
  });
});
