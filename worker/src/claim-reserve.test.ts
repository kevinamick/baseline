import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./log.js", () => ({ log: { error: vi.fn(), info: vi.fn() } }));

import { claimReserve, billingBlockedMessage } from "./claim-reserve.js";

const APP = "https://app.test";

describe("claimReserve", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.CLAIM_RESERVE_SECRET = "s3cret";
  });
  afterEach(() => {
    delete process.env.CLAIM_RESERVE_SECRET;
  });

  it("fails closed when the secret is unconfigured (no request made)", async () => {
    delete process.env.CLAIM_RESERVE_SECRET;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await claimReserve("r1", APP)).toEqual({ allowed: false, reason: "billing_unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the app with the bearer secret and returns the decision", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ allowed: false, reason: "seat_cap" }), { status: 200 }),
    );
    const decision = await claimReserve("run-7", APP);
    expect(decision).toEqual({ allowed: false, reason: "seat_cap" });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://app.test/api/internal/claim-reserve");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(init!.body as string)).toEqual({ runId: "run-7" });
  });

  it("passes an allow decision through", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ allowed: true }), { status: 200 }),
    );
    expect(await claimReserve("r", APP)).toEqual({ allowed: true });
  });

  it("fails closed on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    expect(await claimReserve("r", APP)).toEqual({ allowed: false, reason: "billing_unavailable" });
  });

  it("fails closed when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await claimReserve("r", APP)).toEqual({ allowed: false, reason: "billing_unavailable" });
  });
});

describe("billingBlockedMessage", () => {
  it("maps each reason to distinct, actionable copy", () => {
    expect(billingBlockedMessage("seat_cap")).toMatch(/members than its plan/i);
    expect(billingBlockedMessage("insufficient_points")).toMatch(/out of Eval Points/i);
    expect(billingBlockedMessage("billing_unavailable")).toMatch(/couldn't verify/i);
    expect(billingBlockedMessage("anything-else")).toMatch(/couldn't verify/i);
  });
});
