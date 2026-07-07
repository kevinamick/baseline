import type { Metadata } from "next";
import { CategoryRoute, categoryMetadata } from "@/app/_components/category-route";

// Render on demand — the nonce-CSP root layout forces dynamic rendering; see
// category-route.tsx. ADR-0013's locale-set guard lives in that shared helper.
export const dynamic = "force-dynamic";

const SLUG = "rubric-based-evaluation";

export function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  return categoryMetadata(SLUG, params);
}

export default function Page({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  return <CategoryRoute slug={SLUG} params={params} />;
}
