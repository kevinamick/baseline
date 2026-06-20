import { BrandMark } from "@/app/_components/brand-mark";
import { Link } from "@/i18n/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
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

function Notice({
  title,
  body,
  linkLabel,
}: {
  title: string;
  body: string;
  linkLabel: string;
}) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">{title}</h1>
      <p className="text-sm leading-normal text-fg-2">{body}</p>
      <p className="text-[13px] text-fg-3">
        <Link href="/sign-in" className="font-medium text-ink hover:underline">
          {linkLabel}
        </Link>
      </p>
    </>
  );
}

export default async function AcceptInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "EntryFlows" });
  const { token } = await searchParams;

  if (!token) {
    return (
      <Shell>
        <Notice
          title={t("inviteNotFoundTitle")}
          body={t("inviteNotFoundBody")}
          linkLabel={t("goToSignIn")}
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
          title={t("inviteNotFoundTitle")}
          body={t("inviteNotFoundBody")}
          linkLabel={t("goToSignIn")}
        />
      </Shell>
    );
  }

  if (invite.accepted_at) {
    return (
      <Shell>
        <Notice
          title={t("inviteUsedTitle")}
          body={t("inviteUsedBody")}
          linkLabel={t("goToSignIn")}
        />
      </Shell>
    );
  }

  if (new Date(invite.expires_at) < new Date()) {
    return (
      <Shell>
        <Notice
          title={t("inviteExpiredTitle")}
          body={t("inviteExpiredBody")}
          linkLabel={t("goToSignIn")}
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
          {t("invitedToOrg", { org })}
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          {t.rich("signInOrCreate", {
            email: invite.email,
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        <div className="flex flex-col gap-2">
          <Link
            href="/sign-up"
            className="w-full rounded-full bg-ink px-5 py-2.5 text-center text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
          >
            {t("createAnAccount")}
          </Link>
          <Link
            href={signInPath}
            className="w-full rounded-full border border-hairline-field px-5 py-2.5 text-center text-sm font-medium text-ink transition-colors hover:bg-card-warm"
          >
            {t("signIn")}
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
          {t("wrongAccountTitle")}
        </h1>
        <p className="text-sm leading-normal text-fg-2">
          {t.rich("wrongAccountBody", {
            inviteEmail: invite.email,
            currentEmail: email ?? "",
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        <SignOutButton className="w-full rounded-full border border-hairline-field px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm" />
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
        {t("joinOrgTitle", { org })}
      </h1>
      <p className="text-sm leading-normal text-fg-2">
        {t.rich("joinOrgBody", {
          org,
          b: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      <AcceptInviteButton
        invitationId={invite.id}
        label={t("joinOrgLabel", { org })}
      />
    </Shell>
  );
}
