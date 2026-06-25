"use client";

import { PageError } from "@/app/_components/page-error";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageError reset={reset} width="wide" />;
}
