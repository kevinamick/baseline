import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelectEq, mockRpc, mockDeleteEq, mockLogError } = vi.hoisted(() => ({
  mockSelectEq: vi.fn(),
  mockRpc: vi.fn(),
  mockDeleteEq: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging/server", () => ({
  log: { error: mockLogError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => {
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = () => mockSelectEq();

  // .delete().eq().eq() — resolves on the second .eq().
  const deleteChain: Record<string, unknown> = {};
  deleteChain.eq = () => deleteChain;
  deleteChain.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
    Promise.resolve(mockDeleteEq()).then(onF, onR);

  return {
    supabaseAdmin: {
      from: () => ({
        select: () => selectChain,
        delete: () => deleteChain,
      }),
      rpc: mockRpc,
    },
  };
});

import {
  listProviderKeys,
  getProviderKeyRows,
  upsertProviderKey,
  deleteProviderKeyRow,
} from "../keys";

beforeEach(() => vi.clearAllMocks());

describe("listProviderKeys", () => {
  it("returns masked summaries for stored keys", async () => {
    mockSelectEq.mockResolvedValue({
      data: [
        { provider: "anthropic", last4: "1234", updated_at: "2024-01-01" },
        { provider: "openai", last4: null, updated_at: "2024-01-02" },
      ],
      error: null,
    });
    expect(await listProviderKeys("org-1")).toEqual([
      { provider: "anthropic", last4: "1234", updatedAt: "2024-01-01" },
      { provider: "openai", last4: null, updatedAt: "2024-01-02" },
    ]);
  });

  it("filters out rows with an unrecognized provider", async () => {
    mockSelectEq.mockResolvedValue({
      data: [{ provider: "bogus", last4: "9999", updated_at: "2024-01-01" }],
      error: null,
    });
    expect(await listProviderKeys("org-1")).toEqual([]);
  });

  it("returns an empty list when there are no rows", async () => {
    mockSelectEq.mockResolvedValue({ data: null, error: null });
    expect(await listProviderKeys("org-1")).toEqual([]);
  });

  it("throws when the query errors", async () => {
    const dbError = { message: "boom" };
    mockSelectEq.mockResolvedValue({ data: null, error: dbError });
    await expect(listProviderKeys("org-1")).rejects.toBe(dbError);
  });
});

describe("getProviderKeyRows", () => {
  it("merges every LLM_PROVIDERS entry with stored keys and runtime readiness", async () => {
    mockSelectEq.mockResolvedValue({
      data: [{ provider: "anthropic", last4: "1234", updated_at: "2024-01-01" }],
      error: null,
    });
    const rows = await getProviderKeyRows("org-1");
    const anthropic = rows.find((r) => r.provider === "anthropic");
    expect(anthropic).toEqual({
      provider: "anthropic",
      label: "Anthropic",
      runtimeReady: true,
      last4: "1234",
      hasKey: true,
      updatedAt: "2024-01-01",
    });
    const mistral = rows.find((r) => r.provider === "mistral");
    expect(mistral).toEqual({
      provider: "mistral",
      label: "Mistral",
      runtimeReady: true,
      last4: null,
      hasKey: false,
      updatedAt: null,
    });
    // One row per known provider.
    expect(rows.map((r) => r.provider).sort()).toEqual(
      ["anthropic", "google", "mistral", "openai"].sort()
    );
  });
});

describe("upsertProviderKey", () => {
  it("rejects an empty (whitespace-only) key without calling the RPC", async () => {
    const result = await upsertProviderKey("org-1", "user-1", "anthropic", "   ");
    expect(result).toEqual({ error: "Enter a provider key" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects a malformed key without calling the RPC", async () => {
    const result = await upsertProviderKey("org-1", "user-1", "anthropic", "too-short");
    expect(result).toHaveProperty("error");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("stores a valid key and returns its masked last4", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const key = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234";
    const result = await upsertProviderKey("org-1", "user-1", "anthropic", key);
    expect(result).toEqual({ last4: "1234" });
    expect(mockRpc).toHaveBeenCalledWith("set_provider_key", {
      p_org_id: "org-1",
      p_provider: "anthropic",
      p_secret: key,
      p_last4: "1234",
      p_created_by: "user-1",
    });
  });

  it("trims surrounding whitespace before validating and storing", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const key = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234";
    const result = await upsertProviderKey("org-1", "user-1", "anthropic", `  ${key}  `);
    expect(result).toEqual({ last4: "1234" });
  });

  it("logs and returns a generic error when the RPC fails", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "db down" } });
    const key = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1234";
    const result = await upsertProviderKey("org-1", "user-1", "anthropic", key);
    expect(result).toEqual({ error: "Failed to save the provider key" });
    expect(mockLogError).toHaveBeenCalledWith(
      "set_provider_key failed",
      expect.objectContaining({ org_id: "org-1", provider: "anthropic" })
    );
  });
});

describe("deleteProviderKeyRow", () => {
  it("returns an empty object on success", async () => {
    mockDeleteEq.mockResolvedValue({ error: null });
    expect(await deleteProviderKeyRow("org-1", "anthropic")).toEqual({});
  });

  it("logs and returns an error when the delete fails", async () => {
    mockDeleteEq.mockResolvedValue({ error: { message: "boom" } });
    const result = await deleteProviderKeyRow("org-1", "anthropic");
    expect(result).toEqual({ error: "Failed to remove the provider key" });
    expect(mockLogError).toHaveBeenCalledWith(
      "provider_keys delete failed",
      expect.objectContaining({ org_id: "org-1", provider: "anthropic" })
    );
  });
});
