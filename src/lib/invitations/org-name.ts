/**
 * Normalize the embedded `organizations(name)` from a Supabase join. PostgREST
 * types a to-one embed as an array (no generated types here), though at runtime
 * it's a single object — handle both and fall back to a neutral label.
 */
export function orgName(
  relation: unknown,
  fallback = "a team"
): string {
  const rel = Array.isArray(relation) ? relation[0] : relation;
  const name = (rel as { name?: string | null } | null)?.name;
  return name ?? fallback;
}
