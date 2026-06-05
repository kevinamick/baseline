"use client";

import { SignUpButton } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { track } from "@/lib/analytics/client";

export function SignUpCta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <SignUpButton mode="modal">
      <button
        className={className}
        onClick={() => track({ name: "auth.signup_started" })}
      >
        {children}
      </button>
    </SignUpButton>
  );
}
