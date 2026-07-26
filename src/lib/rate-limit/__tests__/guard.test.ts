import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const { mockRpc, mockCapture, mockLog } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockCapture: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mockRpc } }));
vi.mock("@/lib/analytics/server", () => ({ captureException: mockCapture }));
vi.mock("@/lib/logging/server", () => ({ log: mockLog }));

import { checkLimit, rateLimitMessage } from "../guard";
import { hashKey } from "../keys";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RATE_LIMIT_ENABLED;
});

afterEach(() => {
  delete process.env.RATE_LIMIT_ENABLED;
});

describe("checkLimit — enable flag", () => {
  it("does not call the limiter and never limits when RATE_LIMIT_ENABLED=false", async () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    const limited = await checkLimit("requestPasswordReset", "email", "a@b.com");
    expect(limited).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("enforces by default when the var is unset (not NODE_ENV-keyed)", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await checkLimit("requestPasswordReset", "email", "a@b.com");
    expect(mockRpc).toHaveBeenCalledOnce();
  });
});

describe("checkLimit — limit decision", () => {
  it("allows while the post-increment count is within the limit", async () => {
    mockRpc.mockResolvedValue({ data: 3, error: null }); // reset email limit is 3
    expect(await checkLimit("requestPasswordReset", "email", "a@b.com")).toBe(false);
  });

  it("limits once the count exceeds the limit", async () => {
    mockRpc.mockResolvedValue({ data: 4, error: null });
    expect(await checkLimit("requestPasswordReset", "email", "a@b.com")).toBe(true);
  });

  it("hashes the value — the raw email never reaches the RPC", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await checkLimit("requestPasswordReset", "email", "Person@Example.com");
    const args = mockRpc.mock.calls[0][1];
    expect(args.p_hashed_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain("Person@Example.com");
    expect(JSON.stringify(args)).not.toContain("person@example.com");
  });

  it("calls the increment_rate_limit RPC with the full parameter set", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await checkLimit("signIn", "email", "a@b.com");
    expect(mockRpc).toHaveBeenCalledWith("increment_rate_limit", {
      p_hashed_key: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_window_start: expect.any(String),
      p_surface: "signIn",
      p_keytype: "email",
    });
  });

  it("normalizes an email before hashing so case/space variants share a counter", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await checkLimit("signIn", "email", "  A@B.CoM ");
    expect(mockRpc.mock.calls[0][1].p_hashed_key).toBe(
      hashKey("signIn", "email", "a@b.com")
    );
  });

  it("hashes a non-email value verbatim (no email normalization)", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    // An IPv6 key keeps its exact form; email-normalizing it would lowercase.
    await checkLimit("signIn", "ip", "2001:DB8::A");
    expect(mockRpc.mock.calls[0][1].p_hashed_key).toBe(
      hashKey("signIn", "ip", "2001:DB8::A")
    );
  });
});

describe("checkLimit — telemetry", () => {
  it("emits a PII-free decision with surface/keytype/outcome and the hashed key only", async () => {
    mockRpc.mockResolvedValue({ data: 1, error: null });
    await checkLimit("requestPasswordReset", "email", "person@example.com");
    expect(mockLog.info).toHaveBeenCalledWith("rate_limit.decision", {
      surface: "requestPasswordReset",
      keytype: "email",
      outcome: "allowed",
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const [, props] = mockLog.info.mock.calls[0];
    expect(JSON.stringify(props)).not.toContain("person@example.com");
  });

  it('records outcome "limited" when the count is over the limit', async () => {
    mockRpc.mockResolvedValue({ data: 6, error: null }); // signIn email limit is 5
    await checkLimit("signIn", "email", "person@example.com");
    expect(mockLog.info).toHaveBeenCalledWith("rate_limit.decision", {
      surface: "signIn",
      keytype: "email",
      outcome: "limited",
      key: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("checkLimit — fail open", () => {
  it("allows and reports to error tracking when the RPC errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await checkLimit("requestPasswordReset", "ip", "203.0.113.7")).toBe(false);
    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it("allows and reports to error tracking when the RPC rejects", async () => {
    mockRpc.mockRejectedValue(new Error("network down"));
    expect(await checkLimit("requestPasswordReset", "ip", "203.0.113.7")).toBe(false);
    expect(mockCapture).toHaveBeenCalledOnce();
  });

  it("reports the RPC's own error with full context (immediately, not via the timeout)", async () => {
    mockRpc.mockRejectedValue(new Error("network down"));
    await checkLimit("requestPasswordReset", "ip", "203.0.113.7");
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "network down" }),
      "rate-limiter",
      {
        rate_limit_surface: "requestPasswordReset",
        rate_limit_keytype: "ip",
      }
    );
    expect(mockLog.error).toHaveBeenCalledWith("rate_limit.fail_open", {
      surface: "requestPasswordReset",
      keytype: "ip",
      error: "network down",
    });
  });

  it("times out a hung limiter after 1s and fails open with a timeout error", async () => {
    vi.useFakeTimers();
    try {
      mockRpc.mockReturnValue(new Promise(() => {})); // limiter never answers
      const pending = checkLimit("signIn", "ip", "203.0.113.7");
      await vi.advanceTimersByTimeAsync(1001);
      expect(await pending).toBe(false);
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({ message: "rate limiter timed out" }),
        "rate-limiter",
        expect.objectContaining({ rate_limit_surface: "signIn" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open (no throw) on an unknown surface/keytype rule", async () => {
    // signUp has no email rule.
    expect(await checkLimit("signUp", "email", "a@b.com")).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith("rate_limit.no_rule", {
      surface: "signUp",
      keytype: "email",
    });
  });

  it("fails open (no throw) on a surface missing from the table entirely", async () => {
    // A wiring bug (unknown surface) must warn and allow, never crash the action.
    await expect(
      checkLimit("notASurface" as never, "ip", "203.0.113.7")
    ).resolves.toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith("rate_limit.no_rule", {
      surface: "notASurface",
      keytype: "ip",
    });
  });
});

describe("rateLimitMessage", () => {
  it("is a generic, non-enumerating message", () => {
    expect(rateLimitMessage()).toMatch(/too many/i);
  });
});
