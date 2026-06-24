import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

import {
  sendOptimizationCompletionEmail,
  sendOptimizationFailureEmail,
  sendOptimizationPausedEmail,
  OPTIMIZATION_EMAIL_KINDS,
} from "./optimization-emailer.js";

const completionPayload = {
  runId: "run_1",
  connectionName: "Support Agent",
  seedScore: 0.62,
  bestScore: 0.81,
  rolloutsUsed: 40,
  instanceCount: 8,
  appUrl: "https://app.test",
};

const failurePayload = {
  runId: "run_1",
  connectionName: "Support Agent",
  errorMessage: "endpoint unreachable",
  appUrl: "https://app.test",
};

const pausedPayload = {
  runId: "run_1",
  connectionName: "Support Agent",
  reason: "Your agent endpoint stopped responding",
  appUrl: "https://app.test",
};

beforeEach(() => {
  mockSend.mockReset();
  delete process.env.MAILPIT_SMTP_HOST;
  delete process.env.MAILPIT_SMTP_PORT;
});

afterEach(() => {
  delete process.env.MAILPIT_SMTP_HOST;
  delete process.env.MAILPIT_SMTP_PORT;
});

describe("OPTIMIZATION_EMAIL_KINDS", () => {
  it("single-sources the three kinds: both terminal transitions plus paused (#102)", () => {
    expect(OPTIMIZATION_EMAIL_KINDS).toEqual(["completed", "failed", "paused"]);
  });
});

describe("sendOptimizationCompletionEmail", () => {
  it("does not call Resend when the recipient is unresolved", async () => {
    await sendOptimizationCompletionEmail(null, completionPayload);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the starter the connection, score lift, rollouts, instances, and deep link", async () => {
    mockSend.mockResolvedValue({ data: { id: "e1" }, error: null });
    await sendOptimizationCompletionEmail("starter@example.com", completionPayload);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.to).toEqual(["starter@example.com"]);
    // Subject conveys the win: "Support Agent (0.62 → 0.81)".
    expect(arg.subject).toBe("Optimization complete — Support Agent (0.62 → 0.81)");
    expect(arg.html).toContain("Support Agent");
    expect(arg.html).toContain("0.62 → 0.81");
    expect(arg.html).toContain("Rollouts spent:</strong> 40");
    expect(arg.html).toContain("Instances:</strong> 8");
    expect(arg.html).toContain("https://app.test/optimizations?run=run_1");
  });

  it("throws when Resend returns an error so the caller can log it", async () => {
    const err = { name: "rate_limit_exceeded", message: "Too many requests" };
    mockSend.mockResolvedValue({ data: null, error: err });
    await expect(
      sendOptimizationCompletionEmail("starter@example.com", completionPayload)
    ).rejects.toBe(err);
  });

  it("escapes a connection name with HTML-significant characters", async () => {
    mockSend.mockResolvedValue({ data: { id: "e1" }, error: null });
    await sendOptimizationCompletionEmail("starter@example.com", {
      ...completionPayload,
      connectionName: "<script>",
    });
    const arg = mockSend.mock.calls[0][0];
    expect(arg.html).toContain("&lt;script&gt;");
    expect(arg.html).not.toContain("<script>");
  });
});

describe("sendOptimizationFailureEmail", () => {
  it("does not call Resend when the recipient is unresolved", async () => {
    await sendOptimizationFailureEmail(null, failurePayload);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the starter the failure reason and the deep link", async () => {
    mockSend.mockResolvedValue({ data: { id: "e1" }, error: null });
    await sendOptimizationFailureEmail("starter@example.com", failurePayload);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.to).toEqual(["starter@example.com"]);
    expect(arg.subject).toBe("Optimization failed — Support Agent");
    expect(arg.html).toContain("endpoint unreachable");
    expect(arg.html).toContain("https://app.test/optimizations?run=run_1");
  });

  it("throws when Resend returns an error so the caller can log it", async () => {
    const err = { name: "validation_error", message: "bad request" };
    mockSend.mockResolvedValue({ data: null, error: err });
    await expect(
      sendOptimizationFailureEmail("starter@example.com", failurePayload)
    ).rejects.toBe(err);
  });
});

describe("sendOptimizationPausedEmail", () => {
  it("does not call Resend when the recipient is unresolved", async () => {
    await sendOptimizationPausedEmail(null, pausedPayload);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the reason, the auto-retry + Retry now guidance, and the deep link", async () => {
    mockSend.mockResolvedValue({ data: { id: "e1" }, error: null });
    await sendOptimizationPausedEmail("starter@example.com", pausedPayload);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.to).toEqual(["starter@example.com"]);
    expect(arg.subject).toBe("Optimization paused — Support Agent");
    expect(arg.html).toContain("Your agent endpoint stopped responding");
    expect(arg.html).toContain("no progress has been lost");
    expect(arg.html).toContain("Retry now");
    expect(arg.html).toContain("https://app.test/optimizations?run=run_1");
  });

  it("throws when Resend returns an error so the caller can log it", async () => {
    const err = { name: "rate_limit_exceeded", message: "Too many requests" };
    mockSend.mockResolvedValue({ data: null, error: err });
    await expect(
      sendOptimizationPausedEmail("starter@example.com", pausedPayload)
    ).rejects.toBe(err);
  });
});
