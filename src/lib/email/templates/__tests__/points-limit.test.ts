import { describe, it, expect } from "vitest";
import { pointsLimitEmailHtml } from "../points-limit";

describe("pointsLimitEmailHtml (#180)", () => {
  const base = {
    teamName: "Acme",
    neededPoints: 500,
    remainingPoints: 120,
    billingUrl: "https://app.example.com/settings/billing",
  };

  it("renders the team name and both point counts", () => {
    const html = pointsLimitEmailHtml(base);
    expect(html).toContain("Acme has hit its Eval Point limit");
    expect(html).toContain("500 Eval Points");
    expect(html).toContain(">120<");
    expect(html).toContain('href="https://app.example.com/settings/billing"');
  });

  it("formats large point counts with thousands separators", () => {
    const html = pointsLimitEmailHtml({ ...base, neededPoints: 12000, remainingPoints: 0 });
    expect(html).toContain("12,000 Eval Points");
    expect(html).toContain(">0<");
  });

  it("includes both point counts in the preview text", () => {
    const html = pointsLimitEmailHtml(base);
    expect(html).toContain("it needs 500 Eval Points but only 120 remain");
  });

  it("escapes an admin-supplied team name", () => {
    const html = pointsLimitEmailHtml({
      ...base,
      teamName: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
