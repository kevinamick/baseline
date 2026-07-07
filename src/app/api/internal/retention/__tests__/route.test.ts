import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// requireInternalSecret defers its refusal-path warn logs through next/server's
// after(); invoke the callback inline so the 503/401 paths don't throw outside a
// request scope (matches internal-secret.test.ts / claim-reserve's route.test.ts).
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));

const { mockRetentionCandidateOrgs, mockSweepRetentionForOrg } = vi.hoisted(() => ({
  mockRetentionCandidateOrgs: vi.fn(),
  mockSweepRetentionForOrg: vi.fn(),
}));
vi.mock("@/lib/billing/retention", () => ({
  retentionCandidateOrgs: mockRetentionCandidateOrgs,
  sweepRetentionForOrg: mockSweepRetentionForOrg,
}));
vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "../route";
import { log } from "@/lib/logging/server";

function post(auth?: string): Request {
  return new Request("http://localhost/api/internal/retention", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

const SECRET = "test-retention-secret";

describe("POST /api/internal/retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RETENTION_SECRET = SECRET;
    mockRetentionCandidateOrgs.mockResolvedValue([]);
    mockSweepRetentionForOrg.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.RETENTION_SECRET;
  });

  it("503 when the secret is not configured (fail closed)", async () => {
    delete process.env.RETENTION_SECRET;
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(mockRetentionCandidateOrgs).not.toHaveBeenCalled();
  });

  it("401 on a wrong or absent bearer secret", async () => {
    expect((await POST(post("Bearer nope"))).status).toBe(401);
    expect((await POST(post())).status).toBe(401);
    expect(mockRetentionCandidateOrgs).not.toHaveBeenCalled();
  });

  it("sweeps zero orgs and reports the count", async () => {
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 0 });
    expect(mockSweepRetentionForOrg).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "retention sweep processed",
      expect.objectContaining({ event: "billing.retention_swept", org_count: 0 })
    );
  });

  it("sweeps retention sequentially for every candidate org", async () => {
    mockRetentionCandidateOrgs.mockResolvedValue(["org-a", "org-b"]);
    const res = await POST(post(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ swept: 2 });
    expect(mockSweepRetentionForOrg).toHaveBeenCalledTimes(2);
    expect(mockSweepRetentionForOrg).toHaveBeenNthCalledWith(1, "org-a");
    expect(mockSweepRetentionForOrg).toHaveBeenNthCalledWith(2, "org-b");
  });
});
