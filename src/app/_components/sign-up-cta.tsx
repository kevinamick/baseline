"use client";

import { Link } from "@/i18n/navigation";
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
    <Link
      href="/sign-up"
      className={className}
      onClick={() => track({ name: "auth.signup_started" })}
    >
      {children}
    </Link>
  );
}
