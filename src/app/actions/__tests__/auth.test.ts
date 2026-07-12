import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccessCodeClaim } from "@/lib/access-codes/redeem";

// The signup-pass mock below loads the real module (importOriginal) for its
// rejection matcher; stub its "server-only" guard first.
vi.mock("server-only", () => ({}));

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
  mockLogWarn,
  mockCheckLimit,
  mockTrustedClientIp,
  mockResolveOnboardingRedirect,
  mockIsSignupGated,
  mockHasPendingInvitation,
  mockClaimAccessCode,
  mockReleaseAccessCodeClaim,
  mockRecordAccessCodeRedemption,
  mockMintSignupPass,
} = vi.hoisted(() => ({
  mockSignInWithPassword: vi.fn(),
  mockSignUp: vi.fn(),
  mockSignOut: vi.fn(),
  mockResetPasswordForEmail: vi.fn(),
  mockUpdateUser: vi.fn(),
  mockSignInWithOAuth: vi.fn(),
  mockTrack: vi.fn(),
  mockLogWarn: vi.fn(),
  // Default: under the limit. Individual tests flip a check to "limited".
  mockCheckLimit: vi.fn(async () => false),
  mockTrustedClientIp: vi.fn(async () => "203.0.113.7"),
  // Post-auth onboarding redirect (#355): default to "has org" so existing
  // tests that expect /dashboard still pass. Individual tests flip to /onboarding.
  mockResolveOnboardingRedirect: vi.fn(async () => "/dashboard"),
  // Access Code gate (ADR-0017, #425): default ungated so every pre-existing
  // signUp test keeps behaving exactly as before. Individual tests flip it on.
  mockIsSignupGated: vi.fn(async () => false),
  mockHasPendingInvitation: vi.fn(async () => false),
  // Access Code claim (ADR-0017, #426): default a successful claim so tests
  // that don't care about the code path keep behaving as before.
  mockClaimAccessCode: vi.fn(async (): Promise<AccessCodeClaim> => ({
    claimed: true,
    status: "claimed",
    accessCodeId: "code-1",
    trialDays: null,
    stripeCouponId: null,
    planSlug: null,
  })),
  mockReleaseAccessCodeClaim: vi.fn(async () => undefined),
  mockRecordAccessCodeRedemption: vi.fn(async () => undefined),
  // Signup pass (#487): default a successful mint so every pre-existing
  // signUp test keeps behaving exactly as before. Individual tests flip it.
  mockMintSignupPass: vi.fn(async () => true),
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
// after() runs post-response in prod; invoke the callback inline in tests so the
// deferred warn log fires and its assertions hold.
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: mockLogWarn, error: vi.fn() },
}));
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
vi.mock("@/lib/analytics/signup-gate", () => ({
  isSignupGated: mockIsSignupGated,
}));
vi.mock("@/lib/invitations/pending", () => ({
  hasPendingInvitation: mockHasPendingInvitation,
}));
vi.mock("@/lib/access-codes/redeem", () => ({
  claimAccessCode: mockClaimAccessCode,
  releaseAccessCodeClaim: mockReleaseAccessCodeClaim,
  recordAccessCodeRedemption: mockRecordAccessCodeRedemption,
}));
// Mock only the mint (it talks to the DB); keep the REAL rejection matcher so
// these tests hold the action to the exact 403+message shape the SQL hook
// produces (src/lib/signup-passes/mint.ts documents the byte-parity contract).
vi.mock("@/lib/signup-passes/mint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/signup-passes/mint")>()),
  mintSignupPass: mockMintSignupPass,
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
  mockIsSignupGated.mockReset().mockResolvedValue(false);
  mockHasPendingInvitation.mockReset().mockResolvedValue(false);
  mockClaimAccessCode.mockReset().mockResolvedValue({
    claimed: true,
    status: "claimed",
    accessCodeId: "code-1",
    trialDays: null,
    stripeCouponId: null,
    planSlug: null,
  });
  mockReleaseAccessCodeClaim.mockReset().mockResolvedValue(undefined);
  mockRecordAccessCodeRedemption.mockReset().mockResolvedValue(undefined);
  mockMintSignupPass.mockReset().mockResolvedValue(true);
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
    const result = await signIn({}, fd({ email: "a@acme.com", password: "nope" }));
    expect(result).toEqual({ error: "Invalid login credentials" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("logs auth.sign_in_failed with the domain only (never the full email)", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    await signIn({}, fd({ email: "user@acme.com", password: "nope" }));
    expect(mockLogWarn).toHaveBeenCalledWith("Sign-in failed", {
      event: "auth.sign_in_failed",
      email_domain: "acme.com",
      error: { message: "Invalid login credentials" },
    });
  });

  it("does not log on a successful sign-in", async () => {
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    await expect(
      signIn({}, fd({ email: "a@b.com", password: "secret1" }))
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(mockLogWarn).not.toHaveBeenCalled();
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
    const result = await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
    expect(result).toEqual({ error: "User already registered" });
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith("Sign-up failed", {
      event: "auth.sign_up_failed",
      email_domain: "acme.com",
      error: { message: "User already registered" },
    });
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

  // Launch-phase Access Code gate (ADR-0017, #425): no Access Codes exist in
  // this slice, so a pending Invitation is the only bypass while the gate is up.
  describe("the launch-phase Access Code gate (#425)", () => {
    it("refuses with { gated: true } when gated, no pending invitation, and no code", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);

      const result = await signUp({}, fd({ email: "uninvited@acme.com", password: "secret1" }));

      expect(result).toEqual({ gated: true });
      expect(mockHasPendingInvitation).toHaveBeenCalledWith("uninvited@acme.com");
      expect(mockClaimAccessCode).not.toHaveBeenCalled();
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it("logs auth.sign_up_gated with the domain only (never the full email)", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);

      await signUp({}, fd({ email: "uninvited@acme.com", password: "secret1" }));

      expect(mockLogWarn).toHaveBeenCalledWith(
        "Sign-up refused: access gate, no pending invitation or code",
        { event: "auth.sign_up_gated", email_domain: "acme.com" }
      );
    });

    it("proceeds to Supabase when gated but a pending invitation matches the email (bypass); consumes no code", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(true);
      mockSignUp.mockResolvedValue({
        data: { session: null, user: NEW_USER },
        error: null,
      });

      // A code submitted alongside an invited email is ignored entirely
      // (ADR-0017): the Invitation bypass is unconditional.
      const result = await signUp(
        {},
        fd({ email: "invited@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );

      expect(result).toEqual({ emailSent: true });
      expect(mockClaimAccessCode).not.toHaveBeenCalled();
      expect(mockRecordAccessCodeRedemption).not.toHaveBeenCalled();
      expect(mockSignUp).toHaveBeenCalledWith({
        email: "invited@acme.com",
        password: "secret1",
        options: { data: { locale: "es" } },
      });
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it("never checks for an invitation when the gate is off (ungated)", async () => {
      mockIsSignupGated.mockResolvedValue(false);
      mockSignUp.mockResolvedValue({
        data: { session: null, user: NEW_USER },
        error: null,
      });

      await signUp({}, fd({ email: "a@b.com", password: "secret1" }));

      expect(mockHasPendingInvitation).not.toHaveBeenCalled();
      expect(mockSignUp).toHaveBeenCalled();
    });

    it("checks the gate only after the per-IP rate limit passes", async () => {
      mockCheckLimit.mockResolvedValueOnce(true); // per-IP limited
      mockIsSignupGated.mockResolvedValue(true);

      const result = await signUp({}, fd({ email: "a@b.com", password: "secret1" }));

      expect(result).toEqual({ error: "Too many requests. Please try again later." });
      expect(mockIsSignupGated).not.toHaveBeenCalled();
    });
  });

  // Access Code schema + atomic claim (ADR-0017, #426): gated, no pending
  // invitation, a code is the only other way through. claimAccessCode itself
  // is unit-tested for atomicity against the real RPC in
  // claim-access-code.integration.test.ts; these tests cover the action's
  // claim → signUp → release/record lifecycle wiring.
  describe("the Access Code claim lifecycle (#426)", () => {
    beforeEach(() => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);
    });

    it("refuses with { gated: true } and never calls claimAccessCode when no code is submitted", async () => {
      const result = await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
      expect(result).toEqual({ gated: true });
      expect(mockClaimAccessCode).not.toHaveBeenCalled();
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it("claims the submitted code before calling signUp", async () => {
      mockSignUp.mockResolvedValue({ data: { session: null, user: NEW_USER }, error: null });
      await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "  Launch2026  " })
      );
      // Trimmed by AccessCodeSchema before it reaches the RPC.
      expect(mockClaimAccessCode).toHaveBeenCalledWith("Launch2026");
      const claimOrder = mockClaimAccessCode.mock.invocationCallOrder[0];
      const signUpOrder = mockSignUp.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(signUpOrder);
    });

    it.each([
      ["not_found", "invalid"],
      ["expired", "expired"],
      ["exhausted", "exhausted"],
    ] as const)(
      "returns accessCodeError=%s for claim status %s without calling signUp",
      async (status, expected) => {
        mockClaimAccessCode.mockResolvedValue({
          claimed: false,
          status,
          accessCodeId: null,
          trialDays: null,
          stripeCouponId: null,
          planSlug: null,
        });
        const result = await signUp(
          {},
          fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
        );
        expect(result).toEqual({ accessCodeError: expected });
        expect(mockSignUp).not.toHaveBeenCalled();
      }
    );

    it("releases the claim when signUp itself errors", async () => {
      mockSignUp.mockResolvedValue({
        data: {},
        error: { message: "Something went wrong" },
      });
      const result = await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      expect(result).toEqual({ error: "Something went wrong" });
      expect(mockReleaseAccessCodeClaim).toHaveBeenCalledWith("code-1");
      expect(mockRecordAccessCodeRedemption).not.toHaveBeenCalled();
    });

    it("releases the claim on the anti-enumeration existing-email path (empty identities)", async () => {
      mockSignUp.mockResolvedValue({
        data: { session: null, user: { id: "existing", identities: [] } },
        error: null,
      });
      const result = await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      expect(result).toEqual({ emailSent: true }); // fake-success, unchanged
      expect(mockReleaseAccessCodeClaim).toHaveBeenCalledWith("code-1");
      expect(mockRecordAccessCodeRedemption).not.toHaveBeenCalled();
    });

    it("records the redemption (tied to the new user) and does NOT release for a genuinely new user", async () => {
      mockSignUp.mockResolvedValue({
        data: { session: null, user: NEW_USER },
        error: null,
      });
      await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      expect(mockRecordAccessCodeRedemption).toHaveBeenCalledWith("code-1", "user-1");
      expect(mockReleaseAccessCodeClaim).not.toHaveBeenCalled();
    });

    it("keeps the slot for an unconfirmed-but-created account (no session yet)", async () => {
      // Same as the case above in every relevant respect — asserted separately
      // because ADR-0017 calls this out by name as the "don't release" case.
      mockSignUp.mockResolvedValue({
        data: { session: null, user: NEW_USER },
        error: null,
      });
      const result = await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      expect(result).toEqual({ emailSent: true });
      expect(mockReleaseAccessCodeClaim).not.toHaveBeenCalled();
      expect(mockRecordAccessCodeRedemption).toHaveBeenCalledWith("code-1", "user-1");
    });
  });

  // Signup pass (#487, ADR-0017): the app-minted token GoTrue's
  // before_user_created hook demands, closing the direct /auth/v1/signup REST
  // bypass. The hook side is integration-tested against the real function in
  // consume-signup-pass.integration.test.ts; these cover the action's mint
  // placement and its fail-closed wiring.
  describe("the signup pass (#487)", () => {
    // The hook's rejection as it surfaces through supabase.auth.signUp —
    // verified empirically against GoTrue v2.190.0 (AuthApiError, status 403,
    // message from the SQL hook's error object).
    const HOOK_REJECTION = { message: "Sign-up is not available.", status: 403 };

    it("mints a pass for the normalized email before calling signUp (ungated path)", async () => {
      mockSignUp.mockResolvedValue({ data: { session: null, user: NEW_USER }, error: null });
      await signUp({}, fd({ email: "  New@Acme.com ", password: "secret1" }));
      expect(mockMintSignupPass).toHaveBeenCalledWith("new@acme.com");
      const mintOrder = mockMintSignupPass.mock.invocationCallOrder[0];
      const signUpOrder = mockSignUp.mock.invocationCallOrder[0];
      expect(mintOrder).toBeLessThan(signUpOrder);
    });

    it("mints a pass on the gated Invitation-bypass path too", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(true);
      mockSignUp.mockResolvedValue({ data: { session: null, user: NEW_USER }, error: null });
      await signUp({}, fd({ email: "invited@acme.com", password: "secret1" }));
      expect(mockMintSignupPass).toHaveBeenCalledWith("invited@acme.com");
      expect(mockSignUp).toHaveBeenCalled();
    });

    it("mints AFTER a successful Access Code claim and BEFORE signUp (gated code path)", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);
      mockSignUp.mockResolvedValue({ data: { session: null, user: NEW_USER }, error: null });
      await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      const claimOrder = mockClaimAccessCode.mock.invocationCallOrder[0];
      const mintOrder = mockMintSignupPass.mock.invocationCallOrder[0];
      const signUpOrder = mockSignUp.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(mintOrder);
      expect(mintOrder).toBeLessThan(signUpOrder);
    });

    it("never mints when the gate refuses (no invitation, no code)", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);
      const result = await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
      expect(result).toEqual({ gated: true });
      expect(mockMintSignupPass).not.toHaveBeenCalled();
    });

    it("never mints when the Access Code claim is refused", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);
      mockClaimAccessCode.mockResolvedValue({
        claimed: false,
        status: "exhausted",
        accessCodeId: null,
        trialDays: null,
        stripeCouponId: null,
        planSlug: null,
      });
      const result = await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      expect(result).toEqual({ accessCodeError: "exhausted" });
      expect(mockMintSignupPass).not.toHaveBeenCalled();
    });

    it("never mints when the per-IP rate limit refuses", async () => {
      mockCheckLimit.mockResolvedValueOnce(true);
      await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
      expect(mockMintSignupPass).not.toHaveBeenCalled();
    });

    it("fails CLOSED with the generic gated refusal when the mint fails (ungated)", async () => {
      mockMintSignupPass.mockResolvedValue(false);
      const result = await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
      expect(result).toEqual({ gated: true });
      expect(mockSignUp).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(
        "Sign-up refused: signup pass mint failed",
        { event: "auth.sign_up_pass_mint_failed", email_domain: "acme.com" }
      );
    });

    it("releases a claimed Access Code slot when the mint fails (no account will result)", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);
      mockMintSignupPass.mockResolvedValue(false);
      const result = await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      expect(result).toEqual({ gated: true });
      expect(mockReleaseAccessCodeClaim).toHaveBeenCalledWith("code-1");
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it("maps a hook rejection from signUp to the generic gated refusal (no raw 403 echo)", async () => {
      mockSignUp.mockResolvedValue({ data: {}, error: HOOK_REJECTION });
      const result = await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
      expect(result).toEqual({ gated: true });
      expect(mockLogWarn).toHaveBeenCalledWith("Sign-up failed", {
        event: "auth.sign_up_failed",
        email_domain: "acme.com",
        error: HOOK_REJECTION,
      });
    });

    it("releases a claimed Access Code slot on a hook rejection (existing release trigger)", async () => {
      mockIsSignupGated.mockResolvedValue(true);
      mockHasPendingInvitation.mockResolvedValue(false);
      mockSignUp.mockResolvedValue({ data: {}, error: HOOK_REJECTION });
      const result = await signUp(
        {},
        fd({ email: "a@acme.com", password: "secret1", accessCode: "SOME-CODE" })
      );
      expect(result).toEqual({ gated: true });
      expect(mockReleaseAccessCodeClaim).toHaveBeenCalledWith("code-1");
      expect(mockRecordAccessCodeRedemption).not.toHaveBeenCalled();
    });

    it("still returns ordinary provider errors verbatim (not everything 4xx is a hook rejection)", async () => {
      mockSignUp.mockResolvedValue({
        data: {},
        error: { message: "User already registered", status: 422 },
      });
      const result = await signUp({}, fd({ email: "a@acme.com", password: "secret1" }));
      expect(result).toEqual({ error: "User already registered" });
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
    expect(mockLogWarn).toHaveBeenCalledWith("Password reset failed", {
      event: "auth.password_reset_failed",
      error: { message: "Auth session missing" },
    });
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

  it("logs auth.oauth_failed without echoing the raw submitted provider", async () => {
    await expect(
      signInWithOAuth(fd({ provider: "myspace" }))
    ).rejects.toThrow("NEXT_REDIRECT:/sign-in?error=oauth");
    expect(mockLogWarn).toHaveBeenCalledWith("OAuth sign-in failed", {
      event: "auth.oauth_failed",
      reason: "unsupported_provider",
    });
  });

  it("redirects to an error when the provider returns no URL", async () => {
    mockSignInWithOAuth.mockResolvedValue({ data: { url: null }, error: null });
    await expect(
      signInWithOAuth(fd({ provider: "github" }))
    ).rejects.toThrow("NEXT_REDIRECT:/sign-in?error=oauth");
    expect(mockLogWarn).toHaveBeenCalledWith("OAuth sign-in failed", {
      event: "auth.oauth_failed",
      reason: "no_authorize_url",
      provider: "github",
      error: undefined,
    });
  });

  it("logs the provider error when Supabase fails to start the OAuth flow", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: null },
      error: { message: "provider disabled" },
    });
    await expect(
      signInWithOAuth(fd({ provider: "github" }))
    ).rejects.toThrow("NEXT_REDIRECT:/sign-in?error=oauth");
    expect(mockLogWarn).toHaveBeenCalledWith("OAuth sign-in failed", {
      event: "auth.oauth_failed",
      reason: "provider_error",
      provider: "github",
      error: { message: "provider disabled" },
    });
  });

  it("does not log on a successful OAuth start", async () => {
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" },
      error: null,
    });
    await expect(
      signInWithOAuth(fd({ provider: "google" }))
    ).rejects.toThrow("NEXT_REDIRECT:https://accounts.google.com");
    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});
