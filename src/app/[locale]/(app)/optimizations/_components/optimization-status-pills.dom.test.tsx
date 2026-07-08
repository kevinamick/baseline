// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../messages/en.json";
import { OptimizationStatusPills } from "./optimization-status-pills";

function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("OptimizationStatusPills", () => {
  it("shows an empty, ready slot as 0/1 Active Runs", () => {
    render(<OptimizationStatusPills hasActiveRun={false} runsRemaining={15} />);
    expect(screen.getByText("0/1 Active Runs")).toBeInTheDocument();
  });

  it("shows an occupied slot as 1/1 Active Runs", () => {
    render(<OptimizationStatusPills hasActiveRun runsRemaining={15} />);
    expect(screen.getByText("1/1 Active Runs")).toBeInTheDocument();
  });

  it("renders the monthly balance independently of the concurrency slot, decrementing with usage", () => {
    render(<OptimizationStatusPills hasActiveRun={false} runsRemaining={14} />);
    expect(screen.getByText("14 Runs Left")).toBeInTheDocument();
  });

  it("singularizes a one-run balance", () => {
    render(<OptimizationStatusPills hasActiveRun={false} runsRemaining={1} />);
    expect(screen.getByText("1 Run Left")).toBeInTheDocument();
  });

  it("keeps the monthly balance shown even while a run occupies the active slot", () => {
    render(<OptimizationStatusPills hasActiveRun runsRemaining={14} />);
    expect(screen.getByText("1/1 Active Runs")).toBeInTheDocument();
    expect(screen.getByText("14 Runs Left")).toBeInTheDocument();
  });
});
