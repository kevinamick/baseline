/**
 * App-facing re-export of the shared provider registry (#379, first tracer bullet of the
 * shared-package extraction #93). LLM_PROVIDERS / PROVIDER_LABELS / RUNTIME_READY_PROVIDERS used
 * to be hand-mirrored here and pinned to the worker's copy by a parity test
 * (worker/src/providers/provider-list.ts ↔ this file). They now come from ONE definition,
 * worker/src/providers/registry.ts, that both projects import — there's nothing left to drift, so
 * that parity test is gone.
 *
 * This file stays the app's import path (`@/lib/llm/providers`) rather than every app call site
 * reaching across the package boundary itself — same shim convention as
 * src/lib/logging/server.ts re-exporting worker/src/log-attributes.ts. Client components import
 * this module (e.g. the optimization wizard's provider labels), so it must stay side-effect-free
 * and never pull in Node-only code (see model-prices.ts for the one exception that's guarded).
 */
export {
  LLM_PROVIDERS,
  type LlmProvider,
  isLlmProvider,
  PROVIDER_LABELS,
  RUNTIME_READY_PROVIDERS,
  isRuntimeReady,
} from "../../../worker/src/providers/registry";
