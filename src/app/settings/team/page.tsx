import { getAuthContext } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";
import { revokeInvitation } from "@/app/actions/invitations";
import { InviteMemberForm } from "./_components/invite-member-form";

export default async function TeamSettingsPage() {
  const { canWrite, orgId } = await getAuthContext();

  // Only the org admin (Contributor) manages the team; read-only members and
  // users with no team go to Rubrics.
  if (!canWrite || !orgId) {
    redirect("/rubrics");
  }

  const { data: pending } = await supabaseAdmin
    .from("invitations")
    .select("id, email, expires_at")
    .eq("org_id", orgId)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });

  const invites = pending ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Team
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Invite people to your team. They join as members once they accept.
        </p>

        <section className="mt-6 rounded-2xl border border-hairline-cool bg-white p-6 shadow-card">
          <InviteMemberForm />
        </section>

        <section className="mt-6">
          <h2 className="text-sm font-medium text-ink">Pending invitations</h2>
          {invites.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No pending invitations.</p>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-hairline-cool rounded-2xl border border-hairline-cool bg-white">
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-4 p-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{invite.email}</p>
                    <p className="text-xs text-zinc-500">
                      Expires {new Date(invite.expires_at).toLocaleDateString()}
                    </p>
                  </div>
                  <form action={revokeInvitation}>
                    <input type="hidden" name="invitationId" value={invite.id} />
                    <button
                      type="submit"
                      className="shrink-0 rounded-full border border-hairline-field px-4 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-card-warm"
                    >
                      Revoke
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
