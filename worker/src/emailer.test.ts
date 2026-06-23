import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSend, mockSendMail, mockCreateTransport } = vi.hoisted(() => {
  const mockSendMail = vi.fn();
  return {
    mockSend: vi.fn(),
    mockSendMail,
    mockCreateTransport: vi.fn((_opts?: Record<string, unknown>) => ({ sendMail: mockSendMail })),
  };
});

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
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
  mockSendMail.mockReset();
  mockCreateTransport.mockClear();
  // Default these tests to the Resend path; the Mailpit suite opts in explicitly.
  delete process.env.MAILPIT_SMTP_HOST;
  delete process.env.MAILPIT_SMTP_PORT;
});

afterEach(() => {
  delete process.env.MAILPIT_SMTP_HOST;
  delete process.env.MAILPIT_SMTP_PORT;
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

describe("dev Mailpit transport (MAILPIT_SMTP_HOST set)", () => {
  beforeEach(() => {
    process.env.MAILPIT_SMTP_HOST = "127.0.0.1";
    mockSendMail.mockResolvedValue({ messageId: "m1" });
  });

  it("routes through SMTP to Mailpit and never calls Resend", async () => {
    await sendCompletionEmail(completionOpts);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockCreateTransport.mock.calls[0][0]).toMatchObject({
      host: "127.0.0.1",
      port: 54325,
      secure: false,
    });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const mail = mockSendMail.mock.calls[0][0];
    expect(mail.to).toEqual(["a@example.com"]);
    expect(mail.subject).toContain("88%");
  });

  it("honors a custom MAILPIT_SMTP_PORT", async () => {
    process.env.MAILPIT_SMTP_PORT = "2525";
    await sendFailureEmail(failureOpts);
    expect(mockCreateTransport.mock.calls[0][0]).toMatchObject({ port: 2525 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("is a no-op with no recipients (no SMTP connection opened)", async () => {
    await sendCompletionEmail({ ...completionOpts, to: [] });
    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
