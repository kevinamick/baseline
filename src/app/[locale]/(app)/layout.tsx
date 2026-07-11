import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthProvider } from "@/app/_components/auth-context";
import { NavBar } from "@/app/_components/nav-bar";
import { resolveNavAuth } from "@/lib/auth/nav";

/**
 * Shell for every auth-gated app surface (dashboard, rubrics, schedules,
 * optimizations, settings). It hosts the one `NavBar` that persists across all
 * navigation *between* these routes: a `layout.tsx` is preserved when you move
 * between its child pages, so the nav (a Client Component reading the seeded
 * `AuthProvider`) stays mounted and does not re-render or re-fetch on each
 * transition — the whole point of #326's follow-up. Putting the nav back in the
 * pages (as the first cut did) re-mounts it on every navigation, which is the
 * re-render this layout exists to eliminate.
 *
 * `resolveNavAuth()` runs once when the group is entered and is *not* re-run on
 * client navigation between children (only `switchOrg`'s `revalidatePath("/",
 * "layout")` re-runs it), so the seed stays stable across transitions.
 *
 * The shell is `min-h-[100dvh]` (not a fixed `h-`) so document-style pages
 * (dashboard, settings) grow past the viewport and scroll the window, while the
 * fixed-viewport app pages (rubrics/schedules/optimizations) keep their own
 * `flex-1 overflow-hidden` content region that fills the space below the nav and
 * scrolls internally. Each page renders its content as the `flex-1` child.
 */
// Signed-in surfaces show the plain brand as the tab title — the root layout's
// default title is keyword-rich marketing copy for search, which has no
// business labeling a dashboard tab, bookmark, or history entry.
export const metadata: Metadata = {
  title: "Baseline",
};

export default async function AppLayout({ children }: { children: ReactNode }) {
  const navAuth = await resolveNavAuth();

  return (
    <div className="flex min-h-[100dvh] flex-col bg-paper">
      <AuthProvider {...navAuth}>
        <NavBar />
      </AuthProvider>
      {children}
    </div>
  );
}
