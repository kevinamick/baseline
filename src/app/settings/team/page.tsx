import { getAuthContext } from "@/lib/auth/context";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";

export default async function TeamSettingsPage() {
  const { canWrite } = await getAuthContext();

  if (!canWrite) {
    redirect("/rubrics");
  }

  // Member management replaces Clerk's <OrganizationProfile/> in a later slice
  // (#51), once organizations + memberships exist (#47).
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <NavBar />
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-zinc-500">
          Team management is coming with organizations.
        </p>
      </div>
    </div>
  );
}
