# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## BYO provider-key failures vs the Free fail-closed invariant

A run resolves ONE provider key per role (judge, and a Managed Agent's target) via
`resolveProviderKey`/`resolveEvalJudge` (`src/providers/resolve-key.ts`); the result's `source` is
`"byo" | "managed" | "none"`. Two rules ride on this:

- **No managed fallback on a runtime BYO failure.** Resolution happens exactly once. When a
  provider rejects a key mid-run (401/403/quota), the error propagates to `processMessage`'s catch
  and the run is marked failed — there is NO re-resolution to the managed platform key, for any
  plan. The Free invariant (a Free/unpaid Team with no BYO key resolves to `none`, ADR-0008) is
  enforced only at resolution time; do not add a "retry on managed" path anywhere, or a Free run
  would leak onto the platform key.

- **`provider_key.byo_failed` log.** The catch attributes a failed provider call to the customer's
  own key when its `source === "byo"`, via `classifyProviderError` (`src/providers/provider-error.ts`,
  which normalizes the fetch clients' `ProviderHttpError` and the Anthropic SDK's `Anthropic.APIError`
  to `{provider, status}`). Two call sites emit this event:
  - **Eval runs** (`processMessage` in `src/worker.ts`): a per-provider `keySources` map is built
    during resolution and consulted in the catch to distinguish BYO from managed failures.
  - **Optimization runs** (GEPA activities in `src/gepa/activities.ts`): each activity makes a
    single-provider call whose source is known at the call site, so no map is needed — the
    `logByoOptimizationKeyFailure` helper is called directly in each catch.
  A managed-key failure deliberately does NOT emit this event (it stays the generic provider error).
  NEVER log key material — only provider, `org_id`, and the HTTP status/error.

- **A managed run with no managed-spend reservation fails closed (#358/#292).** Whatever resolves
  to the managed key — the eval **judge** (#358), or a Managed Agent's **target** (#292) — is
  metered in dollars against the Managed Spend Cap, so its `ManagedMeter` must have been built from
  a reservation made *before* the worker ran it (interactive runs reserve at creation in
  `createEvalRun`; scheduled runs at the claim gate, `src/lib/billing/claim-gate.ts`). If
  `processMessage` reaches the call with `resolved.source === "managed"` but `meter === null`, it
  **throws and marks the run failed** rather than judging/invoking uncapped and *unmetered* — an
  unmetered managed call burns real tokens that never accrue to the ledger, so the Team is never
  charged. A fresh reserve on the schedule's next tick (or an interactive retry) then meters it.
  Do NOT relax these guards to "run anyway when the meter is null." The one case with no
  auto-recovery is the app↔worker key-resolution divergence — the app reads a `provider_keys` row
  as BYO while `resolveEvalJudge`/`resolveProviderKey` falls through to managed (e.g. an
  empty/whitespace secret) — where the guard keeps failing closed until the bad row is removed;
  full unification is tracked in #371.

## Email theming

Report emails (eval-run in `src/emailer.ts`, optimization in `src/optimization-emailer.ts`)
use the Baseline Design System chrome via `src/email-layout.ts` (`wrapEmail` / `ctaButton` /
`EMAIL`). That file is a deliberate copy of the canonical app-tier source
`src/lib/email/templates/layout.ts` — the worker is independently Dockerized (the Dockerfile
copies only `worker/src`), so it cannot import from the app's `src/`. Keep the copy in sync
when the design system chrome changes. `wrapEmail`'s `previewText` is NOT escaped by the
wrapper, so HTML-escape any caller-supplied values before interpolating them.

## Dataset-adapter subtree uses extensionless imports (#39)

Relative imports inside the dataset-adapter subtree — `src/adapters/{index,custom,posthog}.ts`
and their `safe-fetch.ts` / `template.ts` / `posthog-hosts.ts` / `ip-ranges.ts` deps — are
deliberately **extensionless**, not the worker's usual NodeNext `.js` specifiers. The Next app
reuses this exact seam for its "Test query" dataset preview and bundles it with Turbopack, which
does NOT resolve a `.js` specifier to its `.ts` source. Extensionless resolves identically under
the worker's tsx runtime, the `tsc` build, vitest, and Turbopack, so the seam stays one shared
definition with no behavior change. If you add a worker file to this app-reachable subtree, keep
its relative imports extensionless (type-only imports are stripped before bundling and may stay
`.js`). See the root `AGENTS.md` "Dataset Connections" section for the full rationale.
