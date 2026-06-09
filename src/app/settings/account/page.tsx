import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { NavBar } from "@/app/_components/nav-bar";
import { AccountForms } from "./_components/account-forms";

export default async function AccountSettingsPage() {
  // Account management acts on the current session's user directly (profile,
  // email, password), so read the raw auth user rather than the org-scoped
  // getAuthContext seam. The route is protected by proxy.ts; redirect defensively.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const displayName = (user.user_metadata?.name as string | undefined) ?? "";
  const email = user.email ?? "";

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">
          Account
        </h1>
        <p className="mt-1 text-sm text-fg-2">
          Manage your profile, email, and password.
        </p>

        <div className="mt-6">
          <AccountForms displayName={displayName} email={email} />
        </div>
      </main>
    </div>
  );
}
