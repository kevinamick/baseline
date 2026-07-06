import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: mockRpc },
}));

import { rpcOrThrow, readRpcOrThrow } from "../rpc";

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

describe("readRpcOrThrow", () => {
  it("returns the RPC's data on success without retrying", async () => {
    mockRpc.mockResolvedValue({ data: 42, error: null });
    expect(await readRpcOrThrow("managed_spend_total", { a: 1 })).toBe(42);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("retries once on a transient upstream gateway error, then succeeds", async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: null,
        error: { message: "An invalid response was received from the upstream server" },
      })
      .mockResolvedValueOnce({ data: 7, error: null });
    expect(await readRpcOrThrow("managed_spend_total", { a: 1 })).toBe(7);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("re-throws when the retry also fails", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "upstream connect error" },
    });
    await expect(readRpcOrThrow("managed_spend_total", { a: 1 })).rejects.toThrow(
      "managed_spend_total failed: upstream connect error"
    );
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient error (e.g. a real constraint violation)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "constraint violated" } });
    await expect(readRpcOrThrow("point_balance", { a: 1 })).rejects.toThrow(
      "point_balance failed: constraint violated"
    );
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});
