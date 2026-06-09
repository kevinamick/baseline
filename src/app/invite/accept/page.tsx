import { BrandMark } from "@/app/_components/brand-mark";
import Link from "next/link";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/invitations/token";
import { orgName } from "@/lib/invitations/org-name";
import { AcceptInviteButton } from "@/app/_components/accept-invite-button";
import { SignOutButton } from "@/app/_components/sign-out-button";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <span className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink">
          <BrandMark size={20} />
          Baseline
        </span>
      </header>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="form-reveal flex w-full max-w-md flex-col gap-5 rounded-2xl border border-hairline-cool bg-card p-8 shadow-card">
          {children}
        </div>
      </main>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">{title}</h1>
      <p className="text-sm leading-normal text-fg-2">{body}</p>
      <p className="text-[13px] text-fg-3">
        <Link href="/sign-in" className="font-medium text-ink hover:underline">
          Go to sign in
        </Link>
      </p>
    </>
  );
}

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <Shell>
        <Notice
          title="Invitation not found"
          body="This invitation link is invalid. Ask your team admin to send a new one."
        />
      </Shell>
    );
  }

  // The not-found / used / expired / email-match checks below are convenience UX
  // so the invitee sees a clear reason. `acceptInvitation` re-validates all of
  // them server-side at submit, so it — not this page — is the real gate.
  const { data: invite } = await supabaseAdmin
    .from("invitations")
    .select("id, email, expires_at, accepted_at, organizations(name)")
    .eq("token_hash", hashToken(token))
    .maybeSingle();

  if (!invite) {
    return (
      <Shell>
        <Notice
          title="Invitation not found"
          body="This invitation link is invalid. Ask your team admin to send a new one."
        />
      </Shell>
    );
  }

  if (invite.accepted_at) {
    return (
      <Shell>
        <Notice
          title="Invitation already used"
          body="This invitation has already been accepted. Sign in to reach your team."
        />
      </Shell>
    );
  }

  if (new Date(invite.expires_at) < new Date()) {
    return (
      <Shell>
        <Notice
          title="Invitation expired"
          body="This invitation has expired. Ask your team admin to send a new one."
        />
      </Shell>
    );
  }

  const org = orgName(invite.organizations);
  const { userId, email } = await getAuthContext();
  // Only sign-in carries `next` back here: it's a single server redirect. A new
  // invitee signs up plainly — after email confirmation they reach onboarding,
  // where their invite is surfaced by verified email (no fragile next-threading
  // through the confirmation email).
  const signInPath = `/sign-in?next=${encodeURIComponent(
    `/invite/accept?token=${token}`
  )}`;

  // Signed out — guide the invitee to authenticate, then return here.
  if (!userId) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          You&apos;ve been invited to {org}
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          Sign in or create an account with <strong>{invite.email}</strong> to
          accept this invitation.
        </p>
        <div className="flex flex-col gap-2">
          <Link
            href="/sign-up"
            className="w-full rounded-full bg-ink px-5 py-2.5 text-center text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
          >
            Create an account
          </Link>
          <Link
            href={signInPath}
            className="w-full rounded-full border border-hairline-field px-5 py-2.5 text-center text-sm font-medium text-ink transition-colors hover:bg-card-warm"
          >
            Sign in
          </Link>
        </div>
      </Shell>
    );
  }

  // Signed in as the wrong account — the invite is keyed to a specific email.
  if (email?.toLowerCase() !== invite.email) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Wrong account
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          This invitation is for <strong>{invite.email}</strong>, but you&apos;re
          signed in as <strong>{email}</strong>. Sign out and sign back in with
          the invited email to accept.
        </p>
        <SignOutButton className="w-full rounded-full border border-hairline-field px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm" />
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
        Join {org}
      </h1>
      <p className="text-sm leading-normal text-fg-2">
        You&apos;ve been invited to join <strong>{org}</strong> as a member.
      </p>
      <AcceptInviteButton invitationId={invite.id} label={`Join ${org}`} />
    </Shell>
  );
}
