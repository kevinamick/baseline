import Image from "next/image";
import { CreateTeamForm } from "./_components/create-team-form";
import { getLocale, getDictionary } from "@/lib/i18n";

export default async function OnboardingPage() {
  const locale = await getLocale();
  const t = getDictionary(locale);

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <span className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-white px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink">
          <Image src="/logo-mark.svg" width={20} height={20} alt="" priority />
          Baseline
        </span>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-[-0.02em] text-ink">
            {t.onboarding.heading}
          </h1>
          <p className="mt-1.5 text-[15px] text-zinc-700">
            {t.onboarding.subheading}
          </p>
        </div>
        <CreateTeamForm />
      </main>
    </div>
  );
}
