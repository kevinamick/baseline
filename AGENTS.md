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
**fails closed** rather than judging unmetered (#358) — see `worker/AGENTS.md`. The lone app↔worker
divergence (an empty/whitespace-secret `provider_keys` row reads BYO here but resolves managed in the
worker) also fails closed, tracked in #371.

The model registry and price table are duplicated app↔worker (separate TS projects, #93) and kept
in lockstep by parity tests: `worker/src/providers/models.ts` ↔ `src/lib/optimization/models.ts`,
and `MODEL_PRICES` in both. Adding a model/provider means editing both copies plus
`LLM_PROVIDERS` (app + worker), `RUNTIME_READY_PROVIDERS`, `MANAGED_KEY_ENV`, a migration
widening the `provider_keys.provider` CHECK constraint, and a `PROVIDER_KEY_PATTERNS` entry in
`src/lib/llm/keys.ts` (the BYO key-format validator, #342, is a `Record<LlmProvider, …>`, so a new
provider won't typecheck without one). An unpriced managed call fails closed (ADR-0008).

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
when `plan === "free"`. The optimizations page shows "0 available" (not "1
available") when `allowance.included === 0` (the Free plan). The billing page
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
