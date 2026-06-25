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

Every dynamic, auth-gated route must have a `loading.tsx` that renders instantly — no async work. Use `PageSkeleton` and `SkeletonBlock` from `@/app/_components/page-skeleton` for standard `wide` (1360 px app surfaces) and `narrow` (2xl settings column) frames. If a route has its own chrome that differs from the standard app shell (e.g. no nav bar), write a bespoke skeleton in that route's `loading.tsx` instead of using `PageSkeleton`.

**Do not** render the real `<NavBar/>` inside a loading boundary. It is a Client Component that reads its identity from `AuthProvider` (which the page seeds from a server-side auth resolve), so painting it in a `loading.tsx` would re-introduce the blocking the boundary is supposed to eliminate. Use `NavBarSkeleton` from `page-skeleton` as a static stand-in.
# App nav (NavBar)

`NavBar` (`@/app/_components/nav-bar`) is a Client Component. It sources the signed-in identity, active org, and switchable orgs from the `AuthProvider` context (`@/app/_components/auth-context`) rather than awaiting `getAuthContext()` itself, so it no longer blocks page transitions on a server auth round-trip.

Any auth-gated page that renders `<NavBar/>` **must** seed the provider:

```tsx
import { AuthProvider } from "@/app/_components/auth-context";
import { resolveNavAuth } from "@/lib/auth/nav";

const navAuth = await resolveNavAuth(); // reuses the page's cached getAuthContext()
// ...
<AuthProvider {...navAuth}>
  <NavBar />
</AuthProvider>
```

`resolveNavAuth()` is `server-only`; node-environment tests that import a page through `NavBar` should `vi.mock("@/lib/auth/nav")` (mirror the other server-only mocks).

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
