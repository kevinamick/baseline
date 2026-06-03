import { NavBar } from "@/app/_components/nav-bar";

/**
 * Interim state for #46: a signed-in user has no Team yet (`orgId` is stubbed
 * null until organizations land in #47), so the org-scoped pages have nothing
 * to show. Replaced once real org creation exists.
 */
export function NoTeamPlaceholder() {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          No team yet
        </h1>
        <p className="max-w-sm text-sm text-zinc-500">
          Team creation arrives in the next step of the migration. Once you can
          create a team, your rubrics and eval runs will show up here.
        </p>
      </div>
    </div>
  );
}
