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

// Matches the Kong↔PostgREST keep-alive connection-reuse race ("upstream
// prematurely closed connection...", "invalid response... from the upstream
// server") and the equivalent hosted-gateway 502/503/504 class — a transport
// blip, not a data or constraint error.
const TRANSIENT_RPC_ERROR = /upstream|gateway|\b50[234]\b/i;

const TRANSIENT_RETRY_DELAY_MS = 150;

/**
 * Like {@link rpcOrThrow}, but for read-only RPCs (#395): one re-attempt,
 * after a short backoff, when the failure looks like a transient gateway
 * blip rather than a real data error. Reserved for genuinely idempotent
 * reads — never for the reserve/ensure/settle mutation RPCs, where a lost
 * response can't be safely distinguished from a lost request. If the retry
 * also fails, the original error propagates unchanged.
 */
// Same justified default as `rpcOrThrow` above: `supabaseAdmin` is untyped, so
// the generic return is an unchecked `as T` cast via that call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readRpcOrThrow<T = any>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await rpcOrThrow<T>(fn, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!TRANSIENT_RPC_ERROR.test(message)) throw err;
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
    return rpcOrThrow<T>(fn, args);
  }
}
