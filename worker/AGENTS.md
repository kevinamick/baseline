# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

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
