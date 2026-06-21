import { organizationSchema } from "@/lib/seo";

/**
 * Site-wide `Organization` structured data (JSON-LD). Rendered once from the root
 * layout so every page carries the brand graph for search engines.
 *
 * The app sets a strict, nonce-based CSP (`script-src 'nonce-…'`). Although a
 * `type="application/ld+json"` block is data, not executable script, we attach the
 * per-request nonce anyway — same pattern as the inline theme script — so the
 * block is unambiguously trusted and never tripped up by the policy. The nonce is
 * minted in proxy.ts and read from the `x-nonce` header by the layout.
 */
export function OrgJsonLd({ nonce }: { nonce?: string }) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // The schema is a fixed object we build server-side (no user input), so this
      // serialization is safe; JSON.stringify also escapes any `<` defensively.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema()) }}
    />
  );
}
