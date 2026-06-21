import { describe, it, expect, vi, beforeEach } from "vitest";

// The logging module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

const {
  mockGetAuthContext,
  mockTrack,
  mockRedirect,
  mockRevalidate,
  mockSendEmail,
  mockOrgSelect,
  mockInviteInsert,
  mockInviteInsertArgs,
  mockInviteSelect,
  mockInviteClaim,
  mockInviteUnclaim,
  mockInviteDelete,
  mockMembershipInsert,
  mockMembershipInsertArgs,
  mockCookieSet,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockTrack: vi.fn(),
  // redirect() never returns — model it as a throw so control flow halts.
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  mockRevalidate: vi.fn(),
  mockSendEmail: vi.fn(),
  mockOrgSelect: vi.fn(),
  mockInviteInsert: vi.fn(),
  mockInviteInsertArgs: vi.fn(),
  mockInviteSelect: vi.fn(),
  mockInviteClaim: vi.fn(),
  mockInviteUnclaim: vi.fn(),
  mockInviteDelete: vi.fn(),
  mockMembershipInsert: vi.fn(),
  mockMembershipInsertArgs: vi.fn(),
  mockCookieSet: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: mockCookieSet,
    // inviteMember reads NEXT_LOCALE to resolve the email locale (#241).
    get: vi.fn(() => undefined),
  })),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/email/invitation-email", () => ({
  buildInvitationEmail: (opts: { to: string }) => ({
    to: opts.to,
    subject: "subj",
    html: "html",
  }),
  invitationAcceptUrl: () => "http://app/invite/accept?token=raw",
}));
vi.mock("@/lib/invitations/token", () => ({
  generateToken: () => "raw-token",
  hashToken: (t: string) => `hash:${t}`,
}));

// Seat caps (#182): default to an unlimited-seat plan so the existing invite
// tests run ungated; the cap test overrides to Free.
const mockGetBillingState = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));

// Rate limiter (#211): default under the limit; the rate-limit test flips it.
const mockCheckLimit = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@/lib/rate-limit/guard", () => ({
  checkLimit: mockCheckLimit,
  rateLimitMessage: () => "Too many requests. Please try again later.",
}));

// A chainable query-builder stub: intermediate methods return the same node;
// `single`/`maybeSingle` resolve `terminal()`, and awaiting the node resolves
// `thenable()` (for delete/update calls that aren't read back).
vi.mock("@/lib/supabase/admin", () => {
  function makeChain(
    terminal: () => unknown,
    thenable?: () => unknown
  ): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order", "gt"]) {
      c[m] = () => c;
    }
    c.maybeSingle = () => Promise.resolve(terminal());
    c.single = () => Promise.resolve(terminal());
    if (thenable) {
      c.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve(thenable()).then(onF, onR);
    }
    return c;
  }

  return {
    supabaseAdmin: {
      from: (table: string) => ({
        select: () =>
          table === "organizations"
            ? makeChain(() => mockOrgSelect())
            : table === "memberships"
              ? // Head-count select for the seat cap (#182): one existing member.
                makeChain(() => ({}), () => ({ count: 1 }))
              : makeChain(() => mockInviteSelect(), () => ({ count: 0 })),
        insert: (payload: unknown) => {
          if (table === "memberships") {
            mockMembershipInsertArgs(payload);
            return makeChain(() => ({}), () => mockMembershipInsert());
          }
          mockInviteInsertArgs(payload);
          return makeChain(() => mockInviteInsert());
        },
        update: () =>
          makeChain(
            () => mockInviteClaim(),
            () => mockInviteUnclaim()
          ),
        delete: () => makeChain(() => ({}), () => mockInviteDelete()),
      }),
    },
  };
});

import {
  inviteMember,
  revokeInvitation,
  acceptInvitation,
} from "../invitations";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({
    userId: "user-1",
    email: "invitee@acme.com",
    orgId: "org-1",
    role: "admin",
    canWrite: true,
  });
  mockOrgSelect.mockResolvedValue({ data: { name: "Acme" }, error: null });
  mockInviteInsert.mockResolvedValue({ data: { id: "inv-1" }, error: null });
  mockSendEmail.mockResolvedValue(undefined);
  mockInviteDelete.mockResolvedValue({ error: null });
  mockGetBillingState.mockResolvedValue({ active: true, plan: "builder" });
  mockInviteUnclaim.mockResolvedValue({ error: null });
  mockMembershipInsert.mockResolvedValue({ error: null });
  mockCheckLimit.mockReset().mockResolvedValue(false);
});

describe("inviteMember", () => {
  it("blocks invites at the plan's seat cap (#182): Free teams can never invite", async () => {
    mockGetBillingState.mockResolvedValue({ active: false, plan: "free" });
    const result = await inviteMember({}, fd({ email: "new@acme.com" }));
    expect(result).toEqual({
      error: "The Free plan includes 1 seat — upgrade to invite teammates.",
    });
    expect(mockInviteInsertArgs).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("creates a pending invite and emails the accept link", async () => {
    const result = await inviteMember({}, fd({ email: "New@Acme.com" }));

    expect(result).toEqual({ sentTo: "new@acme.com" });
    const payload = mockInviteInsertArgs.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      org_id: "org-1",
      email: "new@acme.com", // normalized lowercase
      token_hash: "hash:raw-token",
      invited_by: "user-1",
    });
    expect(typeof payload.expires_at).toBe("string");
    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockTrack).toHaveBeenCalledWith(
      { name: "invitation.sent", props: { team_id: "org-1" } },
      { userId: "user-1" }
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/settings/team");
  });

  it("rejects non-admins", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      canWrite: false,
    });
    const result = await inviteMember({}, fd({ email: "new@acme.com" }));
    expect(result).toEqual({ error: "Only team admins can invite members." });
    expect(mockInviteInsertArgs).not.toHaveBeenCalled();
  });

  it("rate-limits per team with a generic 429, before any billing or DB work", async () => {
    mockCheckLimit.mockResolvedValueOnce(true);
    const result = await inviteMember({}, fd({ email: "new@acme.com" }));
    expect(result).toEqual({ error: "Too many requests. Please try again later." });
    expect(mockCheckLimit).toHaveBeenCalledWith("inviteMember", "team", "org-1");
    expect(mockGetBillingState).not.toHaveBeenCalled();
    expect(mockInviteInsertArgs).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid email", async () => {
    const result = await inviteMember({}, fd({ email: "not-an-email" }));
    expect(result.error).toBeTruthy();
    expect(mockInviteInsertArgs).not.toHaveBeenCalled();
  });

  it("reports an already-pending invite", async () => {
    mockInviteInsert.mockResolvedValue({ data: null, error: { code: "23505" } });
    const result = await inviteMember({}, fd({ email: "new@acme.com" }));
    expect(result).toEqual({
      error: "An invitation is already pending for this email.",
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("rolls back the invite when the email fails to send", async () => {
    mockSendEmail.mockRejectedValue(new Error("smtp down"));
    const result = await inviteMember({}, fd({ email: "new@acme.com" }));
    expect(result).toEqual({
      error: "Could not send the invitation email. Please try again.",
    });
    expect(mockInviteDelete).toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe("revokeInvitation", () => {
  it("deletes a pending invite and revalidates", async () => {
    await revokeInvitation(fd({ invitationId: "inv-1" }));
    expect(mockInviteDelete).toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      { name: "invitation.revoked", props: { team_id: "org-1" } },
      { userId: "user-1" }
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/settings/team");
  });

  it("does nothing for non-admins", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      canWrite: false,
    });
    await revokeInvitation(fd({ invitationId: "inv-1" }));
    expect(mockInviteDelete).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe("acceptInvitation", () => {
  const validInvite = {
    id: "inv-1",
    org_id: "org-1",
    role: "member",
    email: "invitee@acme.com",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    accepted_at: null,
  };

  beforeEach(() => {
    mockInviteSelect.mockResolvedValue({ data: validInvite, error: null });
    mockInviteClaim.mockResolvedValue({ data: { id: "inv-1" }, error: null });
  });

  it("grants a membership and redirects to /rubrics", async () => {
    await expect(
      acceptInvitation({}, fd({ invitationId: "inv-1" }))
    ).rejects.toThrow("REDIRECT:/rubrics");
    expect(mockMembershipInsertArgs).toHaveBeenCalledWith({
      org_id: "org-1",
      user_id: "user-1",
      role: "member",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      { name: "invitation.accepted", props: { team_id: "org-1" } },
      { userId: "user-1" }
    );
    // Switches the invitee into the org they just joined (#52).
    expect(mockCookieSet).toHaveBeenCalledWith(
      "active_org",
      "org-1",
      expect.objectContaining({ httpOnly: true, path: "/" })
    );
  });

  it("redirects to sign-in when not signed in", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, email: null });
    await expect(
      acceptInvitation({}, fd({ invitationId: "inv-1" }))
    ).rejects.toThrow("REDIRECT:/sign-in");
  });

  it("rejects an unknown invite", async () => {
    mockInviteSelect.mockResolvedValue({ data: null, error: null });
    const result = await acceptInvitation({}, fd({ invitationId: "nope" }));
    expect(result).toEqual({ error: "This invitation could not be found." });
  });

  it("rejects an already-used invite", async () => {
    mockInviteSelect.mockResolvedValue({
      data: { ...validInvite, accepted_at: new Date().toISOString() },
      error: null,
    });
    const result = await acceptInvitation({}, fd({ invitationId: "inv-1" }));
    expect(result).toEqual({ error: "This invitation has already been used." });
  });

  it("rejects an expired invite", async () => {
    mockInviteSelect.mockResolvedValue({
      data: { ...validInvite, expires_at: new Date(Date.now() - 1000).toISOString() },
      error: null,
    });
    const result = await acceptInvitation({}, fd({ invitationId: "inv-1" }));
    expect(result).toEqual({ error: "This invitation has expired." });
  });

  it("rejects when the signed-in email doesn't match the invite", async () => {
    mockGetAuthContext.mockResolvedValue({
      userId: "user-2",
      email: "someone-else@acme.com",
    });
    const result = await acceptInvitation({}, fd({ invitationId: "inv-1" }));
    expect(result.error).toContain("invitee@acme.com");
  });

  it("loses the claim race gracefully", async () => {
    mockInviteClaim.mockResolvedValue({ data: null, error: null });
    const result = await acceptInvitation({}, fd({ invitationId: "inv-1" }));
    expect(result).toEqual({ error: "This invitation has already been used." });
    expect(mockMembershipInsertArgs).not.toHaveBeenCalled();
  });

  it("rejects re-joining the same org and un-claims the invite", async () => {
    // The only unique violation left is the (org_id, user_id) PK — already a
    // member of *this* org (a user may belong to many orgs now, #52).
    mockMembershipInsert.mockResolvedValue({ error: { code: "23505" } });
    const result = await acceptInvitation({}, fd({ invitationId: "inv-1" }));
    expect(result).toEqual({ error: "You're already a member of this team." });
    // Un-claim runs so the invite isn't burned by a recoverable failure.
    expect(mockInviteUnclaim).toHaveBeenCalled();
  });
});
