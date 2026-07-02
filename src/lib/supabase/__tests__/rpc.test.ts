import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: mockRpc },
}));

import { rpcOrThrow } from "../rpc";

beforeEach(() => vi.clearAllMocks());

describe("rpcOrThrow", () => {
  it("returns the RPC's data on success", async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    expect(await rpcOrThrow("my_fn", { a: 1 })).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith("my_fn", { a: 1 });
  });

  it("calls the RPC with no args when omitted", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await rpcOrThrow("my_fn");
    expect(mockRpc).toHaveBeenCalledWith("my_fn", undefined);
  });

  it("throws a canonical '<fn> failed: <message>' error when the RPC errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "constraint violated" } });
    await expect(rpcOrThrow("settle_run", { id: 1 })).rejects.toThrow(
      "settle_run failed: constraint violated"
    );
  });
});
