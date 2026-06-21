import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listOrgMembers, getOrgName } from "@/lib/auth/members";
import { getBillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { getProviderKeyRows } from "@/lib/llm/keys";
import { NavBar } from "@/app/_components/nav-bar";
import { ProviderKeysList } from "@/app/_components/provider-keys-list";
import { redirect } from "next/navigation";
import { revokeInvitation } from "@/app/actions/invitations";
import { changeMemberRole, removeMember } from "@/app/actions/memberships";
import { InviteMemberForm } from "./_components/invite-member-form";
import { DeleteTeamButton } from "./_components/delete-team-button";

export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Settings.team" });

  const { userId, canWrite, orgId } = await getAuthContext();

  // Only the org admin (Contributor) manages the team; read-only members and
  // users with no team go to Rubrics.
  if (!canWrite || !orgId) {
    redirect("/rubrics");
  }

  const [members, { data: pending }, teamName, providerKeyRows, billing] =
    await Promise.all([
      listOrgMembers(orgId),
      supabaseAdmin
        .from("invitations")
        .select("id, email, expires_at")
        .eq("org_id", orgId)
        .is("accepted_at", null)
        .order("created_at", { ascending: false }),
      // The active org's display name for the heading; falls back to a neutral
      // label so it never renders empty.
      getOrgName(orgId, "Your team"),
      getProviderKeyRows(orgId),
      getBillingState(orgId),
    ]);

  const invites = pending ?? [];
  // Free Teams have no managed-key fallback, so a provider key is required to run.
  const byoRequired = PLANS[billing.plan].managedMarkupPct == null;
  // Last-admin guard mirror: when there's a single admin, hide their demote /
  // remove controls (the server action enforces this too).
  const adminCount = members.filter((m) => m.role === "admin").length;

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          {teamName}
        </h1>
        <p className="mt-1 text-sm text-fg-2">
          {t("subtitle")}
        </p>

        <section className="mt-6">
          <h2 className="text-sm font-medium text-ink">{t("membersHeading")}</h2>
          <ul className="mt-3 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card">
            {members.map((member) => {
              const isSelf = member.userId === userId;
              const isLastAdmin = member.role === "admin" && adminCount <= 1;
              return (
                <li
                  key={member.userId}
                  className="flex items-center justify-between gap-4 p-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">
                      {member.email ?? t("unknownUser")}
                      {isSelf && (
                        <span className="ml-2 text-xs text-fg-3">{t("you")}</span>
                      )}
                    </p>
                    <p className="text-xs capitalize text-fg-3">
                      {member.role === "admin" ? t("roleAdmin") : t("roleMember")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* You manage other members, not yourself — no self-demote
                        or self-remove (the last-admin guard backs this too). */}
                    {isSelf ? null : member.role === "member" ? (
                      <form action={changeMemberRole}>
                        <input
                          type="hidden"
                          name="userId"
                          value={member.userId}
                        />
                        <input type="hidden" name="role" value="admin" />
                        <button
                          type="submit"
                          className="rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
                        >
                          {t("makeAdmin")}
                        </button>
                      </form>
                    ) : (
                      !isLastAdmin && (
                        <form action={changeMemberRole}>
                          <input
                            type="hidden"
                            name="userId"
                            value={member.userId}
                          />
                          <input type="hidden" name="role" value="member" />
                          <button
                            type="submit"
                            className="rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
                          >
                            {t("makeMember")}
                          </button>
                        </form>
                      )
                    )}
                    {!isSelf && !isLastAdmin && (
                      <form action={removeMember}>
                        <input
                          type="hidden"
                          name="userId"
                          value={member.userId}
                        />
                        <button
                          type="submit"
                          className="rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-danger-fg transition-colors hover:bg-card-warm"
                        >
                          {t("remove")}
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mt-6 rounded-2xl border border-hairline-cool bg-card p-6 shadow-card">
          <InviteMemberForm />
        </section>

        <section className="mt-6">
          <h2 className="text-sm font-medium text-ink">{t("pendingHeading")}</h2>
          {invites.length === 0 ? (
            <p className="mt-2 text-sm text-fg-2">{t("pendingEmpty")}</p>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-card">
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-4 p-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{invite.email}</p>
                    <p className="text-xs text-fg-3">
                      {t("expires", {
                        date: new Date(invite.expires_at).toLocaleDateString(locale),
                      })}
                    </p>
                  </div>
                  <form action={revokeInvitation}>
                    <input type="hidden" name="invitationId" value={invite.id} />
                    <button
                      type="submit"
                      className="shrink-0 rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
                    >
                      {t("revoke")}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-sm font-medium text-ink">{t("providerKeysHeading")}</h2>
          <p className="mt-1 text-sm text-fg-2">{t("providerKeysBlurb")}</p>
          {byoRequired && (
            <p className="mt-3 rounded-2xl border border-hairline-cool bg-card-warm p-4 text-sm text-fg-2">
              {t.rich("byoRequired", {
                strong: (chunks) => (
                  <span className="font-medium text-ink">{chunks}</span>
                ),
              })}
            </p>
          )}
          <ProviderKeysList rows={providerKeyRows} canWrite={canWrite} />
        </section>

        <section className="mt-8 rounded-2xl border border-danger bg-card p-6">
          <h2 className="text-sm font-medium text-danger-fg">{t("dangerHeading")}</h2>
          <p className="mt-1 text-sm text-fg-3">{t("dangerBlurb")}</p>
          <div className="mt-4">
            <DeleteTeamButton teamName={teamName} />
          </div>
        </section>
      </main>
    </div>
  );
}
