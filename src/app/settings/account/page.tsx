import { getAuthContext } from "@/lib/auth/context";
import { NavBar } from "@/app/_components/nav-bar";

export default async function AccountSettingsPage() {
  const { email } = await getAuthContext();

  // Profile / email / password management replaces Clerk's account UI in a later
  // slice (#53). For now this is the destination of the nav "Manage account" link.
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-sm font-medium text-ink">{email ?? "Your account"}</p>
        <p className="text-sm text-zinc-500">
          Account management (profile, email, password) is coming soon.
        </p>
      </div>
    </div>
  );
}
