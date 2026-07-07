"use client";

import { PageError } from "@/app/_components/page-error";

export default function SchedulesError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageError reset={reset} width="wide" />;
}
