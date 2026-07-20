import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

/**
 * Overage-headroom gating on the optimizations page (CR-6).
 *
 * Overage is a paid-plan concept (ADR-0016's dual meter): once a PAID Team's
 * included runs are gone an extra run draws Eval Points, so "+ New run" stays
 * live. Free must never get headroom — it would keep the button live and then
 * either refuse at reserve or drain the Free plan's included Eval Points.
 *
 * The page used to identify Free as `included === 0`. Giving Free a lifetime
 * included run (this PR) invalidated that proxy, so these tests pin the gate to
 * the plan itself and would fail if it regressed to an `included`-based check.
 */

const mockGetAuthContext = vi.fn();
const mockGetOptimizationAllowance = vi.fn();
const mockRpc = vi.fn();
const mockGetOverageCap = vi.fn();
const mockListOptimizationRuns = vi.fn();

// These modules carry `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next-intl/server", () => {
  const t = (key: string) => key;
  t.rich = (key: string) => key;
  return { setRequestLocale: vi.fn(), getTranslations: vi.fn(async () => t) };
});
vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/billing/allowance", () => ({
  getOptimizationAllowance: mockGetOptimizationAllowance,
}));
vi.mock("@/app/actions/optimizations", () => ({
  listOptimizationRuns: mockListOptimizationRuns,
}));
vi.mock("@/app/actions/eval-runs", () => ({
  listEvalRunsForInstanceSeed: vi.fn(async () => []),
}));
vi.mock("@/lib/llm/usable-providers", () => ({
  usableProvidersForOrg: vi.fn(async () => []),
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mockRpc } }));
// Every tenant read on this page resolves to an empty list; the headroom branch
// under test depends only on the allowance and the point-balance RPC.
vi.mock("@/lib/supabase/tenant-db", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: async () => ({ data: [], error: null }),
  };
  return { tenantDb: () => ({ from: () => chain }) };
});
// Keep the real overage math; only the DB-backed cap read is stubbed.
vi.mock("@/lib/billing/overage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/overage")>()),
  getOverageCap: mockGetOverageCap,
}));
// Leaf components are never invoked (React elements are lazy), but stub them so
// the import graph stays free of client-only modules.
vi.mock("@/app/_components/status-pill", () => ({ StatusPill: () => null }));
const LayoutStub = () => null;
vi.mock("../_components/optimizations-layout", () => ({
  OptimizationsLayout: LayoutStub,
}));

/** Depth-first search for the first element of the given component type. */
function findElement(node: unknown, type: unknown): ReactElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<{ children?: unknown }>;
  if (el.type === type) return el;
  return findElement(el.props?.children, type);
}

/** Render the page and read the allowance the layout was handed. */
async function layoutAllowance() {
  const { default: Page } = await import("../page");
  const tree = await Page({ params: Promise.resolve({ locale: "en" }) });
  const layout = findElement(tree, LayoutStub);
  expect(layout, "OptimizationsLayout was not rendered").not.toBeNull();
  const props = layout!.props as {
    isPaid: boolean;
    allowance: { overageHeadroom: boolean };
  };
  return { overageHeadroom: props.allowance.overageHeadroom, isPaid: props.isPaid };
}

describe("OptimizationsPage overage headroom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue({
      userId: "user-1",
      orgId: "org-1",
      canWrite: true,
    });
    mockListOptimizationRuns.mockResolvedValue([]);
    mockGetOverageCap.mockResolvedValue(null);
  });

  const allowance = (over: Record<string, unknown>) => ({
    plan: "free",
    included: 1,
    lifetime: true,
    remaining: 0,
    maxBudgetRollouts: 100,
    periodStart: "2026-07-01",
    ...over,
  });

  it("denies headroom to a Free Team that has spent its lifetime run", async () => {
    // The regression guard: Free's included is 1, so an `included > 0` gate
    // would fall through to the point balance and hand out headroom.
    mockGetOptimizationAllowance.mockResolvedValue(allowance({}));
    mockRpc.mockResolvedValue({ data: 5000, error: null });

    const { overageHeadroom, isPaid } = await layoutAllowance();

    expect(isPaid).toBe(false);
    expect(overageHeadroom).toBe(false);
  });

  it("does not even read the point balance for a Free Team", async () => {
    mockGetOptimizationAllowance.mockResolvedValue(allowance({}));
    mockRpc.mockResolvedValue({ data: 5000, error: null });

    await layoutAllowance();

    // Free's included Eval Points must never be treated as optimization headroom.
    expect(mockRpc).not.toHaveBeenCalledWith("point_balance", expect.anything());
  });

  it("grants headroom to a paid Team with exhausted runs and a positive balance", async () => {
    mockGetOptimizationAllowance.mockResolvedValue(
      allowance({ plan: "builder", included: 15, lifetime: false, remaining: 0 })
    );
    mockRpc.mockResolvedValue({ data: 5000, error: null });

    const { overageHeadroom, isPaid } = await layoutAllowance();

    expect(isPaid).toBe(true);
    expect(overageHeadroom).toBe(true);
  });

  it("denies headroom to a paid Team with no balance and no overage cap", async () => {
    mockGetOptimizationAllowance.mockResolvedValue(
      allowance({ plan: "builder", included: 15, lifetime: false, remaining: 0 })
    );
    mockRpc.mockResolvedValue({ data: 0, error: null });
    mockGetOverageCap.mockResolvedValue(null);

    const { overageHeadroom } = await layoutAllowance();

    expect(overageHeadroom).toBe(false);
  });

  it("leaves headroom off for a paid Team that still has runs left", async () => {
    mockGetOptimizationAllowance.mockResolvedValue(
      allowance({ plan: "builder", included: 15, lifetime: false, remaining: 3 })
    );

    const { overageHeadroom } = await layoutAllowance();

    expect(overageHeadroom).toBe(false);
    expect(mockRpc).not.toHaveBeenCalledWith("point_balance", expect.anything());
  });
});
