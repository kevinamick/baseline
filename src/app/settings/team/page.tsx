import { auth } from "@clerk/nextjs/server";
import { NavBar } from "@/app/_components/nav-bar";
import { redirect } from "next/navigation";
import { TeamSettingsForm } from "./_components/team-settings-form";

export default async function TeamSettingsPage() {
  const { orgRole } = await auth();

  if (orgRole !== "org:admin") {
    redirect("/rubrics");
  }

  return (
    <div className="flex flex-col min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <NavBar />
      <div className="flex flex-col items-center flex-1 p-8 pt-12">
        <div className="w-full max-w-2xl">
          <h1 className="mb-8 text-xl font-semibold text-ink">Team settings</h1>
          <TeamSettingsForm />
        </div>
      </div>
    </div>
  );
}
