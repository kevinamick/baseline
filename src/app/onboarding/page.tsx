import { CreateOrganization } from "@clerk/nextjs";

export default function OnboardingPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-100 dark:bg-zinc-950 gap-6 p-4">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create your team</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Rubrics and evaluations are shared within your team.
        </p>
      </div>
      <CreateOrganization afterCreateOrganizationUrl="/rubrics" skipInvitationScreen />
    </div>
  );
}
