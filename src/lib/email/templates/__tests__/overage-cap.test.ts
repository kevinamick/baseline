import { describe, it, expect } from "vitest";
import { overageWarningEmailHtml, overageLimitEmailHtml } from "../overage-cap";

describe("overageWarningEmailHtml (#183)", () => {
  const base = {
    teamName: "Acme",
    committedUsd: 1500,
    capUsd: 1840,
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders the team name and both formatted amounts", () => {
    const html = overageWarningEmailHtml(base);
    expect(html).toContain("Acme is approaching its overage cap");
    expect(html).toContain("$1,500.00");
    expect(html).toContain("$1,840.00");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
  });

  it("includes both amounts in the preview text", () => {
    const html = overageWarningEmailHtml(base);
    expect(html).toContain("Acme has used $1,500.00 of its $1,840.00 monthly overage cap");
  });

  it("escapes an admin-supplied team name", () => {
    const html = overageWarningEmailHtml({ ...base, teamName: "<b>Acme</b>" });
    expect(html).not.toContain("<b>Acme</b>");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
  });

  it("handles a zero committed amount", () => {
    const html = overageWarningEmailHtml({ ...base, committedUsd: 0 });
    expect(html).toContain("$0.00");
  });
});

describe("overageLimitEmailHtml (#183)", () => {
  const base = {
    teamName: "Acme",
    capUsd: 1840,
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders the team name, formatted cap, and billing CTA", () => {
    const html = overageLimitEmailHtml(base);
    expect(html).toContain("Acme has reached its overage cap");
    expect(html).toContain("$1,840.00");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
  });

  it("includes the cap in the preview text", () => {
    const html = overageLimitEmailHtml(base);
    expect(html).toContain("your $1,840.00 monthly overage cap is fully committed");
  });

  it("escapes an admin-supplied team name and URL", () => {
    const html = overageLimitEmailHtml({
      ...base,
      teamName: '"><script>alert(1)</script>',
      billingUrl: 'https://x.com/"><script>alert(2)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(2)</script>");
  });
});
