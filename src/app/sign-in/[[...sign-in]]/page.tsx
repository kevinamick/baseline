import Image from "next/image";
import Link from "next/link";
import { SignInForm } from "@/app/_components/auth-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-white px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink transition-colors hover:bg-card-warm"
        >
          <Image src="/logo-mark.svg" width={20} height={20} alt="" priority />
          Baseline
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        <SignInForm next={next} />
      </div>
    </div>
  );
}
