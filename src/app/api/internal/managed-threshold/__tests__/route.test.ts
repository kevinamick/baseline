import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// requireInternalSecret defers its refusal-path warn logs through next/server's
// after(); invoke the callback inline so the 503/401 paths don't throw outside a
// request scope (matches internal-secret.test.ts / claim-reserve's route.test.ts).
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));

const { mockOrgsWithUninvoicedManagedSpend, mockSyncManagedInvoiceLines } = vi.hoisted(
  () => ({
    mockOrgsWithUninvoicedManagedSpend: vi.fn(),
    mockSyncManagedInvoiceLines: vi.fn(),
  })
);
vi.mock("@/lib/billing/managed-invoice-sync", () => ({
  orgsWithUninvoicedManagedSpend: mockOrgsWithUninvoicedManagedSpend,
  syncManagedInvoiceLines: mockSyncManagedInvoiceLines,
}));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "../route";
import { log } from "@/lib/logging/server";

function post(auth?: string): Request {
  return new Request("http://localhost/api/internal/managed-threshold", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

const SECRET = "test-managed-threshold-secret";

describe("POST /api/internal/managed-threshold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MANAGED_THRESHOLD_SECRET = SECRET;
    mockOrgsWithUninvoicedManagedSpend.mockResolvedValue([]);
    mockSyncManagedInvoiceLines.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.MANAGED_THRESHOLD_SECRET;
  });

  it("503 when the secret is not configured (fail closed)", async () => {
    delete process.env.MANAGED_THRESHOLD_SECRET;
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(mockOrgsWithUninvoicedManagedSpend).not.toHaveBeenCalled();
  });

  it("401 on a wrong or absent bearer secret", async () => {
    expect((await POST(post("Bearer nope"))).status).toBe(401);
    expect((await POST(post())).status).toBe(401);
    expect(mockOrgsWithUninvoicedManagedSpend).not.toHaveBeenCalled();
  });

  it("sweeps zero orgs and reports the count", async () => {
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 0 });
    expect(mockSyncManagedInvoiceLines).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "managed threshold sweep processed",
      expect.objectContaining({
        event: "billing.managed_threshold_swept",
        org_count: 0,
      })
    );
  });

  it("syncs managed invoice lines sequentially for every org with uninvoiced spend", async () => {
    mockOrgsWithUninvoicedManagedSpend.mockResolvedValue(["org-1", "org-2", "org-3"]);
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 3 });
    expect(mockSyncManagedInvoiceLines).toHaveBeenCalledTimes(3);
    expect(mockSyncManagedInvoiceLines).toHaveBeenNthCalledWith(1, "org-1");
    expect(mockSyncManagedInvoiceLines).toHaveBeenNthCalledWith(2, "org-2");
    expect(mockSyncManagedInvoiceLines).toHaveBeenNthCalledWith(3, "org-3");
  });
});
