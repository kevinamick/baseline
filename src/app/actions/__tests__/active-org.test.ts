import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAuthContext,
  mockRevalidate,
  mockCookieSet,
  mockMembership,
} = vi.hoisted(() => ({
  mockGetAuthContext: vi.fn(),
  mockRevalidate: vi.fn(),
  mockCookieSet: vi.fn(),
  mockMembership: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({ getAuthContext: mockGetAuthContext }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mockCookieSet })),
}));

// Membership validation: chain whose terminal `maybeSingle` resolves the row.
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = () => Promise.resolve(mockMembership());
  return { supabaseAdmin: { from: () => chain } };
});

import { switchOrg } from "../active-org";
import { ACTIVE_ORG_COOKIE } from "@/lib/auth/active-org";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue({ userId: "user-1" });
  mockMembership.mockResolvedValue({ data: { org_id: "org-2" } });
});

describe("switchOrg", () => {
  it("sets the active-org cookie for an org the user belongs to", async () => {
    await switchOrg(fd({ orgId: "org-2" }));
    expect(mockCookieSet).toHaveBeenCalledWith(
      ACTIVE_ORG_COOKIE,
      "org-2",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" })
    );
    expect(mockRevalidate).toHaveBeenCalledWith("/", "layout");
  });

  it("ignores a forged switch to an org the user isn't a member of", async () => {
    mockMembership.mockResolvedValue({ data: null });
    await switchOrg(fd({ orgId: "not-mine" }));
    expect(mockCookieSet).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("no-ops when signed out", async () => {
    mockGetAuthContext.mockResolvedValue({ userId: null });
    await switchOrg(fd({ orgId: "org-2" }));
    expect(mockCookieSet).not.toHaveBeenCalled();
  });

  it("no-ops when no orgId is provided", async () => {
    await switchOrg(fd({}));
    expect(mockCookieSet).not.toHaveBeenCalled();
  });
});
