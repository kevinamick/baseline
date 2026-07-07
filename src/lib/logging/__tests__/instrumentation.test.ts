import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// onRequestError dynamically imports the analytics + logging modules, both
// `server-only`; stub it so the import graph resolves under the node test env.
vi.mock("server-only", () => ({}));

const mockCaptureException = vi.fn().mockResolvedValue(undefined);
const mockDistinctIdFromCookie = vi.fn().mockReturnValue(null);
vi.mock("@/lib/analytics/server", () => ({
  captureException: mockCaptureException,
  distinctIdFromCookie: mockDistinctIdFromCookie,
}));

const mockLogError = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/logging/server", () => ({
  log: { error: mockLogError, warn: vi.fn(), info: vi.fn() },
}));

const mockRegisterLogging = vi.fn();
vi.mock("@/lib/logging/otel", () => ({ registerLogging: mockRegisterLogging }));

async function importInstrumentation() {
  return import("../../../instrumentation");
}

async function importOnRequestError() {
  const mod = await importInstrumentation();
  return mod.onRequestError;
}

const baseRequest = {
  path: "/dashboard",
  method: "GET",
  headers: { "x-request-id": "req-123", cookie: "" } as Record<
    string,
    string | string[]
  >,
};

const baseContext = {
  routerKind: "App Router" as const,
  routePath: "/dashboard",
  routeType: "render" as const,
  revalidateReason: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDistinctIdFromCookie.mockReturnValue(null);
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("onRequestError → PostHog Logs", () => {
  it("emits a structured error log carrying request_id and route context", async () => {
    const onRequestError = await importOnRequestError();
    const error = new Error("boom");

    await onRequestError(error, baseRequest, baseContext);

    expect(mockLogError).toHaveBeenCalledWith(
      "Unhandled server error",
      expect.objectContaining({
        request_id: "req-123",
        path: "/dashboard",
        method: "GET",
        route_path: "/dashboard",
        route_type: "render",
        error,
      })
    );
  });

  it("still reports the exception to error tracking alongside the log", async () => {
    const onRequestError = await importOnRequestError();
    const error = new Error("boom");

    await onRequestError(error, baseRequest, baseContext);

    expect(mockCaptureException).toHaveBeenCalledWith(error, "anonymous");
  });

  it("normalizes a multi-value x-request-id header to its first entry", async () => {
    const onRequestError = await importOnRequestError();

    await onRequestError(
      new Error("boom"),
      { ...baseRequest, headers: { "x-request-id": ["req-a", "req-b"] } },
      baseContext
    );

    expect(mockLogError).toHaveBeenCalledWith(
      "Unhandled server error",
      expect.objectContaining({ request_id: "req-a" })
    );
  });

  it("omits request_id when the proxy header is absent", async () => {
    const onRequestError = await importOnRequestError();

    await onRequestError(
      new Error("boom"),
      { ...baseRequest, headers: {} },
      baseContext
    );

    expect(mockLogError).toHaveBeenCalledWith(
      "Unhandled server error",
      expect.objectContaining({ request_id: undefined })
    );
  });

  it("does nothing outside the nodejs runtime (edge bundle stays clean)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const onRequestError = await importOnRequestError();

    await onRequestError(new Error("boom"), baseRequest, baseContext);

    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe("register()", () => {
  it("registers PostHog Logs under the nodejs runtime", async () => {
    const { register } = await importInstrumentation();

    await register();

    expect(mockRegisterLogging).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the nodejs runtime (edge bundle stays clean)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { register } = await importInstrumentation();

    await register();

    expect(mockRegisterLogging).not.toHaveBeenCalled();
  });
});
