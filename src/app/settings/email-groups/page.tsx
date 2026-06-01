import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { NavBar } from "@/app/_components/nav-bar";
import { listEmailGroups } from "@/app/actions/email-groups";
import { EmailGroupsClient } from "./_components/email-groups-client";

export default async function EmailGroupsPage() {
  const { orgRole } = await auth();

  if (orgRole !== "org:admin") {
    redirect("/rubrics");
  }

  const groups = await listEmailGroups();

  return (
    <div className="flex flex-col min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <NavBar />
      <div className="flex flex-col items-center flex-1 p-6">
        <div className="w-full max-w-2xl">
          <div className="mb-6">
            <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">Email groups</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Named lists of recipients that can be applied to eval runs and schedules.
            </p>
          </div>
          <EmailGroupsClient groups={groups} />
        </div>
      </div>
    </div>
  );
}
