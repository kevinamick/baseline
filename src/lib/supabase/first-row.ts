/**
 * Collapse a Supabase/PostgREST result that may arrive as either a single value
 * or a single-element array down to that one row. Two shapes hit this:
 *  - an RPC (`.rpc(...)`) whose `data` comes back as a row-set or a scalar
 *    composite depending on the function's return type, and
 *  - a to-one embedded relation that PostgREST types (and sometimes returns) as
 *    an array even though at runtime it's a single object.
 *
 * We have no generated RPC/relation types here (`supabaseAdmin` is untyped, see
 * the typed-client OOM note), so the caller still narrows the row's fields
 * itself after collapsing the shape.
 */
export function firstRow<T>(
  value: T | readonly T[] | null | undefined,
): T | null | undefined {
  if (Array.isArray(value)) return value[0];
  // Array.isArray can't narrow out `readonly T[]` when T is itself unconstrained
  // (T might be an array type), so the non-array branch needs an explicit cast.
  return value as T | null | undefined;
}
