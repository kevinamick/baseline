import { firstRow } from "@/lib/supabase/first-row";

/**
 * Normalize the embedded `organizations(name)` from a Supabase join. PostgREST
 * types a to-one embed as an array (no generated types here), though at runtime
 * it's a single object — `firstRow` collapses both, then fall back to a neutral
 * label.
 */
export function orgName(
  relation: unknown,
  fallback = "a team"
): string {
  const rel = firstRow(relation);
  const name = (rel as { name?: string | null } | null)?.name;
  return name ?? fallback;
}
