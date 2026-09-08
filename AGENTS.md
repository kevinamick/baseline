<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Testing

Tests run on Vitest (`npm test`). The default environment is `node`. To test
DOM-related code — rendering a client component, firing user events, asserting on
the rendered output — use React Testing Library and opt the file into a jsdom
document with a docblock on the first line:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
```

jest-dom matchers (`toBeInTheDocument`, `toHaveValue`, `toHaveFocus`, …) are
registered globally via `vitest.setup.ts`, which also unmounts trees between tests.
See `src/app/_components/email-tags-field.dom.test.tsx` for a worked example.

## e2e consent-banner suppression (#334)

The persistent cookie-consent banner (#68) sits lower-left on every page and
intercepts clicks on left-column controls, so e2e specs must suppress it. This is
handled **suite-wide, once**: every Playwright spec imports `test`/`expect` from
`e2e/fixtures.ts` (not `@playwright/test`). Its auto fixture patches
`browser.newContext` for the duration of each test so the `analytics_consent=rejected`
cookie lands on **every** context — including fresh contexts a spec opens itself with
`browser.newContext()`, which do **not** inherit a role's saved `storageState`.
`global-setup.ts` bakes the same cookie (one definition: `consentCookie()` in
`fixtures.ts`) into each role's `storageState` — that cookie is all a storageState
carries now, since there is no sign-in (ADR-0020) and every context is the Workspace's
Contributor. Do **not** re-add per-spec consent patches — that whack-a-mole is what
this replaced. A spec that must actually SEE the banner opts out with
`test.use({ suppressConsentBanner: false })` (see the localization first-time-visitor
spec). When you add a new spec, import `test` from `./fixtures`.
# Loading boundaries

Every dynamic, auth-gated route must have a `loading.tsx` that renders instantly — no async work. Inside the `(app)` route group the `NavBar` lives in the persistent `layout.tsx`, so it stays painted across navigation and a route's `loading.tsx` only replaces the content slot *below* it. Use `PageSkeleton` and `SkeletonBlock` from `@/app/_components/page-skeleton` for standard `wide` (1360 px app surfaces) and `narrow` (2xl settings column) frames — `PageSkeleton` renders just the content frame (the `flex-1` child), **not** a nav placeholder.

If a route owns its own chrome (no app nav — e.g. the rubric detail page outside the `(app)` group), write a bespoke skeleton in that route's `loading.tsx` and use `NavBarSkeleton` from `page-skeleton` as a static nav stand-in if it needs one. **Never** render the real `<NavBar/>` in a `loading.tsx`.
# App nav (NavBar)

`NavBar` (`@/app/_components/nav-bar`) is a Client Component. It sources the Workspace name and plan from the `AuthProvider` context (`@/app/_components/auth-context`) rather than awaiting `getAuthContext()` itself. There is no sign-in, org switcher, or account menu (ADR-0020): `getAuthContext()` (`src/lib/auth/context.ts`) always resolves the one Local Workspace (`src/lib/auth/local-workspace.ts` holds its fixed ids) with write access, and `src/proxy.ts` gates nothing — it only stamps the request id + CSP nonce and runs locale routing.

The nav is rendered **once**, by the `src/app/[locale]/(app)/layout.tsx` route-group layout — *not* by individual pages. Because a `layout.tsx` is preserved when you navigate between its child routes, the nav stays mounted and does not re-render or re-fetch auth on each transition. The layout seeds the provider:

```tsx
// src/app/[locale]/(app)/layout.tsx
import { AuthProvider } from "@/app/_components/auth-context";
import { NavBar } from "@/app/_components/nav-bar";
import { resolveNavAuth } from "@/lib/auth/nav";

const navAuth = await resolveNavAuth(); // resolved once on group entry, reused across navigation
// ...
<AuthProvider {...navAuth}>
  <NavBar />
</AuthProvider>
```

App surfaces belong **inside** `(app)/` so they inherit this shell; each page returns its content as the `flex-1` child of the layout's `min-h-[100dvh] flex-col` column. Do **not** add `<NavBar/>` back into a page — that re-mounts it on every navigation, the regression this layout removes. A focused route that must escape the app nav (e.g. `rubrics/[id]`) lives *outside* the group with its own chrome.

`resolveNavAuth()` is `server-only`; node-environment tests that import a page from inside `(app)/` don't touch the layout, so they no longer need to mock it.

# Eval-run execution: Temporal is the sole path (#123, ADR-0006)

Eval runs execute **only** as the durable Temporal workflow `runEvalWorkflow`
(`worker/src/evalrun/`) — there is no pgmq execution path and no feature flag. Interactive runs:
`createEvalRun` (`src/app/actions/eval-runs.ts`) reserves points + managed spend, stamps
`eval_runs.workflow_id` (`eval-<runId>`), and starts the workflow via `getTemporalClient()`.
Scheduled runs: `pg_cron` → `enqueue_eval_run` → pgmq stays the **scheduling broker only**, and
the worker's poll loop is a thin **dispatcher** that starts `runEvalWorkflow` and acks (pg_cron
can't call Temporal). All eval execution + billing lives in the workflow's Activities — judge/
target key resolution (`resolveEvalJudge`), managed metering (`createManagedMeter`, fail-closed per
#358/ADR-0008), the claim-time reserve gate (`claimReserve`, #199) in `prepareEvalRun` for scheduled
runs, and point settlement (`settle_eval_run_points` + `release_managed_reservation`) on every
terminal outcome. The judge fan-out is `evaluateRun`'s existing `mapWithConcurrency` at
`JUDGE_CONCURRENCY` — do not add another. Full detail in `worker/AGENTS.md`.

# LLM providers (#184, #204, ADR-0020)

Anthropic, OpenAI, Google, and Mistral are all runtime-wired. The worker has one client per
provider behind `LLMProvider`/`RuntimeProvider` (`worker/src/providers/{anthropic,openai,google,mistral}.ts`);
never `new XProvider()` at a call site — go through `createProviderForModel(model, …)`
(`worker/src/providers/factory.ts`), which picks the client by `providerForModel()`.
OpenAI/Google/Mistral are fetch-based against a fixed literal host (#222) — no SDK. They share the
judge/propose/complete control flow in `FetchProvider` (`worker/src/providers/fetch-provider.ts`);
each provider file is just a `ProviderAdapter`. An operator-only `*_API_BASE_OVERRIDE` env var may
point a client at a mock/proxy in dev/test.

**Keys (ADR-0020).** There is no managed key and nothing is metered. A provider's key resolves
identically in the app (`src/lib/llm/key-gate.ts`: `resolveKeySource`/`resolveKeySources`) and
the worker (`worker/src/providers/resolve-key.ts`): a USABLE Vault key saved under Settings →
Provider keys wins, else the operator's env var named in `PROVIDER_KEY_ENV`
(`worker/src/providers/registry.ts`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
`MISTRAL_API_KEY`), else `none` and the run fails closed with copy naming the missing key
(`missingKeyError`). "Usable" means non-empty after trim; a stored-but-blank secret falls through
to the env var, never counts as a key. The app process needs the same env vars as the worker to
know a provider is usable.

A run is **single-provider**: judge, reflect/generation, and a Managed Agent's target call each
resolve their own key via `providerForModel(model)`, and the judge model follows the run's
reflect-model provider (`defaultJudgeModelForProvider`). Eval runs have no per-run model, so the
judge runs on whichever runtime-ready provider has a key (`resolveEvalJudge`, Anthropic first).
`createEvalRun` refuses before creating a row when no runtime-ready provider has a key
(`evalRunBlockedForMissingKey`); `startOptimizationRun` checks the run's reflect provider and a
Managed Agent's target provider independently. Managed Agent target models stay Anthropic-only
for now.

**The provider/model registry is ONE definition, not a mirror (#379).** `worker/src/providers/
registry.ts` is the single source for provider ids, labels, runtime-readiness, key-format
patterns, per-provider model lists, and the judge/reflect defaults. It has deliberately **zero
relative imports**, so the app imports it directly (thin re-export shims at `src/lib/llm/
providers.ts` / `src/lib/llm/model-prices.ts` / `src/lib/llm/keys.ts`, plus
`src/lib/optimization/models.ts` for the wizard's UI-presentation layer). Adding a model/provider
means editing the registry's Records plus a migration widening the `provider_keys.provider` CHECK
constraint and (for a provider) its adapter in `worker/src/providers/factory.ts`. The registry's
`defaultJudgeModelForProvider`/`defaultReflectModelForProvider` read `process.env.ANTHROPIC_MODEL`
and are Node-only — never import them into app code reachable by a client bundle; use the plain
`DEFAULT_JUDGE_BY_PROVIDER`/`DEFAULT_REFLECT_BY_PROVIDER` Records there instead.

**The optimization wizard can pick a provider's LIVE model list (#485).** For each usable
provider, `src/lib/llm/live-models.ts` (server-only) lists the models the provider currently
serves with the Workspace's key (Vault or env), filtered through the shared chat-capable policy
(`worker/src/providers/model-filter.ts`). Progressive enhancement: a ~3s timeout, a short per-
org+provider cache (model ids only), and ANY failure → empty list → exactly the curated wizard.
The wizard submits `reflectProvider` explicitly; `createOptimizationRun` re-validates the pair
server-side and stamps nullable `optimization_runs.reflect_provider`. The worker reads it via
`reflectProviderForRun` (`worker/src/gepa/run-provider.ts`), falling back to `providerForModel()`
when null. e2e mocks the list endpoints via the override seam (`e2e/provider-models-mock-server.mjs`).

# Dataset Connections: worker adapter seam reused in the app (#39)

The worker's dataset adapter seam — `getDatasetAdapter(provider)` over
`customDatasetAdapter`/`posthogDatasetAdapter` in `worker/src/adapters/` — is the single
definition of "fetch + map historical rows" for both the scheduled worker run AND the schedule
wizard's inline **"Test query"** preview. The preview runs the adapter once from a Next **server
action** (`previewDatasetConnection` in `src/app/actions/connections.ts` →
`runDatasetPreview` in `src/lib/connections/preview.ts`), bounded to the last
`PREVIEW_WINDOW_MINUTES` with `PREVIEW_MAX_ROWS` and a `PREVIEW_TIMEOUT_MS` race
(`src/lib/connections/preview-types.ts`). It does NOT re-implement any fetch logic, and the
worker runtime is untouched — the app imports the worker's seam across the package boundary, the
same direction `endpoint.ts`/`posthog-host.ts` already import `worker/src/ip-ranges` /
`worker/src/adapters/posthog-hosts`. Because the adapter calls `safeFetch` internally, the
preview inherits the worker's full SSRF egress guard + PostHog host allowlist (it is not a new
request-proxy surface), and typed credentials ride the server-action call transiently — never
persisted, never returned to the browser.

**Sharp edge:** relative imports inside the dataset-adapter subtree
(`adapters/{index,custom,posthog}.ts`, `safe-fetch.ts` → `ip-ranges`) are deliberately
**extensionless**, unlike the worker's usual NodeNext `.js` specifiers. The app bundles this
subtree with **Turbopack** (the Next 16 default), which — unlike the worker's tsx runtime — does
**not** resolve a `.js` specifier to its `.ts` source, and `experimental.extensionAlias` is
unsupported under Turbopack. Extensionless resolves identically under tsx, the worker `tsc`
build, vitest, and Turbopack, so the seam stays one shared definition. If you add a worker file
to this app-reachable subtree, keep its relative imports extensionless (type-only imports like
`import type … from "../agent.js"` are stripped before bundling and may stay `.js`).

# Guided first-run onboarding (#331, #332)

There is no `/onboarding` route (ADR-0020): the Local Workspace always exists, so the only
first-run guidance is the `/rubrics` tutorial below.

The `/rubrics` first-run tutorial is **purely derived from live data** — no persisted onboarding
state, no flag, no schema. Steps are a list of `{id, target, isSatisfied(data)}`
(`(app)/rubrics/_components/onboarding/steps.ts`); the active step is the first unsatisfied one,
and the "Getting started" card + the active coach-mark vanish once every step is satisfied. Add a
step by appending to `RUBRIC_ONBOARDING_STEPS` and its i18n copy under `Rubrics.onboarding.steps.*`
in all three catalogs — the card count and active-step logic need no rework.

The tutorial has three steps (`ONBOARDING_STEPS` in `steps.ts`, ADR-0020): **addProviderKey**
(satisfied at `providerKeyCount >= 1`) leads, then **createRubric** (satisfied at `rubricCount >=
1`, coach-mark on the rubrics-panel New control), then **runEval** (satisfied at `runCount >= 1`,
coach-mark on the runs-panel Run Eval control). There is no managed fallback, so the key step
comes first and the ordering makes the rubric/eval coach-marks wait until a key exists.
`OnboardingData` carries all three counts, seeded by `page.tsx`; `providerKeyCount` is
`countUsableProviders` (`key-gate.ts`) — runtime-ready providers with a Vault key OR an env key,
so a key set only in the worker environment ticks the step too. The eval step ticks on **run
created (submit), any status** — not completion — so
a slow or failed first run still completes the tutorial; `createEvalRun` calls
`revalidatePath("/rubrics")` so the new run flows into the derived count (mirrors `createRubric`).
The **key step is the one step with no `/rubrics` control to anchor to** (provider keys live at
`/settings/team`), so its coach-mark pins to an in-card CTA that opens the **existing `SetKeyDialog`**
(exported from `provider-keys-list.tsx`, reused not rebuilt) inline for the first runtime-ready
provider without a key — no navigation; on save `router.refresh()` flows the new key into the
derived count. When the
runEval step is satisfied the runs-panel swaps the Run Eval coach-mark in place (same pill anchor)
to a "your eval is running, results appear here" confirmation (`runEval.doneTitle` /
`runEval.doneMark`): the runs-panel records the first guided run's **id** and derives the
confirmation from whether that specific run is still the active (queued/running) one, so it
self-dismisses when the run finishes or fails and cannot replay for a later run in the same session
(a subsequent run has a different id). No persisted state; keying on the id (not a sticky boolean)
is deliberate — a boolean that only ever flips true replays the confirmation for the next run. Anchor coach-marks to pill-shaped controls; the `CoachMark`
spotlight ring is `rounded-full` and wrapping a `flex-1`/`truncate` element (e.g. the panel `<h2>`)
in its `inline-flex` span would drop those constraints and break layout for everyone.

Because progress is derived, the card must NOT vanish optimistically the instant the final step
flips satisfied. The card gates its visibility through `useLingeringVisibility`
(`onboarding/use-lingering-visibility.ts`, a `useDeferredValue` wrapper): it lingers through the
current render (briefly showing the completed checklist, hence the `active`-may-be-null guard in
the card body) and falls away only on the next render after data revalidation. A Team that already
had a rubric on first paint still never flickers it in (the deferred initial value is hidden).

`OnboardingProvider` (`onboarding/onboarding-context.tsx`) seeds the tutorial from `data` and is
**gated to writers**: `canWrite === false` collapses it to inactive, so Readonly Members never see
it. The provider wraps both the card and `RubricsLayout` so the deep create control can read the
active step via `useCoachMarkActive(target)`.

`CoachMark` (`src/app/_components/coach-mark.tsx`) is the reusable primitive, styled per the
Baseline Design System coach-mark handoff: it wraps a target, paints a cobalt spotlight ring on it
(`.coach-spotlight` in `globals.css` — `box-shadow` outline + halo built from `--accent-rgb`, so it
tracks light/dark; no scrim), and portals a `title` + `message` popup with a pointer arrow to
`document.body` so it escapes `overflow-hidden` ancestors. The popup rides the dark `bg-ink-soft`
focus surface (`text-white` title, `text-fg-on-ink-muted` body, `rounded-[20px]`, `shadow-xl`, 14px
rotated-square arrow) and enters via the system `form-reveal`. In light mode shadow + value contrast
against the cream paper separate it (no border, per the handoff); in **dark mode** the surface would
blend into the dark page, so a 1px dark-hairline edge (`dark:border dark:border-hairline`, with the
arrow carrying it on its two exposed tip edges) defines it — dark-mode only, light mode unchanged. It is `pointer-events-none` — no
dimming, scrim, overlay, modal trap, or dismiss control; the page (and the highlighted control) stays
fully interactive, and the coach-mark goes away only when its derived step is satisfied (#331 keeps
the visual language but NOT the handoff's multi-step tour chrome: no Skip/Next/✕, no step counter,
no persisted `seen` state).

A coach-mark must never sit on top of a modal, so it subscribes to a tiny global modal registry
(`src/app/_components/modal-presence.ts`): the shared `Dialog` shell calls `openModal()` on mount,
and `CoachMark` reads `useAnyModalOpen()` to drop both its popup and target ring while any dialog is
open, restoring (and re-measuring) them on close. Any new full-screen overlay that isn't built on
`Dialog` should call `openModal()` itself to stay clear of non-modal chrome.

# Tenant-isolation lint guard (#207)

Tenant isolation is app-code-only (service-role client, RLS enabled with no policies), so a
raw `supabaseAdmin.from("<tenant table>")` with a forgotten `.eq("org_id", …)` is a silent
cross-tenant leak. A `no-restricted-syntax` rule bans that call shape in `src/**` (tests
exempt) — go through `tenantDb(ctx)`. Sites that genuinely can't (PostgREST embed selects,
trusted-`orgId`-param libs like `claim-gate`/`connections/create`, the user-scoped GDPR
export) carry an `eslint-disable-next-line no-restricted-syntax -- <reason>`; any new raw
use needs the same justified disable. The table list lives in `eslint.tenant-guard.mjs`
(ESLint config can't import the TS tuple) and is held equal to `TENANT_SCOPED_TABLES` by
`src/lib/supabase/__tests__/tenant-lint-guard.test.ts` — adding a table to `tenantDb` fails
that test until the guard list is updated too. `e2e/authz.spec.ts` carries symmetric
cross-tenant list/detail probes (Team A ↔ Team B) as the runtime backstop for the same bug
class.

# Rubric editor caps & per-field validation (#352)

The rubric editor (`(app)/rubrics/_components/rubric-dialog.tsx`) caps criteria-per-rubric and
steps-per-criterion at the server schema's bounds (`RUBRIC_MAX_CRITERIA` /
`RUBRIC_MAX_STEPS_PER_CRITERION` in `src/lib/validation/schemas.ts`, the one definition). There
are no plan tiers (ADR-0020). At the cap the "Add criterion"/"Add step" buttons disable and the
`editor.criteriaMax` / `editor.stepsMax` message shows; `applyTemplate` silently truncates an
over-cap template to the limit.

Validation is per-field: Zod flattens nested array errors onto a single `criteria` key, so
`parseCriterionErrors` reconstructs the issue paths (`["criteria", ci, "name" | "weight" | "steps",
si]`) into per-criterion / per-step messages rendered inline with `border-danger` + `aria-invalid`
on the offending input, and `focusFirstError` scrolls to that specific input rather than the whole
criteria section. Per-element messages are stripped from the section-level `criteria` key to avoid
duplicates; the weight schema carries user-facing 0–1 messages.

# i18n message catalogs (en/es/fr)

Three catalogs — `messages/{en,es,fr}.json` — must stay in **key parity**. `en` is
authoritative for copy; `es`/`fr` translate the same key shape. A key a component calls
that's absent from a locale doesn't fail the build — next-intl renders the raw key path (or
a missing-message error) at runtime, so the gap only shows in the rendered UI. Mind
`useTranslations(scope)` nesting when auditing: a call like `t("create.button")` under
scope `Settings.connections` resolves to `Settings.connections.create.button`.

Guard the regression where you add keys: a DOM test can rethrow on missing messages
(`NextIntlClientProvider onError` → throw when `error.code === "MISSING_MESSAGE"`) so a
render exercises every key it touches, and a node test can assert es/fr carry every leaf
key `en` defines for a subtree. The connections feature has both
(`connections-list.dom.test.tsx`, `connections-i18n.test.ts`); copy that pattern for new
catalog-backed surfaces.

# Structured logging & correlation (#38)

The app and worker each have a best-effort structured logger over PostHog Logs that
NEVER throws — `log.{info,warn,error}(message, attributes)` (app:
`src/lib/logging/server.ts`; worker: `worker/src/log.ts`). Attribute flattening is the
one cross-service contract, defined once in `worker/src/log-attributes.ts`
(`flattenAttributes`) and imported by both loggers — fix flattening there, never in
either logger. The reserved `error` attribute key is special-flattened (an `Error` →
`error_message`/`error_stack`; a Supabase/Postgres-style object keeps whitelisted fields).
The console mirror is left byte-for-byte the caller's attributes; correlation lives only
on the queryable OTel record.

**Auto-correlation, zero call-site threading.** Records are stamped with correlation ids
the caller never passes, and an explicit attribute always wins over the ambient value:
- *App* — `request_id` (the `x-request-id` the proxy mints in `src/proxy.ts`, read from
  `next/headers`), plus `org_id` and `user_id` seeded into a per-request `cache()`-backed
  store (`src/lib/logging/request-context.ts`) by the single auth seam `getAuthContext()`
  (`user_id` as soon as identity resolves, `org_id` once membership does). Reads are
  best-effort: outside a request scope (background jobs, instrumentation, static prerender)
  the stamp is simply omitted.
- *Worker* — see `worker/AGENTS.md`: an AsyncLocalStorage run scope auto-stamps
  `run_id`/`opt_run_id`/`org_id`. Keep the two loggers' stamped-attribute sets aligned so
  app↔worker logs filter by the same tenant uniformly.

**Unhandled server errors** also flow to Logs as a structured `error` record via the Next
`onRequestError` hook (`src/instrumentation.ts`), correlated by the request's
`x-request-id` (read off the request headers, since the hook runs outside the request
scope `getAuthContext` reads from) plus route path/method — in addition to the existing
PostHog error tracking, so a `request_id` pivots from a log line to its other logs.

**Internal route auth.** The three cron/worker-triggered routes under `/api/internal/*`
(retention, managed-threshold, claim-reserve) share one gate,
`requireInternalSecret(req, ENV_VAR, route)` (`src/lib/auth/internal-secret.ts`): no
secret configured → 503, wrong/absent `Bearer` → 401, each refusal emitting a structured
`warn` keyed by `route`. Use it for any new internal route; don't reinvent the check.

**`after()` for attacker-reachable / high-volume log paths.** Failure logs on
unauthenticated or high-volume paths (the internal-secret refusals) are deferred with
`after()` from `next/server` so the warn-level PostHog flush stays off the response's
critical path while the runtime still awaits it — a bare `void` could be dropped on a
serverless freeze. Never log PII.

# Consent-gated GA4 tag (#448)

`GoogleAnalytics` (`src/app/_components/google-analytics.tsx`), mounted once in the root
`[locale]/layout.tsx` next to `OrgJsonLd`, loads `gtag.js` site-wide (same footprint as PostHog
and `CookieConsent` — there's no existing "marketing route" grouping to scope it to a subset of
routes, and the runbook's SEO-surface framing doesn't require one; scoping later needs a
route-group seam that doesn't exist yet). It renders **nothing at all** — no `<script>`, no
request to `googletagmanager.com`/`google-analytics.com`, no `_ga`/`_ga_*` cookie — unless BOTH:
`NEXT_PUBLIC_GA_MEASUREMENT_ID` is configured (build-time inlined, unset is the only off switch
for local/e2e/staging, no mock/override backdoor) AND the visitor has accepted analytics.

Unlike the PostHog client init (`instrumentation-client.ts`, a browser entrypoint that reads
`document.cookie`), `GoogleAnalytics` is an **async Server Component** that decides before any
HTML reaches the browser: `analyticsAllowedOnServer()` (`src/lib/consent/server.ts`) reads the
same `analytics_consent` cookie via `next/headers` `cookies()` rather than the client-side
`analyticsAllowed()` (`src/lib/consent/cookie.ts` — both share `isConsentChoice`, exported for
this reuse). The cookie-consent banner already does a full `location.reload()` on any
accept/reject toggle (`cookie-consent.tsx`), so this server-side check re-runs and picks up a
fresh choice with no client-side wiring of its own — no live/no-reload toggle to build. The
loader + config `<script>` tags carry the per-request nonce (`x-nonce` via `headers()`), same
pattern as `ThemeScript`/`JsonLd`.

CSP (`src/lib/security/csp.ts`): `script-src`/`connect-src`/`img-src` admit the wildcarded
`https://*.googletagmanager.com` / `https://*.google-analytics.com` hosts (covers Google's
regional collect subdomains) **only when `NEXT_PUBLIC_GA_MEASUREMENT_ID` is configured** —
mirroring the Supabase-origin conditional above it, so an environment with the tag off doesn't
even allow-list a host it never talks to. This is defense-in-depth on top of, not a substitute
for, the consent gate: consent (not the CSP) is what keeps the request from firing once the tag
IS configured.

e2e (`e2e/consent.spec.ts`) mirrors the pre-existing `POSTHOG_CONFIGURED` pattern with a
`GA_CONFIGURED = !!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID` gate: CI's `e2e` job env (unlike
even the optional `NEXT_PUBLIC_POSTHOG_KEY`) doesn't set this var, so the "GA fires after
Accept" network-positive assertion only runs where a local build set it — a documented,
accepted coverage gap for the positive path in CI, same shape as PostHog's pre-existing one. The
negative assertions (no GA request with no consent decision, and never after Reject) hold
unconditionally either way, and every GA-host request is routed through a `page.route()`
intercept that fulfills locally — the suite never lets a request reach real Google.
