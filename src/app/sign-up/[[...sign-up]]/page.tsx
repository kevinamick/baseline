import { SignUp } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";

const appearance = {
  variables: {
    colorPrimary: "#0E0E10",
    colorText: "#0E0E10",
    colorBackground: "#FFFFFF",
    borderRadius: "14px",
    fontFamily: "var(--font-geist-sans)",
  },
  elements: {
    cardBox: "shadow-card border border-hairline-cool rounded-2xl",
    formButtonPrimary:
      "rounded-full bg-ink hover:bg-ink-soft text-sm font-medium normal-case",
  },
};

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen flex-col bg-paper">
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
        <SignUp appearance={appearance} />
      </div>
    </div>
  );
}
