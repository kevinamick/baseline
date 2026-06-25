"use client";

import { PageError } from "@/app/_components/page-error";

export default function BillingSettingsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageError reset={reset} width="narrow" />;
}
