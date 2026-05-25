"use client";

import { SignInButton } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { track } from "@/lib/analytics/client";

export function SignInCta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <SignInButton mode="modal">
      <button
        className={className}
        onClick={() => track({ name: "auth.sign_in_clicked" })}
      >
        {children}
      </button>
    </SignInButton>
  );
}
