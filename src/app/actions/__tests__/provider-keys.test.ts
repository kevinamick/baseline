import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

// vi.hoisted: referenced by the hoisted vi.mock factories, which run before
// plain const initializers when the actions are statically imported.
const { mockGetAuthContext, mockTrack, mockUpsert, mockDeleteRow, mockRevalidatePath } = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockTrack: vi.fn(),
  mockUpsert: vi.fn(),
  mockDeleteRow: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("@/lib/analytics/server", () => ({ track: mockTrack }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@/lib/llm/keys", () => ({
  upsertProviderKey: mockUpsert,
  deleteProviderKeyRow: mockDeleteRow,
}));

import { saveProviderKey, deleteProviderKey } from "@/app/actions/provider-keys";

const CONTRIBUTOR = { userId: "u1", orgId: "org1", role: "admin", canWrite: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(CONTRIBUTOR);
  mockUpsert.mockResolvedValue({ last4: "cdef" });
  mockDeleteRow.mockResolvedValue({});
});

describe("saveProviderKey (#184)", () => {
  it("stores the key and returns only the masked last4", async () => {
    const result = await saveProviderKey({ provider: "anthropic", key: "sk-abcdef" });
    expect(result).toEqual({ last4: "cdef" });
    expect(mockUpsert).toHaveBeenCalledWith("org1", "u1", "anthropic", "sk-abcdef");
    // The key value is never echoed back.
    expect(JSON.stringify(result)).not.toContain("sk-abcdef");
  });

  it("rejects a read-only member (Contributor-gated)", async () => {
    mockGetAuthContext.mockResolvedValue({ ...CONTRIBUTOR, role: "member", canWrite: false });
    const result = await saveProviderKey({ provider: "anthropic", key: "sk-x" });
    expect(result).toEqual({ error: "Only contributors can manage provider keys" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null, orgId: null, canWrite: false });
    const result = await saveProviderKey({ provider: "anthropic", key: "sk-x" });
    expect(result).toEqual({ error: "Not authenticated" });
  });

  it("rejects an unknown provider", async () => {
    const result = await saveProviderKey({ provider: "skynet", key: "sk-x" });
    expect(result).toEqual({ error: "Unknown provider" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rejects an empty key", async () => {
    const result = await saveProviderKey({ provider: "anthropic", key: "   " });
    expect(result).toEqual({ error: "Enter a provider key" });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

// #341 regression: keys moved from /settings/api-keys to /settings/team in #203,
// but the save/delete actions kept revalidating the now-dead /settings/api-keys
// route. The cached /settings/team view was therefore never invalidated, so a
// freshly-saved BYO key never appeared and the app silently fell back to the
// managed key. These assertions fail the moment anyone reverts the revalidate
// target to a route that doesn't exist.
describe("#341 — actions revalidate the live /settings/team route", () => {
  // The page module that actually renders the keys UI. If the route is ever moved
  // again (re-breaking #341), this resolves false and the guard below trips even if
  // the string target is left untouched.
  const teamPageExists = existsSync(
    fileURLToPath(
      new URL("../../[locale]/(app)/settings/team/page.tsx", import.meta.url)
    )
  );

  it("saveProviderKey revalidates exactly /settings/team", async () => {
    await saveProviderKey({ provider: "anthropic", key: "sk-abcdef" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings/team");
    expect(mockRevalidatePath).not.toHaveBeenCalledWith("/settings/api-keys");
  });

  it("deleteProviderKey revalidates exactly /settings/team", async () => {
    await deleteProviderKey({ provider: "anthropic" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings/team");
    expect(mockRevalidatePath).not.toHaveBeenCalledWith("/settings/api-keys");
  });

  it("the revalidated route corresponds to a real page module", () => {
    expect(teamPageExists).toBe(true);
  });

  it("does not revalidate on a rejected save (nothing to invalidate)", async () => {
    mockGetAuthContext.mockResolvedValue({ ...CONTRIBUTOR, canWrite: false });
    await saveProviderKey({ provider: "anthropic", key: "sk-abcdef" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteProviderKey (#184)", () => {
  it("removes the key for a Contributor", async () => {
    const result = await deleteProviderKey({ provider: "anthropic" });
    expect(result).toEqual({ ok: true });
    expect(mockDeleteRow).toHaveBeenCalledWith("org1", "anthropic");
  });

  it("rejects a read-only member", async () => {
    mockGetAuthContext.mockResolvedValue({ ...CONTRIBUTOR, role: "member", canWrite: false });
    const result = await deleteProviderKey({ provider: "anthropic" });
    expect(result).toEqual({ error: "Only contributors can manage provider keys" });
    expect(mockDeleteRow).not.toHaveBeenCalled();
  });

  it("surfaces a delete failure", async () => {
    mockDeleteRow.mockResolvedValue({ error: "Failed to remove the provider key" });
    const result = await deleteProviderKey({ provider: "anthropic" });
    expect(result).toEqual({ error: "Failed to remove the provider key" });
  });
});
