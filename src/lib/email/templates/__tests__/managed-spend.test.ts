import { describe, it, expect } from "vitest";
import { managedSpendLimitEmailHtml } from "../managed-spend";

describe("managedSpendLimitEmailHtml (#185)", () => {
  const base = {
    teamName: "Acme",
    capUsd: 25,
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders the team name, formatted cap, and billing CTA", () => {
    const html = managedSpendLimitEmailHtml(base);
    expect(html).toContain("Acme has reached its managed spend cap");
    expect(html).toContain("$25.00");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
    expect(html).toContain("View usage and billing");
  });

  it("includes the cap in the preview text", () => {
    const html = managedSpendLimitEmailHtml(base);
    expect(html).toContain("your $25.00 monthly managed spend cap is reached");
  });

  it("formats a large cap with thousands separators", () => {
    const html = managedSpendLimitEmailHtml({ ...base, capUsd: 1840 });
    expect(html).toContain("$1,840.00");
  });

  it("formats a zero cap", () => {
    const html = managedSpendLimitEmailHtml({ ...base, capUsd: 0 });
    expect(html).toContain("$0.00");
  });

  it("escapes an admin-supplied team name to prevent HTML injection", () => {
    const html = managedSpendLimitEmailHtml({
      ...base,
      teamName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
