import { describe, it, expect } from "vitest";
import { optimizationLimitEmailHtml } from "../optimization-limit";

describe("optimizationLimitEmailHtml (#181)", () => {
  const base = {
    teamName: "Acme",
    included: 10,
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders the team name and included count", () => {
    const html = optimizationLimitEmailHtml(base);
    expect(html).toContain("Acme has used its Optimization Runs for this period");
    expect(html).toContain(">10<");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
  });

  it("formats a large included count with thousands separators", () => {
    const html = optimizationLimitEmailHtml({ ...base, included: 1000 });
    expect(html).toContain("1,000");
  });

  it("handles a zero included count", () => {
    const html = optimizationLimitEmailHtml({ ...base, included: 0 });
    expect(html).toContain("all <strong");
    expect(html).toContain(">0<");
  });

  it("includes the included count in the preview text", () => {
    const html = optimizationLimitEmailHtml(base);
    expect(html).toContain("all 10 included runs have been used");
  });

  it("escapes an admin-supplied team name", () => {
    const html = optimizationLimitEmailHtml({
      ...base,
      teamName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
