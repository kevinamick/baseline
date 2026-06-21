import { organizationSchema } from "@/lib/seo";
import { JsonLd } from "@/app/_components/json-ld";

/**
 * Site-wide `Organization` structured data (JSON-LD). Rendered once from the root
 * layout so every page carries the brand graph for search engines. Delegates the
 * `<script>` rendering (nonce + escaping) to the shared {@link JsonLd} primitive.
 */
export function OrgJsonLd({ nonce }: { nonce?: string }) {
  return <JsonLd schema={organizationSchema()} nonce={nonce} />;
}
