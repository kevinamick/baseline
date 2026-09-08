// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #449: the trial billing disclosure lives right on this page (the trial
// subline + the pending-benefit notice), so exercising it means rendering
// the real page — not a copy of its JSX. That means mocking every module
// the page pulls in that would otherwise hit Supabase/Stripe at import time
// (supabaseAdmin's client construction throws without env vars, same reason
// settings/team/__tests__/page.test.ts mocks it). `next-intl/server` is
// stubbed to resolve real catalog strings (not raw keys) so assertions read
// production copy, mirroring the `useTranslations` mock pattern in
// site-footer.dom.test.tsx.

// vi.mock factories are hoisted above the file's other statements, so every
// mock fn they close over must come from vi.hoisted (a bare `const` here
// throws "Cannot access ... before initialization" the moment the factory
// runs) — see checkout.test.ts for the same pattern.
const {
  mockRedirect,
  mockGetAuthContext,
  mockCustomerMaybeSingle,
  mockGetPointBudget,
  mockListLedgerEntries,
  mockGetOverageCap,
  mockHasDirtyOverageLines,
  mockGetEffectiveManagedCap,
  mockGetBillingState,
} = vi.hoisted(() => ({
  mockRedirect: vi.fn(),
  mockGetAuthContext: vi.fn(),
  mockCustomerMaybeSingle: vi.fn(),
  mockGetPointBudget: vi.fn(),
  mockListLedgerEntries: vi.fn(),
  mockGetOverageCap: vi.fn(),
  mockHasDirtyOverageLines: vi.fn(),
  mockGetEffectiveManagedCap: vi.fn(),
  mockGetBillingState: vi.fn(),
}));

vi.mock("next-intl/server", async () => {
  const en = (await import("../../../../../../../messages/en.json"))
    .default as unknown as Record<string, unknown>;
  function resolveNs(ns: string): Record<string, unknown> {
    return (
      (ns
        .split(".")
        .reduce<unknown>(
          (acc, k) => (acc as Record<string, unknown> | undefined)?.[k],
          en
        ) as Record<string, unknown> | undefined) ?? {}
    );
  }
  function makeT(ns: string) {
    const dict = resolveNs(ns);
    // A page can call t("plan.trialDisclosure") — a dotted subpath within
    // its own namespace's nested object, not a single key — so this walks
    // the same way resolveNs walks the top-level catalog.
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
  return {
    setRequestLocale: vi.fn(),
    getTranslations: vi.fn(
      async (opts: string | { namespace: string }) =>
        makeT(typeof opts === "string" ? opts : opts.namespace)
    ),
  };
});

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

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));

// Avoids the real client's construction (throws without Supabase env vars).
// Only the plan card's "does this Team have a billing account" read is used
// by the page directly; every other Supabase-backed read comes through the
// billing-lib mocks below.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockCustomerMaybeSingle,
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/billing/ledger", () => ({
  getPointBudget: mockGetPointBudget,
  listLedgerEntries: mockListLedgerEntries,
}));

vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));

vi.mock("@/lib/billing/overage", () => ({
  getOverageCap: mockGetOverageCap,
  hasDirtyOverageLines: mockHasDirtyOverageLines,
  overageRatesForPlan: () => null,
  projectedOverageUsd: () => 0,
}));

vi.mock("@/lib/billing/overage-sync", () => ({
  syncOverageInvoiceItems: vi.fn(),
}));

vi.mock("@/lib/billing/managed-spend", () => ({
  getEffectiveManagedCap: mockGetEffectiveManagedCap,
  getManagedSpendTotal: vi.fn(async () => 0),
  getManagedSpendReservedTotal: vi.fn(async () => 0),
  getManagedSpendEntries: vi.fn(async () => []),
}));

vi.mock("@/lib/billing/trust", () => ({
  getTrustStatus: vi.fn(async () => ({
    plan: "free",
    paidInvoices: 0,
    ceilingUsd: null,
    defaultCapUsd: null,
    nextTier: null,
  })),
}));

vi.mock("@/lib/billing/state", () => ({
  getBillingState: mockGetBillingState,
  isEndedStatus: (status: string | null) =>
    status === "canceled" || status === "incomplete_expired",
}));

vi.mock("@/lib/billing/seats", () => ({
  countMembers: vi.fn(async () => 1),
}));

vi.mock("@/app/actions/billing-portal", () => ({
  openBillingPortal: vi.fn(),
}));

// vi.mock's relative path resolves from THIS file's location (one level
// deeper than page.tsx, under __tests__/), not from page.tsx's own "./"
// specifiers — so these climb one extra level to reach `_components/`.
vi.mock("../_components/plan-actions", () => ({ PlanActions: () => null }));
vi.mock("../_components/overage-cap", () => ({ OverageCap: () => null }));
vi.mock("../_components/managed-spend-cap", () => ({
  ManagedSpendCap: () => null,
}));

import BillingSettingsPage from "../page";

const BASE_BUDGET = {
  plan: "builder" as const,
  included: 50_000,
  balance: 50_000,
  periodStart: "2026-07-01T00:00:00Z",
  periodEnd: "2026-08-01T00:00:00Z",
};

const BASE_BILLING = {
  active: true,
  plan: "builder" as const,
  status: null as string | null,
  priceId: null as string | null,
  currentPeriodStart: null,
  currentPeriodEnd: "2026-08-01T00:00:00Z",
  cancelAtPeriodEnd: false,
  pendingPriceId: null,
  pendingChangeAt: null,
};

async function renderBillingPage() {
  const result = await BillingSettingsPage({
    params: Promise.resolve({ locale: "en" }),
  });
  render(result);
}

describe("BillingSettingsPage trial billing disclosure (#449)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_PRICE_BUILDER = "price_builder_test";
    mockGetAuthContext.mockResolvedValue({ canWrite: true, orgId: "org-1" });
    mockCustomerMaybeSingle.mockResolvedValue({
      data: { stripe_customer_id: "cus_1" },
      error: null,
    });
    mockGetPointBudget.mockResolvedValue(BASE_BUDGET);
    mockListLedgerEntries.mockResolvedValue([]);
    mockGetOverageCap.mockResolvedValue(null);
    mockHasDirtyOverageLines.mockResolvedValue(false);
    mockGetEffectiveManagedCap.mockResolvedValue({
      capUsd: null,
      isDefault: true,
      plan: "builder",
    });
  });

  it("shows the trial billing disclosure under the trial subline while trialing", async () => {
    mockGetBillingState.mockResolvedValue({
      ...BASE_BILLING,
      status: "trialing",
      priceId: "price_builder_test",
    });

    await renderBillingPage();

    expect(screen.getByTestId("plan-status-chip")).toHaveTextContent("Trial");
    expect(screen.getByTestId("trial-billing-disclosure")).toHaveTextContent(
      "Your trial covers the subscription fee. Managed model usage bills to your card as you use it."
    );
  });

  it("omits the trial billing disclosure for a non-trial active subscription", async () => {
    mockGetBillingState.mockResolvedValue({
      ...BASE_BILLING,
      status: "active",
      priceId: "price_builder_test",
    });

    await renderBillingPage();

    expect(screen.queryByTestId("plan-status-chip")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("trial-billing-disclosure")
    ).not.toBeInTheDocument();
  });
});
