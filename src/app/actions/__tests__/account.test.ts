import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const {
  mockUpdateUser,
  mockReauthenticate,
  mockRevalidatePath,
  mockGetAuthContext,
  mockCheckLimit,
} = vi.hoisted(() => ({
  mockUpdateUser: vi.fn(),
  mockReauthenticate: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockGetAuthContext: vi.fn(),
  mockCheckLimit: vi.fn(async () => false),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      updateUser: mockUpdateUser,
      reauthenticate: mockReauthenticate,
    },
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/rate-limit/guard", () => ({
  checkLimit: mockCheckLimit,
  rateLimitMessage: () => "Too many requests. Please try again later.",
}));
// changeEmail / changePassword refresh user_metadata.locale so the
// GoTrue-rendered emails localize (#247). Stub to a fixed locale.
vi.mock("@/lib/email/i18n", () => ({
  currentUserLocale: vi.fn(async () => "es"),
}));

import { updateProfile, changeEmail, changePassword } from "../account";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    userId: "user-1",
    email: "user@acme.com",
    orgId: "org-1",
    role: "admin",
    canWrite: true,
  });
  mockCheckLimit.mockReset().mockResolvedValue(false);
});

describe("updateProfile", () => {
  it("saves the trimmed display name onto user metadata and revalidates", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await updateProfile({}, fd({ name: "  Ada Lovelace  " }));
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { name: "Ada Lovelace" } });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings/account");
    expect(result).toEqual({ saved: true });
  });

  it("allows clearing the name to empty", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await updateProfile({}, fd({ name: "   " }));
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { name: "" } });
    expect(result).toEqual({ saved: true });
  });

  it("returns the provider error without revalidating", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "nope" } });
    const result = await updateProfile({}, fd({ name: "Ada" }));
    expect(result).toEqual({ error: "nope" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("changeEmail", () => {
  it("requests the email change and reports emailSent", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await changeEmail({}, fd({ email: "  new@b.com " }));
    expect(mockUpdateUser).toHaveBeenCalledWith({
      email: "new@b.com",
      data: { locale: "es" },
    });
    expect(result).toEqual({ emailSent: true });
  });

  it("normalizes the email to lowercase before requesting the change", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    await changeEmail({}, fd({ email: "  New@B.com " }));
    expect(mockUpdateUser).toHaveBeenCalledWith({
      email: "new@b.com",
      data: { locale: "es" },
    });
  });

  it("rejects an empty email without calling the provider", async () => {
    const result = await changeEmail({}, fd({ email: "  " }));
    expect(result).toEqual({ error: "Enter a valid email address" });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects a malformed email without calling the provider", async () => {
    const result = await changeEmail({}, fd({ email: "notanemail" }));
    expect(result).toEqual({ error: "Enter a valid email address" });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("returns the provider error", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "already in use" } });
    const result = await changeEmail({}, fd({ email: "new@b.com" }));
    expect(result).toEqual({ error: "already in use" });
  });

  it("rate-limits per user with a generic 429, before calling the provider", async () => {
    mockCheckLimit.mockResolvedValueOnce(true);
    const result = await changeEmail({}, fd({ email: "new@b.com" }));
    expect(result).toEqual({ error: "Too many requests. Please try again later." });
    expect(mockCheckLimit).toHaveBeenCalledWith("changeEmail", "user", "user-1");
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("spends no counter when the email is invalid (validation precedes the limiter)", async () => {
    const result = await changeEmail({}, fd({ email: "notanemail" }));
    expect(result.error).toBeTruthy();
    expect(mockCheckLimit).not.toHaveBeenCalled();
  });

  it("skips the limiter but still calls the provider when there is no session user", async () => {
    // No userId to key on — the limiter is bypassed (it's defense-in-depth) and
    // updateUser runs, which rejects the missing session on its own.
    mockGetAuthContext.mockResolvedValueOnce({ userId: null });
    mockUpdateUser.mockResolvedValue({ error: { message: "Auth session missing" } });
    const result = await changeEmail({}, fd({ email: "new@b.com" }));
    expect(mockCheckLimit).not.toHaveBeenCalled();
    expect(mockUpdateUser).toHaveBeenCalledWith({
      email: "new@b.com",
      data: { locale: "es" },
    });
    expect(result).toEqual({ error: "Auth session missing" });
  });
});

describe("changePassword", () => {
  it("emails a reauthentication code on the send-code step without changing the password", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    mockReauthenticate.mockResolvedValue({ error: null });
    const result = await changePassword(
      {},
      fd({ intent: "send-code", password: "secret1", confirmPassword: "secret1" })
    );
    expect(mockReauthenticate).toHaveBeenCalledTimes(1);
    // The only updateUser on send-code refreshes the locale for the email (#247),
    // never the password (which lands on the submit step).
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { locale: "es" } });
    expect(mockUpdateUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ password: expect.anything() })
    );
    expect(result).toEqual({ codeSent: true });
  });

  it("surfaces a reauthenticate error from the send-code step", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    mockReauthenticate.mockResolvedValue({ error: { message: "rate limited" } });
    const result = await changePassword({}, fd({ intent: "send-code" }));
    expect(result).toEqual({ error: "rate limited" });
    expect(mockUpdateUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ password: expect.anything() })
    );
  });

  it("sets the new password with the code as the nonce on submit", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await changePassword(
      {},
      fd({
        intent: "submit",
        password: "secret1",
        confirmPassword: "secret1",
        code: " 123456 ",
      })
    );
    expect(mockUpdateUser).toHaveBeenCalledWith({
      password: "secret1",
      nonce: "123456",
    });
    expect(mockReauthenticate).not.toHaveBeenCalled();
    expect(result).toEqual({ saved: true });
  });

  it("requires the confirmation code before calling the provider, keeping codeSent", async () => {
    const result = await changePassword(
      {},
      fd({ intent: "submit", password: "secret1", confirmPassword: "secret1" })
    );
    expect(result).toEqual({
      codeSent: true,
      error: "Enter the confirmation code we emailed you.",
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects passwords shorter than 6 characters before calling the provider", async () => {
    const result = await changePassword(
      {},
      fd({ intent: "submit", password: "abc", confirmPassword: "abc", code: "123456" })
    );
    expect(result).toEqual({
      codeSent: true,
      error: "Password must be at least 6 characters.",
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirmation before calling the provider", async () => {
    const result = await changePassword(
      {},
      fd({ intent: "submit", password: "secret1", confirmPassword: "secret2", code: "123456" })
    );
    expect(result).toEqual({ codeSent: true, error: "Passwords don't match." });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("returns the provider error, keeping codeSent so the code field stays", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "Invalid nonce" } });
    const result = await changePassword(
      {},
      fd({
        intent: "submit",
        password: "secret1",
        confirmPassword: "secret1",
        code: "000000",
      })
    );
    expect(result).toEqual({ codeSent: true, error: "Invalid nonce" });
  });
});
