import { getAuthContext } from "@/lib/auth/context";
import { OrganizationProfile } from "@clerk/nextjs";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";

export default async function TeamSettingsPage() {
  const { canWrite } = await getAuthContext();

  if (!canWrite) {
    redirect("/rubrics");
  }

  return (
    <div className="flex flex-col min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <NavBar />
      <div className="flex flex-col items-center justify-center flex-1 p-4">
        <OrganizationProfile routing="hash" />
      </div>
    </div>
  );
}
