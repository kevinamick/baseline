import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// after() runs post-response in prod; invoke the callback inline in tests so the
// deferred warn log fires and its assertions hold.
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logging/server", () => ({ log: { warn } }));

import { requireInternalSecret } from "../internal-secret";

const ENV = "TEST_INTERNAL_SECRET";
const ROUTE = "billing.test";

function req(auth?: string): Request {
  return new Request("http://localhost/api/internal/test", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("requireInternalSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[ENV] = "s3cr3t";
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  it("returns null (proceed) on a matching bearer secret and logs nothing", () => {
    expect(requireInternalSecret(req("Bearer s3cr3t"), ENV, ROUTE)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("503s and logs when the secret env var is not configured", () => {
    delete process.env[ENV];
    const res = requireInternalSecret(req("Bearer s3cr3t"), ENV, ROUTE);
    expect(res?.status).toBe(503);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "internal_route.secret_not_configured",
        route: ROUTE,
        env_var: ENV,
      })
    );
  });

  it("401s and logs on a wrong bearer secret", () => {
    const res = requireInternalSecret(req("Bearer nope"), ENV, ROUTE);
    expect(res?.status).toBe(401);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "internal_route.unauthorized", route: ROUTE })
    );
  });

  it("401s and logs on an absent authorization header", () => {
    const res = requireInternalSecret(req(), ENV, ROUTE);
    expect(res?.status).toBe(401);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "internal_route.unauthorized", route: ROUTE })
    );
  });

  it("does not leak the env var name on the unauthorized (attacker-reachable) path", () => {
    requireInternalSecret(req("Bearer nope"), ENV, ROUTE);
    const attrs = warn.mock.calls[0][1];
    expect(attrs).not.toHaveProperty("env_var");
  });
});
