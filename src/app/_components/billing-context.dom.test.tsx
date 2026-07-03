// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  BillingProvider,
  usePlan,
  useManagedEstimatePlan,
  useRetentionDays,
} from "./billing-context";
import type { PlanSlug } from "@/lib/billing/plans";

// Harness renders every derived value the context exposes, the same way a real
// consumer (rubric editor, run dialog, retention label) would read one hook each.
function Harness() {
  const plan = usePlan();
  const managedEstimatePlan = useManagedEstimatePlan();
  const retentionDays = useRetentionDays();
  return (
    <div>
      <span data-testid="plan">{plan}</span>
      <span data-testid="managed-estimate-plan">{managedEstimatePlan ?? "none"}</span>
      <span data-testid="retention-days">{retentionDays}</span>
    </div>
  );
}

describe("BillingProvider / usePlan / useManagedEstimatePlan / useRetentionDays", () => {
  it("supplies the seeded plan, managed-estimate plan, and retention days to consumers", () => {
    render(
      <BillingProvider plan="builder" managedEstimatePlan="scale" retentionDays={90}>
        <Harness />
      </BillingProvider>,
    );

    expect(screen.getByTestId("plan")).toHaveTextContent("builder");
    expect(screen.getByTestId("managed-estimate-plan")).toHaveTextContent("scale");
    expect(screen.getByTestId("retention-days")).toHaveTextContent("90");
  });

  it("distinguishes free vs paid (builder) vs the top tier (scale)", () => {
    const cases: { plan: PlanSlug }[] = [{ plan: "free" }, { plan: "builder" }, { plan: "scale" }];

    for (const { plan } of cases) {
      const { unmount } = render(
        <BillingProvider plan={plan} managedEstimatePlan={null}>
          <Harness />
        </BillingProvider>,
      );
      expect(screen.getByTestId("plan")).toHaveTextContent(plan);
      unmount();
    }
  });

  it("defaults plan to free and retentionDays to 14 when omitted", () => {
    render(
      <BillingProvider managedEstimatePlan={null}>
        <Harness />
      </BillingProvider>,
    );

    expect(screen.getByTestId("plan")).toHaveTextContent("free");
    expect(screen.getByTestId("retention-days")).toHaveTextContent("14");
  });

  it("reports no managed-estimate plan when null (BYO/Free — no estimate shown)", () => {
    render(
      <BillingProvider plan="free" managedEstimatePlan={null}>
        <Harness />
      </BillingProvider>,
    );

    expect(screen.getByTestId("managed-estimate-plan")).toHaveTextContent("none");
  });

  it("falls back to free/none/14 for a consumer rendered outside any provider", () => {
    render(<Harness />);

    expect(screen.getByTestId("plan")).toHaveTextContent("free");
    expect(screen.getByTestId("managed-estimate-plan")).toHaveTextContent("none");
    expect(screen.getByTestId("retention-days")).toHaveTextContent("14");
  });

  it("updates consumers when the provider re-renders with new props", () => {
    const { rerender } = render(
      <BillingProvider plan="free" managedEstimatePlan={null} retentionDays={14}>
        <Harness />
      </BillingProvider>,
    );
    expect(screen.getByTestId("plan")).toHaveTextContent("free");
    expect(screen.getByTestId("managed-estimate-plan")).toHaveTextContent("none");
    expect(screen.getByTestId("retention-days")).toHaveTextContent("14");

    rerender(
      <BillingProvider plan="scale" managedEstimatePlan="scale" retentionDays={365}>
        <Harness />
      </BillingProvider>,
    );

    expect(screen.getByTestId("plan")).toHaveTextContent("scale");
    expect(screen.getByTestId("managed-estimate-plan")).toHaveTextContent("scale");
    expect(screen.getByTestId("retention-days")).toHaveTextContent("365");
  });
});
