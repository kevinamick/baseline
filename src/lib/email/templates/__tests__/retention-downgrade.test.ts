import { describe, it, expect } from "vitest";
import { retentionDowngradeEmailHtml } from "../retention-downgrade";

describe("retentionDowngradeEmailHtml (#187, ADR-0008)", () => {
  const base = {
    teamName: "Acme",
    planName: "Free",
    retentionDays: 14,
    runCount: 5,
    purgeDateIso: "2026-06-15T00:00:00Z",
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders plural copy for multiple runs", () => {
    const html = retentionDowngradeEmailHtml(base);
    expect(html).toContain("Acme: 5 runs moved out of your retention window");
    expect(html).toContain("Free");
    expect(html).toContain("14 days");
    expect(html).toContain("5 runs older than that are now hidden");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
  });

  it("renders singular copy for exactly one run", () => {
    const html = retentionDowngradeEmailHtml({ ...base, runCount: 1 });
    expect(html).toContain("Acme: 1 run moved out of your retention window");
    expect(html).toContain("1 run older than that is now hidden");
  });

  it("renders plural copy for zero runs", () => {
    const html = retentionDowngradeEmailHtml({ ...base, runCount: 0 });
    expect(html).toContain("0 runs moved out of your retention window");
    expect(html).toContain("0 runs older than that are now hidden");
  });

  it("includes the run count in the preview text", () => {
    const html = retentionDowngradeEmailHtml(base);
    expect(html).toContain("5 runs are now hidden — permanently deleted on");
  });

  it("formats the purge date correctly regardless of ISO input format", () => {
    const html = retentionDowngradeEmailHtml({
      ...base,
      purgeDateIso: "2026-01-01T00:00:00.000Z",
    });
    expect(html).toContain("January 1, 2026");
  });

  it("escapes the admin-supplied team name and plan name", () => {
    const html = retentionDowngradeEmailHtml({
      ...base,
      teamName: "<script>alert('team')</script>",
      planName: "<b>Free</b>",
    });
    expect(html).not.toContain("<script>alert('team')</script>");
    expect(html).not.toContain("<b>Free</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Free&lt;/b&gt;");
  });
});
