/**
 * Renders a structured-data graph into a `<script type="application/ld+json">`
 * block. The single primitive behind every JSON-LD block on the site (Organization,
 * SoftwareApplication, …) so the nonce + escaping behaviour lives in one place.
 *
 * The app sets a strict, nonce-based CSP (`script-src 'nonce-…'`). Although a
 * `type="application/ld+json"` block is data, not executable script, we attach the
 * per-request nonce anyway — same pattern as the inline theme script — so the block
 * is unambiguously trusted and never tripped up by the policy. The nonce is minted
 * in proxy.ts and read from the `x-nonce` header by the server component rendering
 * this.
 */
export function JsonLd({
  schema,
  nonce,
}: {
  schema: Record<string, unknown>;
  nonce?: string;
}) {
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // suppressHydrationWarning: like the theme script, the browser blanks a
      // <script>'s `nonce` content attribute after parsing (anti-exfiltration), so
      // the client reads nonce="" while the server rendered the real value. Without
      // this, that expected, harmless mismatch surfaces as a hydration warning.
      suppressHydrationWarning
      // The schema is a fixed object we build server-side (no user input), so this
      // serialization is safe; JSON.stringify also escapes any `<` defensively.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
