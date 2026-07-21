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
`browser.newContext()` (new signups, isolated Free-team flows), which do **not**
inherit a pre-authenticated role's saved `storageState`. `global-setup.ts` bakes the
same cookie (one definition: `consentCookie()` in `fixtures.ts`) into each role's
`storageState`. Do **not** re-add per-spec consent patches — that whack-a-mole is what
this replaced. A spec that must actually SEE the banner opts out with
`test.use({ suppressConsentBanner: false })` (see the localization first-time-visitor
spec). When you add a new spec, import `test` from `./fixtures`.
# Loading boundaries

Every dynamic, auth-gated route must have a `loading.tsx` that renders instantly — no async work. Inside the `(app)` route group the `NavBar` lives in the persistent `layout.tsx`, so it stays painted across navigation and a route's `loading.tsx` only replaces the content slot *below* it. Use `PageSkeleton` and `SkeletonBlock` from `@/app/_components/page-skeleton` for standard `wide` (1360 px app surfaces) and `narrow` (2xl settings column) frames — `PageSkeleton` renders just the content frame (the `flex-1` child), **not** a nav placeholder.

If a route owns its own chrome (no app nav — e.g. the rubric detail page outside the `(app)` group), write a bespoke skeleton in that route's `loading.tsx` and use `NavBarSkeleton` from `page-skeleton` as a static nav stand-in if it needs one. **Never** render the real `<NavBar/>` in a `loading.tsx`.
# App nav (NavBar)

`NavBar` (`@/app/_components/nav-bar`) is a Client Component. It sources the signed-in identity, active org, and switchable orgs from the `AuthProvider` context (`@/app/_components/auth-context`) rather than awaiting `getAuthContext()` itself.

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

Auth-gated app surfaces belong **inside** `(app)/` so they inherit this shell; each page returns its content as the `flex-1` child of the layout's `min-h-[100dvh] flex-col` column. Do **not** add `<NavBar/>` back into a page — that re-mounts it on every navigation, the regression this layout removes. A focused route that must escape the app nav (e.g. `rubrics/[id]`) lives *outside* the group with its own chrome.

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

# LLM providers (#184, #204)

Anthropic, OpenAI, Google, and Mistral are all runtime-wired. The worker has one client per
provider behind `LLMProvider`/`RuntimeProvider` (`worker/src/providers/{anthropic,openai,google,mistral}.ts`);
never `new XProvider()` at a call site — go through `createProviderForModel(model, …)`
(`worker/src/providers/factory.ts`), which picks the client by `providerForModel()`.
OpenAI/Google/Mistral are fetch-based against a fixed literal host (the managed-key host-pinning
guarantee, #222) — no SDK. They share the judge/propose/complete control flow in `FetchProvider`
(`worker/src/providers/fetch-provider.ts`); each provider file is just a `ProviderAdapter` (host,
headers, request body, response parsing). To add a fetch provider, write its adapter + a one-line
subclass — don't re-copy the loop. The host literal is the production default; an operator-only
`*_API_BASE_OVERRIDE` env var (e.g. `GOOGLE_API_BASE_OVERRIDE`) may point a client at a
mock/proxy in dev/test without weakening #222 (tenants can't set worker env vars).

A run is **single-provider**: judge, reflect/generation, and a Managed Agent's target call each
resolve their own key via `providerForModel(model)`, and the judge model follows the run's
reflect-model provider (`defaultJudgeModelForProvider`). So a Team's OpenAI/Google key drives the
whole optimization run.

**Eval runs are provider-aware for BYO keys** (`resolveEvalJudge` in `worker/src/providers/
resolve-key.ts`): an eval has no per-run model, so the judge runs on whichever runtime-ready
provider the Team has a BYO key for (Anthropic wins when several exist), at the Team's cost — a
Free Team with only an OpenAI key judges on OpenAI. A paid Team with **no** BYO key falls back to
the managed Anthropic key (the platform bears the cost, so managed judging pins to the one provider
we price). The eval-run key gate (`src/lib/llm/key-gate.ts`) therefore admits any runtime-ready key,
not Anthropic specifically. Managed Agent **target models stay Anthropic-only** for now; the eval
path resolves the target key independently of the judge (so a BYO-OpenAI judge can coexist with a
managed-Anthropic target), and meters the judge and the target separately — each only when its own
key is managed. Widening `TARGET_MODELS` still needs target-side provider plumbing.

Worker metering needs a managed-spend reservation made *before* the run, so the app reserves the
managed-judge term for **every** eval run — interactive (`createEvalRun`) and scheduled (the claim
gate, `src/lib/billing/claim-gate.ts`) alike, dataset and external-agent runs included, not just
Managed Agents. The byo/managed reserve decision uses `resolveJudgeKeyModeForEstimate`
(`src/lib/llm/key-gate.ts`), which mirrors `resolveEvalJudge` across **every** runtime-ready
provider (any usable BYO key → BYO), so a BYO-non-Anthropic Team isn't over-reserved managed dollars
for a run the worker meters as BYO; the managed-spend *estimate* still prices the Anthropic judge
(managed judging pins to Anthropic). A managed judge that reaches the worker with no reservation
**fails closed** rather than judging unmetered (#358) — see `worker/AGENTS.md`.

**Key resolution is unified app↔worker (#371).** The app's `hasRuntimeProviderKey`/
`isSecretUsable` (`src/lib/llm/key-gate.ts`) and the worker's `firstUsableByoProvider`/
`readUsableByoKey` (`worker/src/providers/resolve-key.ts`) apply the identical precedence: scan
`RUNTIME_READY_PROVIDERS` (the shared registry, not the full `LLM_PROVIDERS` list) in order, and a
`provider_keys` row counts as BYO only when its Vault secret is non-empty after trim — a row that
exists but is blank is skipped, falling through to the next runtime-ready provider's row rather
than stopping there. So a Team with an empty/whitespace-secret Anthropic row plus a usable OpenAI
row resolves BYO-on-OpenAI identically on both sides (previously the worker's judge discovery
stopped at the first provider with ANY row and gave up as soon as that row proved unusable,
diverging from the app's any-usable-key estimate). The per-provider path
(`resolveKeyModeForEstimate`, the Managed-Agent target term) got the same usability treatment, so
neither key-mode resolver in the app ever waves through a stored-but-unusable secret as BYO.

**The provider/model registry is ONE definition, not a mirror (#379, first tracer bullet of
#93).** `worker/src/providers/registry.ts` is the single source for provider ids, labels,
runtime-readiness, BYO key-format patterns, per-provider model lists, `MODEL_PRICES`, and the
judge/reflect defaults — every fact previously hand-mirrored across `worker/src/providers/
{provider-list,models,model-prices}.ts` and their app-side copies (`src/lib/llm/providers.ts`,
`src/lib/llm/model-prices.ts`, `src/lib/optimization/models.ts`) now lives here once. It has
deliberately **zero relative imports**, so the dataset-adapter seam's extensionless-import sharp
edge (below) never applies to it — the app imports it directly (thin re-export shims at
`src/lib/llm/providers.ts` / `src/lib/llm/model-prices.ts` / `src/lib/llm/keys.ts`, plus
`src/lib/optimization/models.ts` for the wizard's UI-presentation layer over it), and the
worker's own modules import it too. The cross-package parity tests this replaced are gone — there
is nothing left to keep in lockstep. Adding a model/provider means editing the registry's Records
(TS refuses to compile until every `Record<LlmProvider, …>` has the new key) plus a migration
widening the `provider_keys.provider` CHECK constraint and (for a provider) its adapter in
`worker/src/providers/factory.ts`. The registry's `defaultJudgeModelForProvider`/
`defaultReflectModelForProvider` read `process.env.ANTHROPIC_MODEL` and are therefore Node-only —
never import them into app code reachable by a client bundle; use the plain
`DEFAULT_JUDGE_BY_PROVIDER`/`DEFAULT_REFLECT_BY_PROVIDER` Records there instead (both re-exported
client-safe from `src/lib/llm/model-prices.ts`). An unpriced managed call fails closed (ADR-0008).

**BYO Teams can pick a provider's LIVE model list in the optimization wizard (#485).** For each
provider whose key mode is **BYO**, `src/lib/llm/live-models.ts` (server-only) lists the models the
provider currently serves — with the Team's own Vault key, NEVER the managed platform key (managed
selection stays curated-registry-only) — filtered through the shared chat-capable policy
(`worker/src/providers/model-filter.ts`, one definition with the #484 detection bot; import-free,
so app-importable). Progressive enhancement: fixed literal hosts honoring the operator-only
`*_API_BASE_OVERRIDE` env vars, a ~3s timeout, a short per-org+provider cache (model ids only,
never key material), and ANY failure → empty list → exactly the curated wizard. The wizard appends
live ids (raw id + "latest from provider" marker) to that provider's optgroup and submits
`reflectProvider` explicitly; `createOptimizationRun` **re-validates the pair server-side**
(registry membership for that provider, or the live list re-fetched with the Team's key) and stamps
nullable `optimization_runs.reflect_provider`. The worker reads it via `reflectProviderForRun`
(`worker/src/gepa/run-provider.ts`) for key resolution + judge-model derivation, falling back to
`providerForModel()` when null — old rows and registry models behave exactly as before (an unknown
model with no stored provider still falls back to Anthropic). The provider clients accept a
non-registry reflect model only with `allowUnlistedReflectModel` (set only when the run carries a
stored provider); a registry model of ANOTHER provider still falls back. If the BYO key vanishes
before execution, resolution falls to managed and the unpriced model fails closed per ADR-0008 with
copy naming the provider-key requirement. e2e mocks the list endpoints via the override seam
(`e2e/provider-models-mock-server.mjs`, static per-provider behavior; Team D is the BYO fixture).

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

`/onboarding` is strictly the **"no Team yet"** route (#334): the top of
`onboarding/page.tsx` does `if (orgId) redirect("/rubrics")`, so an existing-Team user cannot
navigate back to it. A Team's existence is the completion signal — no persisted onboarding flag.
The page now only renders the create-team form and pending-invitation acceptance for orgless users;
`createOrganization` (`src/app/actions/orgs.ts`) redirects a freshly created Team straight to
`/rubrics`. The old free-plan provider-key prompt that used to live here is gone — free Teams get
the key step inside the `/rubrics` tutorial instead (#333).

The `/rubrics` first-run tutorial is **purely derived from live data** — no persisted onboarding
state, no flag, no schema. Steps are a list of `{id, target, isSatisfied(data)}`
(`(app)/rubrics/_components/onboarding/steps.ts`); the active step is the first unsatisfied one,
and the "Getting started" card + the active coach-mark vanish once every step is satisfied. Add a
step by appending to `RUBRIC_ONBOARDING_STEPS` and its i18n copy under `Rubrics.onboarding.steps.*`
in all three catalogs — the card count and active-step logic need no rework.

The tutorial is **plan-aware** (#333): a **paid** Team gets two steps — **createRubric** (satisfied
at `rubricCount >= 1`, coach-mark on the rubrics-panel New control) then **runEval** (satisfied at
`runCount >= 1`, coach-mark on the runs-panel Run Eval control). A **free** Team gets three, led by
**addProviderKey** (satisfied at `providerKeyCount >= 1`) — free Teams have no managed-key fallback,
so they must add a BYO key before any eval runs, and ordering (`onboardingStepsForPlan(isFreePlan)`
in `steps.ts`) makes the rubric/eval coach-marks wait until a key exists. The card count reflects
the plan (3 free / 2 paid). `OnboardingData` carries all three counts, seeded by `page.tsx` from the
org-scoped rubric + eval-run + `getProviderKeyRows` reads; `providerKeyCount` counts only
**runtime-ready** keys (`hasKey && runtimeReady`), so a key for a not-yet-wired provider doesn't tick
the step; `isFreePlan` is `plan === "free"` off `getBillingState`. The eval step ticks on **run created (submit), any status** — not completion — so
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

# Rubric editor tier caps & per-field validation (#352)

The rubric editor (`(app)/rubrics/_components/rubric-dialog.tsx`) caps criteria-per-rubric and
steps-per-criterion by Plan: Free 3/3, Builder 10/10, Scale 15/15, read from
`rubricCriteriaLimit` / `rubricStepsPerCriterionLimit` on `PlanDefinition` (`src/lib/billing/
plans.ts`). These are a **client-side nudge only** — the server `RubricSchema`
(`src/lib/validation/schemas.ts`) still permits 20/50, by design; server enforcement is a deliberate
follow-up. Do **not** assume the cap is enforced anywhere but the editor UI.

The dialog reads the Team's plan from `BillingContext` via `usePlan()` (`src/app/_components/
billing-context.tsx`); the provider now carries a `plan` field that pages seed with
`<BillingProvider plan={…} …>` (rubrics + dashboard). At the cap the "Add criterion"/"Add step"
buttons disable and a limit message shows on **every** plan (not just Free). Copy is plan-neutral:
upgradeable tiers use `editor.criteriaLimit` / `editor.stepsLimit` ("Up to {max}… Upgrade for
more."), the top tier (detected via `PLAN_SLUGS[PLAN_SLUGS.length - 1]`) uses the no-upgrade
`editor.criteriaMax` / `editor.stepsMax` — all four keys live under `Rubrics.editor.*` in the three
i18n catalogs. `applyTemplate` silently truncates an over-cap template to the limit (no user-facing
trim notice, by design).

Validation is per-field: Zod flattens nested array errors onto a single `criteria` key, so
`parseCriterionErrors` reconstructs the issue paths (`["criteria", ci, "name" | "weight" | "steps",
si]`) into per-criterion / per-step messages rendered inline with `border-danger` + `aria-invalid`
on the offending input, and `focusFirstError` scrolls to that specific input rather than the whole
criteria section. Per-element messages are stripped from the section-level `criteria` key to avoid
duplicates; the weight schema carries user-facing 0–1 messages.

# Auth route handlers and cookie bridging (#354, #355, #356)

Supabase SSR session cookies set inside a Route Handler **do not** survive a
`NextResponse.redirect()` when the client is created via `next/headers`
`cookies()` — the `cookies().set()` calls write to an internal response that
is discarded when the handler returns its own `NextResponse`. This causes a
first-click race: the browser follows the `Location` header before the session
cookie lands, so the user appears logged out until a second click re-requests
with the cookie now present.

**Fix pattern:** Route Handlers that establish a Supabase session
(`/auth/confirm`, `/auth/callback`) must use `createRouteClient`
(`src/lib/supabase/route-client.ts`) instead of `createClient`
(`src/lib/supabase/server.ts`). `createRouteClient` bridges cookie writes
through a `NextResponse` — the same object the handler returns — so the
`Set-Cookie` headers ride on the redirect response itself. This mirrors
`updateSession` in `src/lib/supabase/middleware.ts` (the proxy's cookie
bridge), adapted for Route Handler usage.

**Post-auth onboarding redirect (#355):** every auth entry point (password
sign-in, OAuth callback, email-confirmation route) resolves the redirect
destination through `resolveOnboardingRedirect`
(`src/lib/auth/post-auth-redirect.ts`): if the authenticated user has no org
membership, they go to `/onboarding` instead of `/dashboard`. Recovery flows
(`type=recovery` → `/reset-password`) are exempt. The dashboard page's own
`if (!orgId) redirect("/onboarding")` guard remains as a backstop, but the
post-auth redirect means users no longer need to manually navigate to
`/dashboard` to trigger it.

**Authenticated-user guard (#356):** the proxy (`src/proxy.ts`) redirects
signed-in users away from auth-only public routes (`/sign-in`, `/sign-up`,
`/forgot-password`) to `/dashboard`. Root (`/`), marketing pages, and
token-handling routes (`/auth/confirm`, `/auth/callback`) are excluded — root
renders differently for signed-in vs signed-out visitors, and token routes
must always process their token before any redirect decision.

# Nav auth carries plan for upsell CTAs (#349)

`resolveNavAuth()` (`src/lib/auth/nav.ts`) now resolves the Team's effective plan
via `getBillingState()` and seeds it into `AuthProvider` as `plan: PlanSlug`.
The `NavBarClient` renders a bolded "Upgrade" button in the top nav, a CTA in
the mobile nav sheet, and a CTA in the account menu dropdown — all visible only
when `plan === "free"`. The optimizations page shows "0 available" when
`allowance.included === 0` — on the Free plan that means the ONE lifetime
Optimization Run (`optimizationRunsGrant: "lifetime"` in `plans.ts`; effective count
subtracts `optimization_lifetime_used`, net reserves minus releases across all
periods) is used or in flight; a fresh Free Team shows "1 available". The billing page
renders a solid "Upgrade plan" CTA when there's no billing account. The invite
form is disabled on the Free plan with upgrade language, and a modal upsell
intercepts seat-limit errors.

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

# Shipping styled auth email templates to prod (#346)

Supabase stores auth email templates in two disconnected places: `config.toml`
(read only by the LOCAL/self-hosted stack — this is what drives Mailpit on
`supabase start`) and the hosted project (Dashboard, or the Management API).
Nothing syncs local → hosted on its own, and `supabase config push` is the wrong
tool: it applies the ENTIRE `[auth]` block (including `[auth.external.*]` OAuth
provider enabled state and `additional_redirect_urls`), so it can silently disable
Dashboard-configured prod OAuth or clobber the redirect allow-list.

So we ship ONLY the templates via the documented Management API path: PATCH
`/v1/projects/{ref}/config/auth` with just the `mailer_subjects_*` and
`mailer_templates_*_content` fields (subjects AND bodies). The pusher is
`scripts/push-auth-email-templates.mts` (`npm run push:auth-emails`): subjects come
from `config.toml`'s `[auth.email.template.*]` blocks, bodies from the committed
`content_path` HTML (generated by `npm run gen:auth-emails`), so `config.toml`
stays the single source of truth. The `deploy-auth-emails` workflow
(`.github/workflows/deploy-auth-emails.yml`) runs it against prod on push to `main`
ONLY when a template / subject / the script changes (paths filter), plus a
`workflow_dispatch` button for a manual re-push — it is NOT part of the
`migrate-prod` deploy. Prod SMTP is configured in the Supabase Dashboard
(Auth → SMTP); committed `config.toml` leaves `[auth.email.smtp]` off so local + CI
capture auth mail in Mailpit.

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
unauthenticated or high-volume paths (failed sign-in/sign-up/OAuth/password-reset in
`src/app/actions/auth.ts`, the internal-secret refusals) are deferred with `after()` from
`next/server` so the warn-level PostHog flush stays off the response's critical path while
the runtime still awaits it — a bare `void` could be dropped on a serverless freeze. Never
log PII: auth failures log only the email domain, never the full address.

# Launch-phase sign-up gate: slice 1 of Access Codes (ADR-0017, #425)

Baseline's launch phase is invite-only. `signup-access-code-gate` (a PostHog feature flag)
gates account creation; this slice is the gate only — there is no Access Code schema yet, so
the ONLY bypass while gated is a pending, unexpired **Invitation** matching the sign-up email
(see CONTEXT.md's Access Code / Invitation / Redemption terms and ADR-0017 for the full model
the later slices build out).

`isSignupGated()` (`src/lib/analytics/signup-gate.ts`) is the app-side mirror of the worker's
kill-switch helper (`isKillSwitchFlagEnabled`, `worker/src/telemetry.ts`) — server-side
evaluation, anonymous distinctId, never throws — but fails in the OPPOSITE direction on
purpose: PostHog unconfigured (no `POSTHOG_KEY`) → ungated; flag readable → the flag decides;
an evaluation error, an undefined result, or a response slower than its 3s timeout → **gated**.
A kill switch defaults to the shipped behavior when it can't be read; a sign-up gate must
default to the SAFE behavior, and here safe means gated — an outage must never silently open
registration (coded/invited sign-ups don't depend on the flag, so they still get through).
This uses its own `POSTHOG_KEY`/`POSTHOG_HOST` — NOT the client bundle's
`NEXT_PUBLIC_POSTHOG_KEY`/`NEXT_PUBLIC_POSTHOG_HOST` (`src/lib/analytics/server.ts`) — because
those are inlined into the bundle by Next at BUILD time (even in server-only code), which would
freeze an e2e build's PostHog host for the whole run; a plain env var is read at request time,
so e2e can point ONLY this evaluation path at a local mock without touching client-side
analytics/consent for the rest of the suite.

Both the `/sign-up` page and the `signUp` server action (`src/app/actions/auth.ts`) call this
same helper — no split-brain between the page's copy and the action's enforcement. The page
(`src/app/[locale]/sign-up/[[...sign-up]]/page.tsx`) is `export const dynamic = "force-dynamic"`
so the flag is evaluated per request, never frozen into a static build. `signUp` checks the
gate AFTER the per-IP rate limit and BEFORE calling `supabase.auth.signUp` — gated + no pending
Invitation for the submitted email (`hasPendingInvitation`, `src/lib/invitations/pending.ts`,
a plain equality match since `EmailSchema` already lowercases both sides) refuses with
`{ gated: true }` and creates no Supabase user. Sign-in and existing users are unaffected —
this only guards account creation.

**OAuth stays disabled while gated, by existing config, no code change** (ADR-0017): OAuth
creates the Supabase user during the token exchange, before app code can demand anything, so
enabling it would bypass the gate entirely. `supabase/config.toml`'s
`[auth.external.{google,github}]` are already `enabled = false`, and
`enabledOAuthProviders()` (`src/lib/auth/oauth.ts`) already defaults to nothing without
`NEXT_PUBLIC_OAUTH_PROVIDERS` set — this is an invariant to preserve, not a gap to fix; OAuth
comes back as part of the gate-lift milestone, not this slice.

**e2e mocks PostHog rather than bypassing the helper** (no force-override backdoor):
`e2e/posthog-mock-server.mjs` is a minimal local stand-in for PostHog's `/flags` decide
endpoint, started as a second Playwright `webServer` entry alongside the app
(`playwright.config.ts`). The app's `POSTHOG_KEY`/`POSTHOG_HOST` are set (via that same
`webServer.env`) to point at the mock for the WHOLE e2e run; the mock defaults to `"off"`, so
every pre-existing spec that merely navigates through `/sign-up` keeps seeing the exact
ungated behavior it always has. Only `e2e/signup-gate.spec.ts` calls the mock's control
endpoint (`e2e/posthog-mock.ts`'s `setSignupGateState("on"|"off"|"error"|"timeout")`) to drive
the full failure matrix. Because the mock's decision is process-wide and unkeyed, that spec
runs in its own Playwright project (`SIGNUP_GATE_SPEC`) that depends on both `chromium` and
`mutating` finishing first — it is the only thing hitting `/sign-up` while it's toggling state.

# Access Codes: schema, atomic claim, mint script — slice 2 (ADR-0017, #426)

Builds on #425 (the gate + Invitation bypass) by giving it the OTHER bypass: a plaintext,
case-insensitively-matched Access Code (`access_codes`, `access_code_redemptions` —
`supabase/migrations/20260706000000_access_codes.sql`). Same platform-owned, pre-account,
RLS-deny-all-service-role-only posture as `invitations` — not tenant-scoped, never in
`TENANT_SCOPED_TABLES`/`tenantDb`.

**The atomic claim is a row-locked guarded UPDATE, not a ledger.** Unlike the Point Ledger's
append-only-rows-plus-advisory-lock pattern (`reserve_eval_points`), a redemption can't be
recorded at claim time — the redeemer's user id doesn't exist yet (the claim happens BEFORE
`supabase.auth.signUp`). So `access_codes.redeemed_count` is a plain counter column, and
`claim_access_code(p_code)` (SECURITY DEFINER SQL) does `select ... for update` (per-row lock,
serializing concurrent claimants) then an `update ... where redeemed_count < max_redemptions`
(belt-and-suspenders second guard) in one transaction — proven race-free by a concurrency
integration test firing 12 concurrent claims at a cap-5 code and asserting exactly 5 win
(`src/lib/access-codes/__tests__/claim-access-code.integration.test.ts`).
`release_access_code_claim(p_access_code_id)` decrements (floored at 0) when a claimed slot
must be handed back. The `access_code_redemptions` row itself — the attribution record joining
code to redeemer — is a plain insert once the new user's id is known
(`recordAccessCodeRedemption`, `src/lib/access-codes/redeem.ts`), not a second RPC; there's no
cap left to guard by that point.

**`signUp` (`src/app/actions/auth.ts`) claim lifecycle**: gated + a pending Invitation matches
the email → unconditional bypass (#425), no code required or consumed, even if one was
submitted. Gated + no Invitation + no code → the same generic `{ gated: true }` refusal as
before Access Codes existed (the form's `accessCode` field is deliberately NOT
HTML-`required`, so an invited visitor with no code still gets through). Gated + no Invitation
+ a code → `claimAccessCode()` runs before `supabase.auth.signUp`; a failed claim returns
`{ accessCodeError: "invalid" | "expired" | "exhausted" }` (a claim RPC error itself also
collapses to `"invalid"` — fail-closed, and indistinguishable from a wrong code on purpose).
A successful claim's slot is released if `signUp` itself errors OR the anti-enumeration
existing-email path fires (`identities.length === 0`, no error) — both are "no genuine new
account resulted"; an unconfirmed-but-created account (real `identities`, no session yet)
KEEPS its slot and gets its `access_code_redemptions` row recorded regardless of confirmation
state, by design. Real local-stack behavior for the anti-enumeration branch is subtler than
its name suggests: Supabase only returns the obfuscated empty-`identities`/no-error shape for
an email with an existing UNCONFIRMED sign-up; a fully CONFIRMED duplicate instead gets a
visible `error` (the OTHER release trigger, same "no new account" logic). Both paths release
correctly; `src/lib/access-codes/__tests__/redeem.test.ts` and `auth.test.ts`'s claim-lifecycle
suite unit-test the empty-`identities` shape directly, and `e2e/signup-gate.spec.ts` proves the
confirmed-duplicate variant end to end.

**Minting is script-only** (`scripts/access-codes.mts`, `npm run access-codes:mint` /
`access-codes:status`) — no admin UI, per ADR-0017. Talks directly to whichever Supabase
project the environment's service-role vars point at (local/staging/prod), with no
"never-production" guard (unlike `seed-e2e.mjs`): minting a real code against prod is this
script's actual job.

# Signup passes: the GoTrue-layer front-door guarantee (#487, ADR-0017 amendment)

The gate above is app-code-only, so GoTrue's own anon-key REST create endpoints (`POST
/auth/v1/signup`, `POST /auth/v1/otp` with create) used to bypass it entirely. Now `signUp`
mints a short-lived (~10 min), single-use **signup pass** (`signup_passes` — same RLS-deny-all
service-role-only posture as `invitations`/`access_codes`, never in `TENANT_SCOPED_TABLES`) on
EVERY app-originated sign-up, gated or not, after all its checks pass and immediately before
`supabase.auth.signUp()` (`mintSignupPass`, `src/lib/signup-passes/mint.ts`). The pass is bound
to a per-request **nonce** the mint returns and the action threads into `options.data` (→ GoTrue
`user_metadata`), NOT the email alone — email-only binding let an attacker race a victim's pass
and set the account password (#489). A `before_user_created` Postgres auth hook
(`before_user_created_hook`, migration `20260712000000_signup_passes.sql`, enabled in
`config.toml`'s `[auth.hook.before_user_created]`) rejects any email-provider creation without a
valid pass whose nonce matches, consuming it atomically (row-locked guarded update, the
`claim_access_code` discipline); it ADMITS federated creations (non-`email` `app_metadata.provider`,
GoTrue-set and unforgeable via /signup) so OAuth needs no pass on gate-lift. The hook reads NO
gate logic — "the app was the front door" is its only rule, unconditional; don't try to make it
flag-aware. Verified against GoTrue v2.190.0 (#487/#489): the hook FIRES for anon signup + anon
email-OTP-create + `inviteUserByEmail`; it does NOT fire for admin-API creates
(`auth.admin.createUser` — so `scripts/seed-e2e.mjs`, the e2e admin fixtures, and the Dashboard's
"Create user" button need no passes) nor for duplicate-email signups (both anti-enumeration
variants), whose pass simply expires; each mint defers an opportunistic purge of hour-dead rows
off the response with `after()` (no pg_cron sweep; the `expires_at` index supports it). A mint
failure or hook rejection is **gate-aware**: `{ gated: true }` (invite-only copy) when the gate
is up, `{ retryable: true }` (generic retry) when it's off — an ungated open-registration form
must never show invite-only on a transient DB blip (#489). `isSignupPassRejection` /
`SIGNUP_PASS_REJECTION_MESSAGE` live in `src/lib/signup-passes/rejection.ts` (NO `server-only`
guard, so tests + the e2e spec import the one literal); a parity test greps the migration SQL for
it. Two known residuals (both in ADR-0017): the raw endpoint still leaks registered-vs-not via
GoTrue's own 422/200 on duplicates (the hook adds only the fresh-email 403), and the Dashboard
"Send invitation" is gated because its payload is indistinguishable from anon signup (operators
use "Create user"). Hosted projects get the hook via the Management API (`npm run push:auth-hook`
— the #346 scoped-PATCH pattern; config.toml only drives local), ONLY after the migration + app
deploy are live. e2e: `signup-gate.spec.ts` probes the raw signup/OTP endpoints (fresh email,
fabricated nonce) in both gate states; the hook is live for the whole local/CI suite via config.toml.

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
