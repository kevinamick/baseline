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
