// Local stand-in for the LLM providers' list-models endpoints (#485), reached by the app's
// live-model listing (src/lib/llm/live-models.ts) via the operator-only *_API_BASE_OVERRIDE env
// vars (playwright.config.ts points them here for the whole e2e run) — the documented mock seam,
// no app-code backdoor. Behavior is STATIC per provider, so no spec ever toggles process-wide
// state (unlike the PostHog mock) and the spec can run in the ordinary parallel pool:
//
//   - OpenAI  (/openai/v1/models)  → 200 with the curated gpt-5 models PLUS one extra chat model
//     ("gpt-5.3-preview") and non-chat noise the shared filter must drop — the SUCCESS path a
//     BYO-OpenAI Team (Team D) sees.
//   - Mistral (/mistral/v1/models) → 500 — the FAILURE path: a BYO-Mistral Team's optgroup must
//     stay exactly the curated list, with no user-facing error.
//   - Anthropic/Google → 500 — hermeticity: no e2e page render can ever reach a real provider
//     host with a seeded dummy key.
//
// GET /__mock__/health answers 200 for Playwright's webServer readiness probe.

import { createServer } from "node:http";

const PORT = Number(process.env.PROVIDER_MODELS_MOCK_PORT ?? 4311);

const OPENAI_MODELS = {
  data: [
    { id: "gpt-5" },
    { id: "gpt-5-mini" },
    // The one extra chat-capable model the e2e spec asserts a BYO Team can see and select.
    { id: "gpt-5.3-preview" },
    // Non-chat noise: the shared chat-capable filter (worker/src/providers/model-filter.ts)
    // must keep every one of these out of the wizard.
    { id: "whisper-1" },
    { id: "gpt-4o-audio-preview" },
    { id: "text-embedding-3-small" },
    { id: "gpt-image-1" },
  ],
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/__mock__/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/openai/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(OPENAI_MODELS));
    return;
  }

  // Mistral (and any other provider path) fails: the progressive-enhancement fallback path.
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "provider-models-mock: simulated outage" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`provider-models mock listening on http://127.0.0.1:${PORT}`);
});
