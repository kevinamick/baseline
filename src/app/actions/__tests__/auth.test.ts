import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const {
  mockSignInWithPassword,
  mockSignUp,
  mockSignOut,
  mockResetPasswordForEmail,
  mockUpdateUser,
  mockSignInWithOAuth,
  mockRedirect,
  mockTrack,
  mockCheckLimit,
  mockTrustedClientIp,
  mockResolveOnboardingRedirect,
} = vi.hoisted(() => ({
  mockSignInWithPassword: vi.fn(),
  mockSignUp: vi.fn(),
  mockSignOut: vi.fn(),
  mockResetPasswordForEmail: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockSignInWithOAuth: vi.fn(),
  mockTrack: vi.fn(),
  // Default: under the limit. Individual tests flip a check to "limited".
  mockCheckLimit: vi.fn(async () => false),
  mockTrustedClientIp: vi.fn(async () => "203.0.113.7"),
  // Post-auth onboarding redirect (#355): default to "has org" so existing
  // tests that expect /dashboard still pass. Individual tests flip to /onboarding.
  mockResolveOnboardingRedirect: vi.fn(async () => "/dashboard"),
  // redirect() throws in Next so control never falls through; mirror that so a
  // test failure surfaces if an action keeps running after a redirect.
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
      signOut: mockSignOut,
      resetPasswordForEmail: mockResetPasswordForEmail,
      updateUser: mockUpdateUser,
      signInWithOAuth: mockSignInWithOAuth,
    },
  })),
}));
vi.mock("@/lib/auth/post-auth-redirect", () => ({
  resolveOnboardingRedirect: mockResolveOnboardingRedirect,
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("@/lib/rate-limit/guard", () => ({
  checkLimit: mockCheckLimit,
  rateLimitMessage: () => "Too many requests. Please try again later.",
}));
vi.mock("@/lib/rate-limit/client-ip", () => ({
  trustedClientIp: mockTrustedClientIp,
}));
// signUp stamps the request locale into user_metadata for the confirmation
// email (#247). Stub it to a fixed locale so the wiring is assertable.
vi.mock("@/lib/email/i18n", () => ({
  currentUserLocale: vi.fn(async () => "es"),
}));

// A genuinely new signup carries a non-empty `identities` array.
const NEW_USER = { id: "user-1", identities: [{ id: "i1" }] };

import {
  signIn,
  signUp,
  signOut,
  requestPasswordReset,
  resetPassword,
  signInWithOAuth,
} from "../auth";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish defaults so a per-test mockResolvedValueOnce queue can't leak.
  mockCheckLimit.mockReset().mockResolvedValue(false);
  mockTrustedClientIp.mockReset().mockResolvedValue("203.0.113.7");
  mockResolveOnboardingRedirect.mockReset().mockResolvedValue("/dashboard");
});

describe("signIn", () => {
  it("redirects to /dashboard on success", async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    await expect(
      signIn({}, fd({ email: "a@b.com", password: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "secret1",
    });
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("redirects to /onboarding when the user has no org (#355)", async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    mockResolveOnboardingRedirect.mockResolvedValue("/onboarding");
    await expect(
      signIn({}, fd({ email: "a@b.com", password: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/onboarding");
    expect(mockRedirect).toHaveBeenCalledWith("/onboarding");
  });

  it("returns the provider error without redirecting", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const result = await signIn({}, fd({ email: "a@b.com", password: "nope" }));
    expect(result).toEqual({ error: "Invalid login credentials" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("rejects a malformed email before any provider call", async () => {
    // zod validation runs before the limiter and the credential check.
    const result = await signIn({}, fd({ email: "nope", password: "secret1" }));
    expect(result.error).toMatch(/valid email/);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockCheckLimit).not.toHaveBeenCalled();
  });

  it("rejects an empty password before any provider call", async () => {
    const result = await signIn({}, fd({ email: "a@b.com", password: "" }));
    expect(result.error).toMatch(/Password is required/);
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
    expect(mockCheckLimit).not.toHaveBeenCalled();
  });

  it("does NOT enforce the signup min-length on sign-in (no lockout of older accounts)", async () => {
    // A pre-existing account may have a password shorter than the current policy;
    // sign-in must still reach the provider with it.
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    await expect(
      signIn({}, fd({ email: "a@b.com", password: "ab" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "ab",
    });
  });

  it("normalizes the email (trim + lowercase) before the credential check", async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    await expect(
      signIn({}, fd({ email: "  A@B.com ", password: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "secret1",
    });
  });

  it("dual-keys the limiter: per-IP then per-email, both before the credential check", async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    await expect(
      signIn({}, fd({ email: "a@b.com", password: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockCheckLimit).toHaveBeenNthCalledWith(1, "signIn", "ip", "203.0.113.7");
    expect(mockCheckLimit).toHaveBeenNthCalledWith(2, "signIn", "email", "a@b.com");
  });

  it("returns a generic 429 and skips the credential check when the per-IP limit is hit", async () => {
    mockCheckLimit.mockResolvedValueOnce(true); // first check = per-IP
    const result = await signIn({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ error: "Too many requests. Please try again later." });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it("limits a real and an unknown address identically (per-email check precedes existence)", async () => {
    // Email over limit → generic 429 without ever reaching signInWithPassword,
    // so the response can't differ by whether the account exists.
    mockCheckLimit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = await signIn({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ error: "Too many requests. Please try again later." });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });
});

describe("signUp", () => {
  it("reports emailSent when confirmation is required (no session yet)", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: null, user: NEW_USER },
      error: null,
    });
    const result = await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ emailSent: true });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("stamps the request locale into user_metadata for the confirmation email (#247)", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: null, user: NEW_USER },
      error: null,
    });
    await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(mockSignUp).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "secret1",
      options: { data: { locale: "es" } },
    });
  });

  it("redirects straight in when signUp returns a live session (confirmations off)", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: { access_token: "t" }, user: NEW_USER },
      error: null,
    });
    await expect(
      signUp({}, fd({ email: "a@b.com", password: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("returns the provider error", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: null },
      error: { message: "User already registered" },
    });
    const result = await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ error: "User already registered" });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("fires auth.user_signed_up for a genuinely new user", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: null, user: NEW_USER },
      error: null,
    });
    await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
    expect(mockTrack).toHaveBeenCalledWith(
      {
        name: "auth.user_signed_up",
        props: { user_id: "user-1", email_domain: "acme.com" },
      },
      { userId: "user-1" }
    );
  });

  it("does not fire the event for an already-registered email (empty identities)", async () => {
    // Supabase obfuscates an existing account: a user object with no identities
    // and no error. Firing here would invent a phantom signup.
    mockSignUp.mockResolvedValue({
      data: { session: null, user: { id: "existing", identities: [] } },
      error: null,
    });
    const result = await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ emailSent: true });
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("rate-limits per-IP with a generic 429, never reaching Supabase", async () => {
    mockCheckLimit.mockResolvedValueOnce(true);
    const result = await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ error: "Too many requests. Please try again later." });
    expect(mockCheckLimit).toHaveBeenCalledWith("signUp", "ip", "203.0.113.7");
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("rejects a malformed email before any provider call", async () => {
    const result = await signUp({}, fd({ email: "nope", password: "secret1" }));
    expect(result.error).toMatch(/valid email/);
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockCheckLimit).not.toHaveBeenCalled();
  });

  it("rejects a too-short password (full policy) before any provider call", async () => {
    const result = await signUp({}, fd({ email: "a@b.com", password: "ab" }));
    expect(result.error).toMatch(/at least/);
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(mockCheckLimit).not.toHaveBeenCalled();
  });

  it("normalizes the email (trim + lowercase) before the provider call", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: null, user: NEW_USER },
      error: null,
    });
    await signUp({}, fd({ email: "  A@B.com ", password: "secret1" }));
    expect(mockSignUp).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "secret1",
      options: { data: { locale: "es" } },
    });
  });
});

describe("signOut", () => {
  it("signs out and redirects home", async () => {
    mockSignOut.mockResolvedValue({ error: null });
    await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/");
    expect(mockSignOut).toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });
});

describe("requestPasswordReset", () => {
  it("sends a recovery email and reports emailSent for a valid address", async () => {
    mockResetPasswordForEmail.mockResolvedValue({ error: null });
    const result = await requestPasswordReset({}, fd({ email: "A@B.com" }));
    expect(result).toEqual({ emailSent: true });
    // EmailSchema normalizes (trim + lowercase) before we hand it to Supabase.
    expect(mockResetPasswordForEmail).toHaveBeenCalledWith("a@b.com");
  });

  it("reports emailSent without leaking whether the account exists", async () => {
    // Supabase reports nothing for unknown addresses; we still show success so
    // the response can't enumerate registered emails.
    mockResetPasswordForEmail.mockResolvedValue({ error: null });
    const result = await requestPasswordReset({}, fd({ email: "ghost@b.com" }));
    expect(result).toEqual({ emailSent: true });
  });

  it("rejects an invalid email without calling Supabase", async () => {
    const result = await requestPasswordReset({}, fd({ email: "nope" }));
    expect(result.error).toBeTruthy();
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
    // Validation precedes the limiter — no point spending a counter on garbage.
    expect(mockCheckLimit).not.toHaveBeenCalled();
  });

  it("dual-keys the limiter: per-IP then per-email, both before the send", async () => {
    mockResetPasswordForEmail.mockResolvedValue({ error: null });
    await requestPasswordReset({}, fd({ email: "a@b.com" }));
    expect(mockCheckLimit).toHaveBeenNthCalledWith(
      1,
      "requestPasswordReset",
      "ip",
      "203.0.113.7"
    );
    expect(mockCheckLimit).toHaveBeenNthCalledWith(
      2,
      "requestPasswordReset",
      "email",
      "a@b.com"
    );
  });

  it("returns a visible generic error and sends nothing when the per-IP limit is hit", async () => {
    // First check is the per-IP one; make it limited.
    mockCheckLimit.mockResolvedValueOnce(true);
    const result = await requestPasswordReset({}, fd({ email: "a@b.com" }));
    expect(result).toEqual({ error: "Too many requests. Please try again later." });
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("silently drops (normal success, no send) when the per-email limit is hit", async () => {
    // IP allowed, email limited → identical success to a real send.
    mockCheckLimit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const result = await requestPasswordReset({}, fd({ email: "a@b.com" }));
    expect(result).toEqual({ emailSent: true });
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("limits a real and a non-existent address identically (email check precedes existence)", async () => {
    // The email counter is consulted before Supabase's existence-aware call, so
    // an over-limit response is the same generic success regardless of whether
    // the address is registered. Supabase is never reached either way.
    mockCheckLimit.mockResolvedValue(false);
    mockCheckLimit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const real = await requestPasswordReset({}, fd({ email: "real@b.com" }));
    mockCheckLimit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ghost = await requestPasswordReset({}, fd({ email: "ghost@b.com" }));
    expect(real).toEqual(ghost);
    expect(real).toEqual({ emailSent: true });
    expect(mockResetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("resetPassword", () => {
  it("updates the password and redirects into the app", async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    await expect(
      resetPassword({}, fd({ password: "secret1", confirmPassword: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: "secret1" });
  });

  it("rejects a too-short password without calling Supabase", async () => {
    const result = await resetPassword(
      {},
      fd({ password: "ab", confirmPassword: "ab" })
    );
    expect(result.error).toMatch(/at least/);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords without calling Supabase", async () => {
    const result = await resetPassword(
      {},
      fd({ password: "secret1", confirmPassword: "secret2" })
    );
    expect(result).toEqual({ error: "Passwords don't match." });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("returns the provider error without redirecting", async () => {
    mockUpdateUser.mockResolvedValue({
      error: { message: "Auth session missing" },
    });
    const result = await resetPassword(
      {},
      fd({ password: "secret1", confirmPassword: "secret1" })
    );
    expect(result).toEqual({ error: "Auth session missing" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

describe("signInWithOAuth", () => {
  it("redirects to the provider's authorize URL with a callback redirectTo", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" },
      error: null,
    });
    await expect(
      signInWithOAuth(fd({ provider: "google", next: "/rubrics" }))
    ).rejects.toThrow("NEXT_REDIRECT:https://accounts.google.com");
    expect(mockSignInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo:
          "http://localhost:3000/auth/callback?next=" +
          encodeURIComponent("/rubrics"),
      },
    });
  });

  it("rejects an unsupported provider before touching Supabase", async () => {
    await expect(
      signInWithOAuth(fd({ provider: "myspace" }))
    ).rejects.toThrow("NEXT_REDIRECT:/sign-in?error=oauth");
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it("redirects to an error when the provider returns no URL", async () => {
    mockSignInWithOAuth.mockResolvedValue({ data: { url: null }, error: null });
    await expect(
      signInWithOAuth(fd({ provider: "github" }))
    ).rejects.toThrow("NEXT_REDIRECT:/sign-in?error=oauth");
  });
});
