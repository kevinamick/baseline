import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreateTransport, mockSmtpSend, mockResendSend } = vi.hoisted(() => ({
  mockCreateTransport: vi.fn(),
  mockSmtpSend: vi.fn(),
  mockResendSend: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
}));
// Constructor dep — mock with a class (an arrow vi.fn() isn't `new`-able).
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockResendSend };
  },
}));

import { sendEmail } from "../send";

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTransport.mockReturnValue({ sendMail: mockSmtpSend });
  mockSmtpSend.mockResolvedValue(undefined);
  mockResendSend.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const msg = { to: "to@x.com", subject: "Hi", html: "<p>hi</p>" };

describe("sendEmail", () => {
  it("delivers via SMTP (Mailpit) when NODE_ENV is not production", async () => {
    // The test env's NODE_ENV is "test" — i.e. non-production.
    await sendEmail(msg);

    expect(mockCreateTransport).toHaveBeenCalledOnce();
    expect(mockSmtpSend).toHaveBeenCalledOnce();
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it("delivers via Resend when NODE_ENV is production (any deployed instance)", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await sendEmail(msg);

    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "to@x.com", subject: "Hi" })
    );
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it("throws when Resend returns an error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockResendSend.mockResolvedValue({ error: { message: "rejected" } });

    await expect(sendEmail(msg)).rejects.toBeTruthy();
  });
});
