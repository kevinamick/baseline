// Placeholder until organization creation lands in the orgs slice (#47), which
// replaces this with a server action that inserts an organization plus an owner
// membership. Kept Clerk-free so the onboarding route prerenders without a
// provider.
export function CreateTeamForm() {
  return (
    <div className="form-reveal flex w-full max-w-md flex-col gap-3 rounded-2xl border border-hairline-cool bg-white p-8 text-center shadow-card">
      <p className="text-sm text-zinc-600">
        Team creation is coming in the next step of the Supabase migration.
      </p>
    </div>
  );
}
