import { notFound } from "next/navigation";

// Catch-all for unmatched paths under the `[locale]` segment. Without it, a URL
// that matches no route (e.g. /llm-evaluation/nope) skips the locale tree
// entirely and falls back to Next's bare stock 404 — no Baseline chrome, no way
// back. Because the proxy rewrites every localizable path into `/[locale]/…`,
// this segment matches those leftovers and hands them to the sibling
// `not-found.tsx` via notFound(), which renders the branded 404 inside the
// locale layout with the correct 404 status. Static segments always win over a
// dynamic catch-all, so real routes are unaffected.
export default function CatchAllNotFound(): never {
  notFound();
}
