import { describe, it, expect } from "vitest";
import { managedPaymentFailedEmailHtml } from "../managed-payment-failed";

describe("managedPaymentFailedEmailHtml (#186)", () => {
  const base = {
    teamName: "Acme",
    amountUsd: 12.5,
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders the team name, formatted amount, and billing CTA", () => {
    const html = managedPaymentFailedEmailHtml(base);
    expect(html).toContain("Acme: managed token payment failed");
    expect(html).toContain("$12.50");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
    expect(html).toContain("Update payment method");
  });

  it("includes the amount in the preview text", () => {
    const html = managedPaymentFailedEmailHtml(base);
    expect(html).toContain("Managed token payment of $12.50 was declined");
  });

  it("formats a zero amount", () => {
    const html = managedPaymentFailedEmailHtml({ ...base, amountUsd: 0 });
    expect(html).toContain("$0.00");
  });

  it("formats a large amount with thousands separators", () => {
    const html = managedPaymentFailedEmailHtml({ ...base, amountUsd: 18342.4 });
    expect(html).toContain("$18,342.40");
  });

  it("escapes an admin-supplied team name to prevent HTML injection", () => {
    const html = managedPaymentFailedEmailHtml({
      ...base,
      teamName: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes the billing URL", () => {
    const html = managedPaymentFailedEmailHtml({
      ...base,
      billingUrl: 'https://x.com/"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
