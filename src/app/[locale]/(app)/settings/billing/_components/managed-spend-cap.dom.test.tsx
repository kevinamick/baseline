// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../../messages/en.json";
import { ManagedSpendCap } from "./managed-spend-cap";

// #470: accrued spend and in-flight reserved dollars must render as separate
// figures that don't collapse into one another — the prod incident this
// closes was a $13.52 in-flight reservation reading as "$1 used" because the
// billing page only ever showed accrued spend.
//
// `onError` rethrows on a missing message so a key the component calls that
// isn't in the catalog fails the render (mirrors connections-list.dom.test.tsx,
// #363's regression guard).
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      timeZone="UTC"
      onError={(error) => {
        if (error.code === "MISSING_MESSAGE") throw error;
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
}
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: Wrapper });
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/app/actions/billing-managed-spend", () => ({
  setManagedSpendCap: vi.fn(),
  resetManagedSpendCap: vi.fn(),
}));

const BASE_PROPS = {
  capUsd: 25,
  isDefault: true,
  defaultCapUsd: 25,
  markupPct: 40,
  ceilingUsd: 100,
  nextTier: null,
};

describe("ManagedSpendCap reserved-in-flight display (#470)", () => {
  it("shows accrued spend and reserved-in-flight as two separate figures", () => {
    render(<ManagedSpendCap {...BASE_PROPS} spentUsd={1.5} reservedUsd={13.52} />);

    const usage = screen.getByTestId("managed-spend-usage");
    expect(usage).toHaveTextContent("$1.50");
    // The accrued figure must not also carry the reserved dollars merged in —
    // this is the exact bug: a $13.52 hold reading as spend.
    expect(usage).not.toHaveTextContent("13.52");

    const reserved = screen.getByTestId("managed-spend-reserved");
    expect(reserved).toHaveTextContent("$13.52");
    expect(reserved).toHaveTextContent("reserved by runs in flight");
  });

  it("collapses the reserved line entirely when nothing is in flight", () => {
    render(<ManagedSpendCap {...BASE_PROPS} spentUsd={4.2} reservedUsd={0} />);

    expect(screen.getByTestId("managed-spend-usage")).toHaveTextContent("$4.20");
    expect(screen.queryByTestId("managed-spend-reserved")).not.toBeInTheDocument();
  });

  it("reconciles with the ledger: reserved is independent of accrued, not derived from it", () => {
    // reserve 17.52 (two runs: 13.52 + 4) + accrue 1.5 − release 13.52 (run 1
    // settles) — mirrors the migration's managed_spend_reserved_total math
    // (see managed-metering.integration.test.ts's #470 case for the full
    // ledger-level proof against the real RPC).
    const accrued = 1.5;
    const reservedAfterOneSettles = 4; // only run 2's hold remains
    render(<ManagedSpendCap {...BASE_PROPS} spentUsd={accrued} reservedUsd={reservedAfterOneSettles} />);

    expect(screen.getByTestId("managed-spend-usage")).toHaveTextContent("$1.50");
    expect(screen.getByTestId("managed-spend-reserved")).toHaveTextContent("$4.00");
  });
});
