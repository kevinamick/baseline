import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

import { sendCompletionEmail, sendFailureEmail } from "./emailer.js";

const completionOpts = {
  to: ["a@example.com"],
  runId: "run_1",
  rubricName: "My Rubric",
  overallScore: 0.876,
  rowCount: 4,
  appUrl: "https://app.test",
};

const failureOpts = {
  to: ["a@example.com"],
  runId: "run_1",
  rubricName: "My Rubric",
  errorMessage: "boom",
  appUrl: "https://app.test",
};

beforeEach(() => {
  mockSend.mockReset();
});

describe("sendCompletionEmail", () => {
  it("does not call Resend when there are no recipients", async () => {
    await sendCompletionEmail({ ...completionOpts, to: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends to all recipients with the rounded score in the subject", async () => {
    mockSend.mockResolvedValue({ data: { id: "e1" }, error: null });
    await sendCompletionEmail({ ...completionOpts, to: ["a@example.com", "b@example.com"] });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.to).toEqual(["a@example.com", "b@example.com"]);
    expect(arg.subject).toContain("88%");
  });

  it("throws when Resend returns an error so the caller can log it", async () => {
    const err = { name: "rate_limit_exceeded", message: "Too many requests" };
    mockSend.mockResolvedValue({ data: null, error: err });
    await expect(sendCompletionEmail(completionOpts)).rejects.toBe(err);
  });
});

describe("sendFailureEmail", () => {
  it("does not call Resend when there are no recipients", async () => {
    await sendFailureEmail({ ...failureOpts, to: [] });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends a failure notice to all recipients", async () => {
    mockSend.mockResolvedValue({ data: { id: "e1" }, error: null });
    await sendFailureEmail({ ...failureOpts, to: ["a@example.com", "b@example.com"] });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.to).toEqual(["a@example.com", "b@example.com"]);
    expect(arg.subject).toContain("failed");
  });

  it("throws when Resend returns an error so the caller can log it", async () => {
    const err = { name: "validation_error", message: "bad request" };
    mockSend.mockResolvedValue({ data: null, error: err });
    await expect(sendFailureEmail(failureOpts)).rejects.toBe(err);
  });
});
