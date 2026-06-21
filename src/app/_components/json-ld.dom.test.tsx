// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { JsonLd } from "@/app/_components/json-ld";

describe("JsonLd", () => {
  function scriptEl(container: HTMLElement): HTMLScriptElement {
    const el = container.querySelector<HTMLScriptElement>(
      'script[type="application/ld+json"]'
    );
    if (!el) throw new Error("no JSON-LD script rendered");
    return el;
  }

  it("serializes the schema into an application/ld+json block", () => {
    const { container } = render(
      <JsonLd schema={{ "@type": "Thing", name: "X" }} nonce="abc123" />
    );
    const parsed = JSON.parse(scriptEl(container).textContent ?? "");
    expect(parsed).toEqual({ "@type": "Thing", name: "X" });
  });

  it("carries the per-request CSP nonce (so the strict policy doesn't trip it)", () => {
    const { container } = render(
      <JsonLd schema={{ "@type": "Thing" }} nonce="abc123" />
    );
    // React reflects the nonce via the property (the content attribute is blanked by
    // the browser, but jsdom exposes the value on the element's `nonce` prop).
    expect(scriptEl(container).nonce).toBe("abc123");
  });
});
