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
  to `{provider, status}`) cross-referenced against the per-provider `keySources` map built during
  resolution. A managed-key failure deliberately does NOT emit this event (it stays the generic
  provider error). NEVER log key material — only provider, `org_id`, and the HTTP status/error.

## Email theming

Report emails (eval-run in `src/emailer.ts`, optimization in `src/optimization-emailer.ts`)
use the Baseline Design System chrome via `src/email-layout.ts` (`wrapEmail` / `ctaButton` /
`EMAIL`). That file is a deliberate copy of the canonical app-tier source
`src/lib/email/templates/layout.ts` — the worker is independently Dockerized (the Dockerfile
copies only `worker/src`), so it cannot import from the app's `src/`. Keep the copy in sync
when the design system chrome changes. `wrapEmail`'s `previewText` is NOT escaped by the
wrapper, so HTML-escape any caller-supplied values before interpolating them.
