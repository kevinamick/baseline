import { describe, expect, it, vi } from "vitest";

// The page imports next-intl's locale-aware navigation (`Link`), whose
// `createNavigation` can't resolve `next/navigation` under vitest — stub it, as
// the repo's other page/component tests do. We only call the page's pure server
// helpers here, which don't touch navigation anyway.
vi.mock("@/i18n/navigation", () => ({
  Link: () => null,
}));

import { generateMetadata } from "@/app/[locale]/compare/[competitor]/page";

// The page is dynamically rendered (no generateStaticParams — the nonce-CSP
// layout forces dynamic). ADR-0013's locale-set enforcement lives in the
// notFound() guard, exercised below via generateMetadata.
describe("compare page generateMetadata", () => {
  it("emits a self-canonical and no es/fr hreflang for the en page", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ locale: "en", competitor: "braintrust" }),
    });
    expect(meta.title).toMatch(/Braintrust/);
    expect(meta.alternates).toEqual({ canonical: "/compare/braintrust" });
  });

  it("404s a locale the comparison does not exist in", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({ locale: "es", competitor: "braintrust" }),
      })
    ).rejects.toThrow();
  });

  it("404s an unknown competitor", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({ locale: "en", competitor: "nope" }),
      })
    ).rejects.toThrow();
  });
});
