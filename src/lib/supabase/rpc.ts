import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Invoke a Postgres RPC through the service-role admin client, throwing on its
 * error with the canonical `<fn> failed: <message>` wording every billing seam
 * uses (retention sweep, allowance/points ledger, managed-spend metering). This
 * collapses the repeated `const { data, error } = await supabaseAdmin.rpc(fn,
 * args); if (error) throw new Error(\`${fn} failed: ${error.message}\`)` block
 * to a single call.
 *
 * Returns the RPC's `data` payload (typically collapsed further with
 * {@link firstRow}); callers that only need the side effect can ignore it.
 *
 * NOTE: `supabaseAdmin` is deliberately untyped (typing it OOMs tsc), so the
 * generic return is an unchecked `as T` cast — same contract as the inline
 * call sites it replaces. Reserved for security-definer billing functions; sites
 * that surface the error to their caller (e.g. `settle*` returning `{ error }`)
 * intentionally stay inline.
 */
// The default generic is `any`, not `unknown`: `supabaseAdmin` is deliberately
// untyped (typing it OOMs tsc) so `.rpc()` data is `any`, and callers narrow the
// row themselves after collapsing it (see firstRow). This mirrors that contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rpcOrThrow<T = any>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as T;
}
