import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: referenced inside the hoisted vi.mock factories below.
const { mockSignInWithPassword, mockSignUp, mockSignOut, mockRedirect } =
  vi.hoisted(() => ({
    mockSignInWithPassword: vi.fn(),
    mockSignUp: vi.fn(),
    mockSignOut: vi.fn(),
    mockRedirect: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signUp: mockSignUp,
      signOut: mockSignOut,
    },
  })),
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

import { signIn, signUp, signOut } from "../auth";

function fd(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("signIn", () => {
  it("redirects to /dashboard on success", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });
    await signIn({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "a@b.com",
      password: "secret1",
    });
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("returns the provider error without redirecting", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const result = await signIn({}, fd({ email: "a@b.com", password: "nope" }));
    expect(result).toEqual({ error: "Invalid login credentials" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("validates that email and password are present", async () => {
    const result = await signIn({}, fd({ email: "", password: "" }));
    expect(result).toEqual({ error: "Email and password are required." });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });
});

describe("signUp", () => {
  it("reports emailSent when confirmation is required (no session yet)", async () => {
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null });
    const result = await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ emailSent: true });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects straight in when signUp returns a live session (confirmations off)", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: { access_token: "t" } },
      error: null,
    });
    await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("returns the provider error", async () => {
    mockSignUp.mockResolvedValue({
      data: { session: null },
      error: { message: "User already registered" },
    });
    const result = await signUp({}, fd({ email: "a@b.com", password: "secret1" }));
    expect(result).toEqual({ error: "User already registered" });
  });
});

describe("signOut", () => {
  it("signs out and redirects home", async () => {
    mockSignOut.mockResolvedValue({ error: null });
    await signOut();
    expect(mockSignOut).toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });
});
