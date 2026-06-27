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

The model registry and price table are duplicated app↔worker (separate TS projects, #93) and kept
in lockstep by parity tests: `worker/src/providers/models.ts` ↔ `src/lib/optimization/models.ts`,
and `MODEL_PRICES` in both. Adding a model/provider means editing both copies plus
`LLM_PROVIDERS` (app + worker), `RUNTIME_READY_PROVIDERS`, `MANAGED_KEY_ENV`, and a migration
widening the `provider_keys.provider` CHECK constraint. An unpriced managed call fails closed
(ADR-0008).

# Guided first-run onboarding (#331)

The `/rubrics` first-run tutorial is **purely derived from live data** — no persisted onboarding
state, no flag, no schema. Steps are a list of `{id, target, isSatisfied(data)}`
(`(app)/rubrics/_components/onboarding/steps.ts`); the active step is the first unsatisfied one,
and the "Getting started" card + the active coach-mark vanish once every step is satisfied. Add a
step by appending to `RUBRIC_ONBOARDING_STEPS` and its i18n copy under `Rubrics.onboarding.steps.*`
in all three catalogs — the card count and active-step logic need no rework.

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

# Destructive settings actions (#348)

Delete Account and Delete Team use the shared `DangerZone` accordion
(`@/app/_components/danger-zone`). The trigger button is neutral/low-contrast
(hairline border, `text-ink`); the high-contrast `bg-danger` execution button
only renders after the user explicitly expands the section. The containing
section on the page uses a neutral border (`border-hairline-cool`), not
`border-danger`, so the danger accent appears only on the final execution
button inside the expanded body.
