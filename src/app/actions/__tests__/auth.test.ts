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
} = vi.hoisted(() => ({
  mockSignInWithPassword: vi.fn(),
  mockSignUp: vi.fn(),
  mockSignOut: vi.fn(),
  mockResetPasswordForEmail: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockSignInWithOAuth: vi.fn(),
  mockTrack: vi.fn(),
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
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));

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
});

describe("signIn", () => {
  it("redirects to /dashboard on success", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });
    await expect(
      signIn({}, fd({ email: "a@b.com", password: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "secret1",
    });
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("returns the provider error without redirecting", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const result = await signIn({}, fd({ email: "a@b.com", password: "nope" }));
    expect(result).toEqual({ error: "Invalid login credentials" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("validates that email and password are present", async () => {
    const result = await signIn({}, fd({ email: "", password: "" }));
    expect(result).toEqual({ error: "Email and password are required." });
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
  });
});

describe("resetPassword", () => {
  it("updates the password and redirects into the app", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
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
