"use client";

import Link from "next/link";
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
    <Link
      href="/sign-in"
      className={className}
      onClick={() => track({ name: "auth.sign_in_clicked" })}
    >
      {children}
    </Link>
  );
}
