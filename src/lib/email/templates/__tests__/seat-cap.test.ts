import { describe, it, expect } from "vitest";
import { seatCapEmailHtml } from "../seat-cap";

describe("seatCapEmailHtml (#182)", () => {
  const base = {
    teamName: "Acme",
    memberCount: 8,
    seatLimit: 3,
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders the team name and both counts", () => {
    const html = seatCapEmailHtml(base);
    expect(html).toContain("Acme has more members than the Free plan allows");
    expect(html).toContain("8 members");
    expect(html).toContain(">3<");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
    expect(html).toContain("No members were removed and no data was deleted.");
  });

  it("includes both counts in the preview text", () => {
    const html = seatCapEmailHtml(base);
    expect(html).toContain("Runs are paused: Acme has 8 members but Free allows 3");
  });

  it("escapes an admin-supplied team name to prevent HTML injection", () => {
    const html = seatCapEmailHtml({
      ...base,
      teamName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes the billing URL", () => {
    const html = seatCapEmailHtml({
      ...base,
      billingUrl: 'https://x.com/"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
