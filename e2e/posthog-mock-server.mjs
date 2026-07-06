// A minimal local stand-in for PostHog's `/flags` decide endpoint, used ONLY to
// e2e-exercise the launch-phase sign-up gate's full failure matrix (ADR-0017,
// #425 — see e2e/signup-gate.spec.ts and src/lib/analytics/signup-gate.ts).
//
// The app's `isSignupGated()` helper points its OWN `POSTHOG_HOST` (not the
// client bundle's NEXT_PUBLIC_POSTHOG_HOST — see signup-gate.ts for why) at
// this server for the whole e2e run (wired via playwright.config.ts's
// `webServer[0].env`). Everything else in the suite is unaffected: this process
// implements nothing but the one endpoint posthog-node's `isFeatureEnabled`
// calls, and defaults to "off" so every pre-existing spec that merely navigates
// through /sign-up sees the same ungated behavior as before a mock existed.
//
// Control surface (called directly by e2e/signup-gate.spec.ts via fetch, never
// through the browser):
//   POST /__mock__/state  { "state": "on" | "off" | "error" | "timeout" }
//   GET  /__mock__/state  -> { "state": "..." }
//
// Decide surface (called by the app's posthog-node client):
//   POST /flags/*  -> a `{ featureFlags: { "signup-access-code-gate": bool } }`
//                     body for "on"/"off", a 500 for "error", or a response
//                     delayed well past the app's fail-closed timeout for
//                     "timeout" (never a force-closed socket — a slow-but-alive
//                     upstream is the realistic outage shape this exercises).
import { createServer } from "node:http";

const PORT = Number(process.env.POSTHOG_MOCK_PORT ?? 4310);
const FLAG = "signup-access-code-gate";
const TIMEOUT_DELAY_MS = 5_000; // longer than signup-gate.ts's FLAG_EVAL_TIMEOUT_MS (3s)

/** @type {"on" | "off" | "error" | "timeout"} */
let state = "off";

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/__mock__/state") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body || "{}");
      if (!["on", "off", "error", "timeout"].includes(parsed.state)) {
        sendJson(res, 400, { error: "state must be on|off|error|timeout" });
        return;
      }
      state = parsed.state;
      sendJson(res, 200, { ok: true, state });
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/__mock__/state") {
    sendJson(res, 200, { state });
    return;
  }

  if (url.pathname.startsWith("/flags")) {
    if (state === "error") {
      sendJson(res, 500, { error: "mock PostHog decide failure" });
      return;
    }
    if (state === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, TIMEOUT_DELAY_MS));
      sendJson(res, 200, { featureFlags: { [FLAG]: false } });
      return;
    }
    sendJson(res, 200, { featureFlags: { [FLAG]: state === "on" } });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[posthog-mock] listening on http://127.0.0.1:${PORT} (state=${state})`);
});
