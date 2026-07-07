// Mock System for end-to-end testing of Schedules. Serves BOTH connection kinds:
// Zero deps — run: `node scripts/mock-agent.mjs`
//
//   agent  kind  →  POST /agent : body {"input":"{{user_input}}"}, response path `output`
//   dataset kind →  GET  /logs  : returns {"data":[{prompt, completion}, …]}, rows path `data`,
//                                  field map user_input=prompt, agent_output=completion
//
// The GET /logs endpoint honors the custom-dataset query params the worker renders:
//   ?from={{window_start}}&to={{window_end}}&limit={{max_rows}}  (only `limit` changes output here).
//
// Optional auth: set MOCK_AGENT_TOKEN to require `Authorization: Bearer <token>` on both routes.
// Set MOCK_LOGS_EMPTY=1 to make /logs return zero rows (to exercise the `skipped` status).

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_AGENT_PORT ?? 8787);
const TOKEN = process.env.MOCK_AGENT_TOKEN || null;
const LOGS_EMPTY = process.env.MOCK_LOGS_EMPTY === "1";

// Canned answers so rubric scores are meaningful. Most are good; the fallback is
// deliberately vague so at least one input scores lower — a realistic spread.
const KB = [
  {
    match: /reset.*password|forgot.*password/i,
    answer:
      "To reset your password, click “Forgot password” on the sign-in page, enter your email, and follow the link we send you. The link expires in 30 minutes.",
  },
  {
    match: /refund/i,
    answer:
      "We offer a full refund within 30 days of purchase, no questions asked. Email billing@acme.test or use Billing → Request refund in the app.",
  },
  {
    match: /hours|when.*open|available/i,
    answer:
      "Our support team is available Monday–Friday, 9am–6pm Eastern. You can message us anytime and we’ll reply the next business day.",
  },
  {
    match: /export.*data|download.*data/i,
    answer:
      "Yes — go to Settings → Data → Export to download everything as a ZIP of CSV files. Large accounts may take a few minutes.",
  },
];

function answerFor(input) {
  const hit = KB.find((k) => k.match.test(input));
  if (hit) return hit.answer;
  // Weak fallback (no real answer) — should score lower on accuracy/completeness.
  return "Thanks for reaching out! Someone from our team will look into that and get back to you.";
}

// --- Prompt sensitivity (optimization-loop demos) -------------------------------------------
// When the request carries injected {{prompt:*}} Modules (a `system` field is present), the
// answer quality scales with how instructive the injected prompts are. This lets a GEPA
// optimization run demonstrate real improvement: a weak seed ("Answer."/"Reply.") yields poor
// output, while a reflected, detailed prompt unlocks the full KB answer. `system` drives
// accuracy/completeness; `style` drives tone. Requests with only {"input": ...} (the eval and
// schedule demos) carry no `system` field, so they keep the original canned behavior untouched.
function promptStrength(p) {
  if (!p) return 0;
  const len = p.trim().length;
  const guided =
    /(accura|complete|help|step|detail|concise|resolve|clear|specific|context|polite|professional|empath|friendl|warm|tone|thorough|example)/i.test(
      p
    );
  const lenScore = len > 140 ? 0.6 : len > 50 ? 0.35 : len > 15 ? 0.15 : 0;
  return Math.min(1, lenScore + (guided ? 0.4 : 0));
}

function promptSensitiveOutput(input, system, style) {
  const sys = promptStrength(system); // accuracy + completeness
  const sty = promptStrength(style); // tone
  const full = answerFor(input);
  // A strong system prompt unlocks the full answer; a middling one gives only its first
  // sentence (partial completeness); a weak one gives an unhelpful brush-off.
  let core;
  if (sys >= 0.5) core = full;
  else if (sys >= 0.3) core = `${full.split(". ")[0]}.`;
  else core = "Sure.";
  // A strong style prompt adds warmth and a next step; a weak one stays blunt.
  if (sty >= 0.5) return `Happy to help! ${core} Let me know if there's anything else I can do.`;
  return core;
}

// Canned "historical" rows for the dataset path: each already has an output, as if pulled
// from a production trace store. The last row's completion is weak → expect a lower score.
const LOG_ROWS = [
  { prompt: "How do I reset my password?", completion: answerFor("reset password") },
  { prompt: "What's your refund policy?", completion: answerFor("refund") },
  { prompt: "What are your support hours?", completion: answerFor("support hours") },
  { prompt: "Can I export my data?", completion: answerFor("export data") },
  { prompt: "Do you integrate with Salesforce?", completion: answerFor("salesforce") },
].map((r, i) => ({ id: `log_${i + 1}`, ...r }));

function authorized(req) {
  return !TOKEN || req.headers["authorization"] === `Bearer ${TOKEN}`;
}

function unauthorized(res, route) {
  console.log(`→ 401  ${route} (missing/invalid Authorization)`);
  res.writeHead(401, { "Content-Type": "application/json" }).end(
    JSON.stringify({ error: "unauthorized" })
  );
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- dataset kind: GET /logs ---
  if (req.method === "GET" && url.pathname === "/logs") {
    if (!authorized(req)) return unauthorized(res, "GET /logs");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const data = LOGS_EMPTY ? [] : LOG_ROWS.slice(0, Math.max(0, limit));
    console.log(
      `→ 200  GET /logs  from=${url.searchParams.get("from") ?? "—"} limit=${limit}  rows=${data.length}`
    );
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data }));
    return;
  }

  // --- agent kind: POST /agent ---
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "POST /agent or GET /logs only" })
    );
    return;
  }

  if (!authorized(req)) return unauthorized(res, "POST /agent");

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let input = "";
    let system; // undefined unless the caller injects {{prompt:system}}
    let style;
    try {
      const json = JSON.parse(body || "{}");
      input = String(json.input ?? json.user_input ?? "");
      system = json.system;
      style = json.style;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "invalid JSON body" })
      );
      return;
    }
    // Prompt-sensitive only when Modules are injected; plain {input} requests are unchanged.
    const output =
      system === undefined
        ? answerFor(input)
        : promptSensitiveOutput(input, String(system), String(style ?? ""));
    console.log(`→ 200  POST /agent  in: ${JSON.stringify(input).slice(0, 50)}  out: ${output.slice(0, 40)}…`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ output })
    );
  });
});

server.listen(PORT, () => {
  console.log(`Mock System listening on http://localhost:${PORT}  (auth: ${TOKEN ? "required" : "off"})`);
  console.log(`  agent   →  POST http://localhost:${PORT}/agent   body {"input":"{{user_input}}"}  path: output`);
  console.log(`  dataset →  GET  http://localhost:${PORT}/logs    rows path: data  (${LOGS_EMPTY ? "EMPTY mode" : `${LOG_ROWS.length} rows`})`);
});
