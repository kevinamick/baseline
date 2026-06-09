import { BrandMark } from "@/app/_components/brand-mark";
import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { CreateTeamForm } from "./_components/create-team-form";
import { AcceptInviteButton } from "@/app/_components/accept-invite-button";
import { orgName } from "@/lib/invitations/org-name";

export default async function OnboardingPage() {
  const { email } = await getAuthContext();

  // Surface any pending invitations addressed to this verified email. This is
  // the robust new-invitee path: after sign-up → confirm, a no-org user lands
  // here, and their waiting invite is matched by email (no fragile token
  // threading through the confirmation email).
  const { data: pending } = email
    ? await supabaseAdmin
        .from("invitations")
        .select("id, expires_at, organizations(name)")
        .eq("email", email.toLowerCase())
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
    : { data: null };

  const invites = pending ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <span className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink">
          <BrandMark size={20} />
          Baseline
        </span>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        {invites.length > 0 && (
          <div className="form-reveal flex w-full max-w-md flex-col gap-4 rounded-2xl border border-hairline-cool bg-card p-8 shadow-card">
            <div>
              <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
                You&apos;ve been invited
              </h1>
              <p className="mt-1 text-[13px] text-fg-3">
                Accept an invitation to join an existing team.
              </p>
            </div>
            <ul className="flex flex-col gap-3">
              {invites.map((invite) => {
                const org = orgName(invite.organizations);
                return (
                  <li key={invite.id} className="flex flex-col gap-2">
                    <p className="text-sm text-ink">
                      Join <strong>{org}</strong>
                    </p>
                    <AcceptInviteButton
                      invitationId={invite.id}
                      label={`Join ${org}`}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
            Create your team
          </h1>
          <p className="mt-1.5 text-[15px] text-fg-2">
            Rubrics and eval runs are shared within your team.
          </p>
        </div>
        <CreateTeamForm />
      </main>
    </div>
  );
}
