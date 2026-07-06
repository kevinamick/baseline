# Transient-failure retries live at the data-access seam

Transient gateway blips between the app and Supabase (the Kong↔PostgREST 502/503/504
class, plus network-level failures) were taking whole page renders to the route error
boundary (#395) because nothing in the app retried anything. We consider the app's
resilience to transient read failures a property of the **data-access seam**, not of
call sites or of a client-side data library.

**Decision.** Three rules, split by what the transport can prove about idempotency:

1. **Table reads retry at the fetch layer, automatically.** A single retrying `fetch`
   (the zero-dependency `fetch-retry` package supplying the loop; our code supplies the
   gate, classifier, and log) is injected into every **server-side** Supabase client —
   the service-role admin client (which `tenantDb` wraps) and the SSR user-session
   clients. It retries **GET/HEAD requests only**: PostgREST expresses every table read
   as GET/HEAD and every write as POST/PATCH/DELETE, so the safe/unsafe boundary is
   structural (HTTP method), not a convention a call site can forget. Auth (GoTrue)
   traffic is POST and passes through untouched.
2. **Read-only RPCs opt in explicitly.** PostgREST RPCs are all POST — the transport
   cannot distinguish `managed_spend_total` from `reserve_eval_points` — so RPC retries
   stay per-call-site via `readRpcOrThrow` (#395/PR #424), reserved for genuinely
   idempotent reads.
3. **Writes are never retried.** A lost response is indistinguishable from a lost
   request; blind write retries double-reserve points. Write resilience is explicit
   idempotency work, out of scope here.

**One policy, one definition.** Both seams share the same constants: one retry, 150 ms
flat delay, transient = 502/503/504 or a network-level rejection. Deliberately **not**
retried: 429 (the rate limiter speaking; retrying defeats it), 500 (as often a real bug
as a blip), and timeouts/hangs (fetch has no default timeout; adding one is a separate
decision). The policy is tuned for reads inside server-component renders, often under a
`Promise.all` — one short retry adds ~200 ms worst case to a blipped render; exponential
multi-retry would hold user-facing requests open against a degraded gateway. Every retry
emits a structured `warn` (#38), so blip frequency is queryable in PostHog and any policy
change is made on evidence.

**Scope boundaries.** The browser gets nothing (the app has zero client-side reads).
The worker gets nothing (its Supabase calls run inside Temporal Activities, which
already own retry policies — stacking a second retry underneath muddies Temporal's
backoff).

**Rejected alternatives.**
- *Migrate reads to TanStack Query* (the proposal that started this). TanStack's retry
  only reaches client-fetched data, and ~90% of Baseline's queries run in server
  components where it cannot execute. Getting retry that way meant SPA-ifying the app:
  ~30+ new read endpoints, per-endpoint re-solving of the tenant-isolation posture
  (#207 assumes server-side reads), and orphaning the RSC batching and `loading.tsx`
  skeleton work — architectural upheaval that still would not have protected the layer
  that was actually failing (#395 was a server-component read).
- *Per-call-site read wrappers everywhere.* Consistent with `readRpcOrThrow`'s opt-in
  philosophy, but dozens of sites of churn and every future read must remember it — a
  forgotten wrapper silently regresses to the brittleness being cured. Kept only where
  opt-in is unavoidable (POST RPCs).
- *Node's undici `RetryAgent`* (zero new dependencies). Its retryable-method default
  follows HTTP-spec idempotency (includes PUT/DELETE, which we refuse to retry against
  PostgREST) and it is Node-only, breaking silently if a wrapped client ever runs on an
  edge runtime. `fetch-retry` is runtime-agnostic and fetch-signature-compatible.

**Consequence to accept.** The retry is invisible at call sites — someone reading a
page's data fetching sees no retry code. The structured `warn` is the discoverability
mitigation; this ADR is the other half.
