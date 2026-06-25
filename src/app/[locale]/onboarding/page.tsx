import { Link } from "@/i18n/navigation";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { BrandMark } from "@/app/_components/brand-mark";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { getProviderKeyRows } from "@/lib/llm/keys";
import { ProviderKeysList } from "@/app/_components/provider-keys-list";
import { CreateTeamForm } from "./_components/create-team-form";
import { AcceptInviteButton } from "@/app/_components/accept-invite-button";
import { orgName } from "@/lib/invitations/org-name";

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "EntryFlows" });
  const { email, orgId, canWrite } = await getAuthContext();

  // A freshly created Team lands back here for the provider-key step (#184).
  // Free Teams run on their own key, so prompt for one before entering the app;
  // a paid Team has the managed-key fallback and goes straight through.
  if (orgId) {
    const billing = await getBillingState(orgId);
    if (PLANS[billing.plan].managedMarkupPct != null) {
      redirect("/rubrics");
    }
    const rows = await getProviderKeyRows(orgId);
    return (
      <OnboardingShell>
        <div className="form-reveal flex w-full max-w-md flex-col gap-5 rounded-2xl border border-hairline-cool bg-card p-8 shadow-card">
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
              {t("addProviderKeyTitle")}
            </h1>
            <p className="mt-1 text-[13px] text-fg-3">
              {t("addProviderKeyBlurb")}
            </p>
          </div>
          <ProviderKeysList rows={rows} canWrite={canWrite} />
          <Link
            href="/rubrics"
            className="w-full rounded-full bg-ink px-5 py-2.5 text-center text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
          >
            {t("continueToBaseline")}
            <span aria-hidden="true"> →</span>
          </Link>
        </div>
      </OnboardingShell>
    );
  }

  // No Team yet — surface any pending invitations addressed to this verified
  // email, then the create-team form. This is the robust new-invitee path: after
  // sign-up → confirm, a no-org user lands here and their waiting invite is
  // matched by email (no fragile token threading through the confirmation email).
  const { data: pending, error: pendingError } = email
    ? await supabaseAdmin
        .from("invitations")
        .select("id, expires_at, organizations(name)")
        .eq("email", email.toLowerCase())
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
    : { data: null, error: null };

  const invites = pending ?? [];

  return (
    <OnboardingShell>
      {pendingError ? (
        <div className="form-reveal w-full max-w-md rounded-2xl border border-hairline-cool bg-card p-8">
          <p className="text-sm text-danger">{t("pendingInvitesFetchError")}</p>
        </div>
      ) : invites.length > 0 ? (
        <div className="form-reveal flex w-full max-w-md flex-col gap-4 rounded-2xl border border-hairline-cool bg-card p-8 shadow-card">
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
              {t("invitedTitle")}
            </h1>
            <p className="mt-1 text-[13px] text-fg-3">
              {t("invitedBlurb")}
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            {invites.map((invite) => {
              const org = orgName(invite.organizations);
              return (
                <li key={invite.id} className="flex flex-col gap-2">
                  <p className="text-sm text-ink">
                    {t.rich("joinOrg", {
                      org,
                      b: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </p>
                  <AcceptInviteButton
                    invitationId={invite.id}
                    label={t("joinOrgLabel", { org })}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
          {t("createTeamTitle")}
        </h1>
        <p className="mt-1.5 text-[15px] text-fg-2">
          {t("createTeamSubtitle")}
        </p>
      </div>
      <CreateTeamForm />
    </OnboardingShell>
  );
}

function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <span className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink">
          <BrandMark size={20} />
          Baseline
        </span>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        {children}
      </main>
    </div>
  );
}
