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

**Do not** render the real `<NavBar/>` inside a loading boundary — it awaits `getAuthContext()` (a network round-trip) and re-introduces the blocking the boundary is supposed to eliminate. Use `NavBarSkeleton` from `page-skeleton` as a static stand-in.

# LLM providers (#184, #204)

Anthropic, OpenAI, and Google are all runtime-wired. The worker has one client per
provider behind `LLMProvider`/`RuntimeProvider` (`worker/src/providers/{anthropic,openai,google}.ts`);
never `new XProvider()` at a call site — go through `createProviderForModel(model, …)`
(`worker/src/providers/factory.ts`), which picks the client by `providerForModel()`.
OpenAI/Google are fetch-based against a fixed literal host (the managed-key host-pinning
guarantee, #222) — no SDK.

A run is **single-provider**: judge, reflect/generation, and a Managed Agent's target call each
resolve their own key via `providerForModel(model)`, and the judge model follows the run's
reflect-model provider (`defaultJudgeModelForProvider`). So a Team's OpenAI/Google key drives the
whole run. Managed Agent **target models stay Anthropic-only** for now: the legacy eval path
(`worker/src/worker.ts`) reuses the judge's Anthropic key for the target call, so widening
`TARGET_MODELS` needs separate target-key resolution there first.

The model registry and price table are duplicated app↔worker (separate TS projects, #93) and kept
in lockstep by parity tests: `worker/src/providers/models.ts` ↔ `src/lib/optimization/models.ts`,
and `MODEL_PRICES` in both. Adding a model/provider means editing both copies plus
`LLM_PROVIDERS`, `RUNTIME_READY_PROVIDERS`, and `MANAGED_KEY_ENV`. An unpriced managed call fails
closed (ADR-0008).
