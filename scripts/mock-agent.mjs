// Mock agent for end-to-end testing of Schedules.
// Zero deps — run: `node scripts/mock-agent.mjs`
//
// Matches the wizard's default Connection shape:
//   Request body template: {"input":"{{user_input}}"}
//   Response path:         output
//
// Optional auth: set MOCK_AGENT_TOKEN to require `Authorization: Bearer <token>`.
// Leave it unset to test the no-auth path (auth header + value blank in the wizard).

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_AGENT_PORT ?? 8787);
const TOKEN = process.env.MOCK_AGENT_TOKEN || null;

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

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "POST only" })
    );
    return;
  }

  if (TOKEN && req.headers["authorization"] !== `Bearer ${TOKEN}`) {
    console.log("→ 401  (missing/invalid Authorization)");
    res.writeHead(401, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "unauthorized" })
    );
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let input = "";
    try {
      const json = JSON.parse(body || "{}");
      input = String(json.input ?? json.user_input ?? "");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "invalid JSON body" })
      );
      return;
    }
    const output = answerFor(input);
    console.log(`→ 200  in: ${JSON.stringify(input).slice(0, 60)}  out: ${output.slice(0, 48)}…`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ output })
    );
  });
});

server.listen(PORT, () => {
  console.log(`Mock agent listening on http://localhost:${PORT}  (auth: ${TOKEN ? "required" : "off"})`);
  console.log(`  Endpoint URL:    http://localhost:${PORT}/agent`);
  console.log(`  Request template: {"input":"{{user_input}}"}`);
  console.log(`  Response path:    output`);
});
