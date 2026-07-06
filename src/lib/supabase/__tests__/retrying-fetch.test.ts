import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import { createRetryingFetch } from "../retrying-fetch";

beforeEach(() => vi.clearAllMocks());

function response(status: number): Response {
  return new Response(null, { status });
}

describe("createRetryingFetch", () => {
  describe("GET", () => {
    it("retries once on a 502 and succeeds", async () => {
      const baseFetch = vi
        .fn()
        .mockResolvedValueOnce(response(502))
        .mockResolvedValueOnce(response(200));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it("retries once on a 503 and succeeds", async () => {
      const baseFetch = vi
        .fn()
        .mockResolvedValueOnce(response(503))
        .mockResolvedValueOnce(response(200));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it("retries once on a 504 and succeeds", async () => {
      const baseFetch = vi
        .fn()
        .mockResolvedValueOnce(response(504))
        .mockResolvedValueOnce(response(200));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it("retries once on a network-level rejection and succeeds", async () => {
      const baseFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(response(200));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it("propagates the original response unchanged when the retry also fails", async () => {
      const baseFetch = vi
        .fn()
        .mockResolvedValueOnce(response(503))
        .mockResolvedValueOnce(response(503));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(503);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it("propagates the original error unchanged when the retry also rejects", async () => {
      const boom = new TypeError("fetch failed again");
      const baseFetch = vi.fn().mockRejectedValue(boom);
      const fetch = createRetryingFetch(baseFetch);

      await expect(fetch("https://example.test/rest/v1/rubrics")).rejects.toBe(boom);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry a 429 (rate limiter)", async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(429));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(429);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry a 500", async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(500));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(500);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it("does not retry a plain 200", async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(200));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics");

      expect(res.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it("emits a structured warn on retry with method, attempt, and status", async () => {
      const baseFetch = vi
        .fn()
        .mockResolvedValueOnce(response(502))
        .mockResolvedValueOnce(response(200));
      const fetch = createRetryingFetch(baseFetch);

      await fetch("https://example.test/rest/v1/rubrics");

      expect(mockWarn).toHaveBeenCalledTimes(1);
      const [message, attrs] = mockWarn.mock.calls[0];
      expect(message).toEqual(expect.any(String));
      expect(attrs).toMatchObject({ method: "GET", attempt: 1, status: 502 });
      // No PII/secret material: only method/attempt/status/error_class.
      expect(Object.keys(attrs)).toEqual(
        expect.arrayContaining(["method", "attempt", "status"])
      );
      const serialized = JSON.stringify(attrs);
      expect(serialized).not.toContain("example.test");
      expect(serialized).not.toContain("rubrics");
    });

    it("emits a structured warn on retry with error_class for a network rejection", async () => {
      const baseFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(response(200));
      const fetch = createRetryingFetch(baseFetch);

      await fetch("https://example.test/rest/v1/rubrics");

      expect(mockWarn).toHaveBeenCalledTimes(1);
      const [, attrs] = mockWarn.mock.calls[0];
      expect(attrs).toMatchObject({ method: "GET", attempt: 1, error_class: "TypeError" });
    });
  });

  describe("HEAD", () => {
    it("is treated like GET: retried once on a 503 and succeeds", async () => {
      const baseFetch = vi
        .fn()
        .mockResolvedValueOnce(response(503))
        .mockResolvedValueOnce(response(200));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics", { method: "HEAD" });

      expect(res.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry a HEAD 429", async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(429));
      const fetch = createRetryingFetch(baseFetch);

      const res = await fetch("https://example.test/rest/v1/rubrics", { method: "HEAD" });

      expect(res.status).toBe(429);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("writes", () => {
    it.each(["POST", "PATCH", "DELETE", "PUT"])(
      "never retries a %s, even on a transient 503",
      async (method) => {
        const baseFetch = vi.fn().mockResolvedValue(response(503));
        const fetch = createRetryingFetch(baseFetch);

        const res = await fetch("https://example.test/rest/v1/rubrics", { method });

        expect(res.status).toBe(503);
        expect(baseFetch).toHaveBeenCalledTimes(1);
        expect(mockWarn).not.toHaveBeenCalled();
      }
    );

    it("never retries a POST, even on a network rejection", async () => {
      const boom = new TypeError("fetch failed");
      const baseFetch = vi.fn().mockRejectedValue(boom);
      const fetch = createRetryingFetch(baseFetch);

      await expect(
        fetch("https://example.test/rest/v1/rpc/reserve_eval_points", { method: "POST" })
      ).rejects.toBe(boom);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it("passes a POST through with no wrapping (identical args, single call)", async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(200));
      const fetch = createRetryingFetch(baseFetch);
      const init = { method: "POST", body: JSON.stringify({ a: 1 }) };

      await fetch("https://example.test/auth/v1/token", init);

      expect(baseFetch).toHaveBeenCalledWith("https://example.test/auth/v1/token", init);
    });
  });
});
