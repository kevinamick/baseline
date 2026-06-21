// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { OrgJsonLd } from "@/app/_components/org-json-ld";

describe("OrgJsonLd", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://baseline.app";
  });

  function scriptEl(container: HTMLElement): HTMLScriptElement {
    const el = container.querySelector<HTMLScriptElement>(
      'script[type="application/ld+json"]'
    );
    if (!el) throw new Error("no JSON-LD script rendered");
    return el;
  }

  it("renders an application/ld+json block with a valid Organization graph", () => {
    const { container } = render(<OrgJsonLd nonce="abc123" />);
    const parsed = JSON.parse(scriptEl(container).textContent ?? "");
    expect(parsed["@type"]).toBe("Organization");
    expect(parsed.name).toBe("Baseline");
    expect(parsed.url).toBe("https://baseline.app");
  });

  it("carries the per-request CSP nonce (so the strict policy doesn't trip it)", () => {
    const { container } = render(<OrgJsonLd nonce="abc123" />);
    // React reflects the nonce via the property (the content attribute is blanked
    // by the browser, but jsdom exposes the value on the element's `nonce` prop).
    expect(scriptEl(container).nonce).toBe("abc123");
  });
});
