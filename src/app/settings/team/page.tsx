import { auth } from "@clerk/nextjs/server";
import { OrganizationProfile } from "@clerk/nextjs";
import { redirect } from "next/navigation";

export default async function TeamSettingsPage() {
  const { orgRole } = await auth();

  if (orgRole !== "org:admin") {
    redirect("/rubrics");
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-100 dark:bg-zinc-950 p-4">
      <OrganizationProfile routing="hash" />
    </div>
  );
}
