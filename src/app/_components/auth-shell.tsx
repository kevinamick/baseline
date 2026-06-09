import { BrandMark } from "@/app/_components/brand-mark";
import Link from "next/link";

/**
 * Shared chrome for the standalone auth pages (sign-in, sign-up,
 * forgot-password, reset-password): the paper background, a logo header linking
 * home, and a centered slot for the form card.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper bg-paper-gradient">
      <header className="flex px-6 py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-full border border-hairline-cool bg-card px-[18px] py-[9px] text-sm font-semibold tracking-[-0.01em] text-ink transition-colors hover:bg-card-warm"
        >
          <BrandMark size={20} />
          Baseline
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        {children}
      </div>
    </div>
  );
}
