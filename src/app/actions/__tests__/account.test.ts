import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockUpdateUser, mockRevalidatePath } = vi.hoisted(() => ({
  mockUpdateUser: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      updateUser: mockUpdateUser,
    },
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

import { updateProfile, changeEmail, changePassword } from "../account";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateProfile", () => {
  it("saves the trimmed display name onto user metadata and revalidates", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await updateProfile({}, fd({ name: "  Ada Lovelace  " }));
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { name: "Ada Lovelace" } });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/settings/account");
    expect(result).toEqual({ saved: true });
  });

  it("allows clearing the name to empty", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await updateProfile({}, fd({ name: "   " }));
    expect(mockUpdateUser).toHaveBeenCalledWith({ data: { name: "" } });
    expect(result).toEqual({ saved: true });
  });

  it("returns the provider error without revalidating", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "nope" } });
    const result = await updateProfile({}, fd({ name: "Ada" }));
    expect(result).toEqual({ error: "nope" });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("changeEmail", () => {
  it("requests the email change and reports emailSent", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await changeEmail({}, fd({ email: "  new@b.com " }));
    expect(mockUpdateUser).toHaveBeenCalledWith({ email: "new@b.com" });
    expect(result).toEqual({ emailSent: true });
  });

  it("validates that an email is present", async () => {
    const result = await changeEmail({}, fd({ email: "  " }));
    expect(result).toEqual({ error: "Enter a new email address." });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("returns the provider error", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "already in use" } });
    const result = await changeEmail({}, fd({ email: "new@b.com" }));
    expect(result).toEqual({ error: "already in use" });
  });
});

describe("changePassword", () => {
  it("sets the new password when both fields match", async () => {
    mockUpdateUser.mockResolvedValue({ error: null });
    const result = await changePassword(
      {},
      fd({ password: "secret1", confirmPassword: "secret1" })
    );
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: "secret1" });
    expect(result).toEqual({ saved: true });
  });

  it("rejects passwords shorter than 6 characters before calling the provider", async () => {
    const result = await changePassword(
      {},
      fd({ password: "abc", confirmPassword: "abc" })
    );
    expect(result).toEqual({ error: "Password must be at least 6 characters." });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("rejects mismatched confirmation before calling the provider", async () => {
    const result = await changePassword(
      {},
      fd({ password: "secret1", confirmPassword: "secret2" })
    );
    expect(result).toEqual({ error: "Passwords don't match." });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("returns the provider error", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "weak password" } });
    const result = await changePassword(
      {},
      fd({ password: "secret1", confirmPassword: "secret1" })
    );
    expect(result).toEqual({ error: "weak password" });
  });
});
