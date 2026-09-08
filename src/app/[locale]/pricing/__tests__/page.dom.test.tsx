// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #449: the pre-checkout trial billing disclosure is the pricing page's own
// conditional render, gated on a pending Access Code trial benefit — so it's
// exercised by rendering the real page, mocking only the seams that would
// otherwise reach Supabase/Stripe or pull in unrelated chrome (SiteFooter,
// CheckoutCta) at import time. Both `useTranslations` (the nested plan-card
// helpers) and `getTranslations` (the page's own top-level `t`) are stubbed
// to resolve real catalog strings, mirroring site-footer.dom.test.tsx's
// `useTranslations` mock and the billing page test's `getTranslations` mock.

function resolveNs(
  catalog: Record<string, unknown>,
  ns: string
): Record<string, unknown> {
  return (
    (ns
      .split(".")
      .reduce<unknown>(
        (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
        catalog
      ) as Record<string, unknown> | undefined) ?? {}
  );
}

function makeT(dict: Record<string, unknown>) {
  // A page can call t("trialDisclosure.heading") — a dotted subpath within
  // its own namespace's nested object, not a single key — so this walks the
  // same way resolveNs walks the top-level catalog.
  const lookup = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
        dict
      );
  const t = (key: string, values?: Record<string, unknown>) => {
    const raw = lookup(key);
    if (typeof raw !== "string") return key;
    let s = raw;
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  };
  t.rich = (key: string) => (lookup(key) as string) ?? key;
  return t;
}

vi.mock("next-intl", async () => {
  const en = (await import("../../../../../messages/en.json"))
    .default as unknown as Record<string, unknown>;
  return {
    useTranslations: (ns: string) => makeT(resolveNs(en, ns)),
  };
});

vi.mock("next-intl/server", async () => {
  const en = (await import("../../../../../messages/en.json"))
    .default as unknown as Record<string, unknown>;
  return {
    getTranslations: vi.fn(async (ns: string) => makeT(resolveNs(en, ns))),
  };
});

// vi.mock factories are hoisted above the file's other statements, so every
// mock fn they close over must come from vi.hoisted — see checkout.test.ts.
const { mockGetAuthContext, mockGetBillingState } =
  vi.hoisted(() => ({
    mockGetAuthContext: vi.fn(),
    mockGetBillingState: vi.fn(),
    }));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));

vi.mock("@/lib/billing/state", () => ({ getBillingState: mockGetBillingState }));

vi.mock("@/app/_components/site-footer", () => ({ SiteFooter: () => null }));

// checkout-cta.tsx imports the checkout server action, which now pulls in
// next-intl/server + the Stripe SDK at module scope — irrelevant to this
// page-level test (the signed-out fixture below never reaches it), so it's
// stubbed rather than transitively loaded. vi.mock's relative path resolves
// from THIS file's location (one level deeper than page.tsx, under
// __tests__/), not from page.tsx's own "./" specifier.
vi.mock("../_components/checkout-cta", () => ({ CheckoutCta: () => null }));

import PricingPage from "../page";

async function renderPricingPage() {
  const result = await PricingPage();
  render(result);
}

describe("PricingPage trial billing disclosure (#449)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Signed-out is the simplest fixture that still reaches the pending-
    // benefit read the trial notice is gated on — the page looks it up
    // whenever there's an orgId, independent of sign-in state elsewhere in
    // ctx. A signed-out visitor with orgId null never gets a pending lookup
    // in production, so these tests sign in a Team with canWrite so the
    // lookup actually runs, same as a real visitor who'd see this notice.
    mockGetAuthContext.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      canWrite: true,
    });
    mockGetBillingState.mockResolvedValue({ plan: "free" });
  });

  it("never shows a trial disclosure: Access Codes are gone (ADR-0020)", async () => {
    await renderPricingPage();

    expect(
      screen.queryByTestId("pricing-trial-disclosure")
    ).not.toBeInTheDocument();
  });
});
