import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  breadcrumbListSchema,
  defaultOpenGraph,
  defaultTwitter,
  faqPageSchema,
  googleVerification,
  howToSchema,
  noindex,
  organizationSchema,
  softwareApplicationSchema,
} from "@/lib/seo";

describe("noindex", () => {
  it("keeps the page out of the index but follows links", () => {
    expect(noindex.robots).toEqual({ index: false, follow: true });
  });
});

describe("defaultOpenGraph", () => {
  it("builds a website card with localized url and OG locale (default locale unprefixed)", () => {
    expect(defaultOpenGraph("en", "/", "Baseline", "desc")).toEqual({
      type: "website",
      siteName: "Baseline",
      title: "Baseline",
      description: "desc",
      url: "/",
      locale: "en_US",
    });
  });

  it("prefixes non-default locales and maps the OG locale", () => {
    const og = defaultOpenGraph("es", "/pricing", "Precios", "desc");
    expect(og.url).toBe("/es/pricing");
    expect(og.locale).toBe("es_ES");
  });

  it("falls back to the default locale form for an unknown locale", () => {
    const og = defaultOpenGraph("de", "/", "Baseline", "desc");
    expect(og.url).toBe("/");
    expect(og.locale).toBe("en_US");
  });
});

describe("defaultTwitter", () => {
  it("builds a large-image summary card", () => {
    expect(defaultTwitter("Baseline", "desc")).toEqual({
      card: "summary_large_image",
      title: "Baseline",
      description: "desc",
    });
  });
});

describe("googleVerification", () => {
  const original = process.env.GOOGLE_SITE_VERIFICATION;
  beforeEach(() => {
    delete process.env.GOOGLE_SITE_VERIFICATION;
  });
  afterEach(() => {
    process.env.GOOGLE_SITE_VERIFICATION = original;
  });

  it("is undefined when the token env is unset", () => {
    expect(googleVerification()).toBeUndefined();
  });

  it("emits the google token when set", () => {
    process.env.GOOGLE_SITE_VERIFICATION = "tok123";
    expect(googleVerification()).toEqual({ google: "tok123" });
  });
});

describe("organizationSchema", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("is a valid Organization graph with absolute URLs", () => {
    const schema = organizationSchema();
    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("Organization");
    expect(schema.name).toBe("Baseline");
    expect(schema.url).toBe("https://baseline.app");
    // A raster logo ≥112×112 — Google's floor for the brand/logo treatment.
    expect(schema.logo).toBe("https://baseline.app/logo-512.png");
    // Must serialize cleanly into a <script type="application/ld+json"> block.
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});

describe("faqPageSchema", () => {
  it("mirrors the page's visible question/answer pairs as FAQPage mainEntity", () => {
    const schema = faqPageSchema([
      { question: "What is a rubric?", answer: "Weighted criteria." },
      { question: "Is there a free tier?", answer: "Yes." },
    ]);
    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("FAQPage");
    expect(schema.mainEntity).toEqual([
      {
        "@type": "Question",
        name: "What is a rubric?",
        acceptedAnswer: { "@type": "Answer", text: "Weighted criteria." },
      },
      {
        "@type": "Question",
        name: "Is there a free tier?",
        acceptedAnswer: { "@type": "Answer", text: "Yes." },
      },
    ]);
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});

describe("breadcrumbListSchema", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("builds a positioned trail with absolute, locale-correct item URLs", () => {
    const schema = breadcrumbListSchema("en", [
      { name: "Home", path: "/" },
      { name: "Blog", path: "/blog" },
      { name: "A post", path: "/blog/a-post" },
    ]);
    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("BreadcrumbList");
    expect(schema.itemListElement).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://baseline.app",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Blog",
        item: "https://baseline.app/blog",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "A post",
        item: "https://baseline.app/blog/a-post",
      },
    ]);
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it("prefixes item URLs for a non-default locale", () => {
    const schema = breadcrumbListSchema("es", [
      { name: "Inicio", path: "/" },
      { name: "Blog", path: "/blog" },
    ]);
    const items = schema.itemListElement as { item: string }[];
    expect(items[0].item).toBe("https://baseline.app/es");
    expect(items[1].item).toBe("https://baseline.app/es/blog");
  });
});

describe("howToSchema", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("mirrors the walkthrough steps as positioned HowToSteps", () => {
    const schema = howToSchema("Run an eval", "How teams do it in Baseline.", [
      { title: "Define good", body: "Write a rubric." },
      {
        title: "Run it",
        body: "Score outputs.",
        image: { src: "/docs/runs.png" },
      },
    ]);
    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("HowTo");
    expect(schema.name).toBe("Run an eval");
    expect(schema.description).toBe("How teams do it in Baseline.");
    expect(schema.step).toEqual([
      {
        "@type": "HowToStep",
        position: 1,
        name: "Define good",
        text: "Write a rubric.",
      },
      {
        "@type": "HowToStep",
        position: 2,
        name: "Run it",
        text: "Score outputs.",
        image: "https://baseline.app/docs/runs.png",
      },
    ]);
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});

describe("softwareApplicationSchema", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original;
  });

  it("is a valid SoftwareApplication graph advertising the free tier", () => {
    const schema = softwareApplicationSchema();
    expect(schema["@context"]).toBe("https://schema.org");
    expect(schema["@type"]).toBe("SoftwareApplication");
    expect(schema.name).toBe("Baseline");
    expect(schema.applicationCategory).toBe("BusinessApplication");
    expect(schema.operatingSystem).toBe("Web");
    expect(schema.url).toBe("https://baseline.app");
    expect(schema.offers).toMatchObject({
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    });
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});
