// Optimization Run state emails (#107, #102). Mirrors the eval-run emailer (emailer.ts):
// the same worker-side Resend path, fired from the Activities that own a run's state
// transition (completeRun / failRun / pauseRun in gepa/activities.ts) — never the Next tier.
//
// Three kinds: the two terminal transitions (#107) plus "paused" (#102) — sent when a
// sustained endpoint outage pauses the run, so the starter knows it's waiting (and how to
// resume it immediately). The send path, recipient resolution, and best-effort wrapper are
// kind-agnostic.

import { Resend } from "resend";

// Construct the Resend client lazily: the v4 SDK throws on a missing key at construction, so a
// module-load `new Resend()` would crash any importer (e.g. the worker registering Activities)
// in environments without RESEND_API_KEY. Deferring to first send keeps import side-effect-free.
let resend: Resend | undefined;
function client(): Resend {
  return (resend ??= new Resend(process.env.RESEND_API_KEY));
}

const FROM = process.env.RESEND_FROM ?? "evals@baseline.app";

// Single-source the notification kinds (house convention: const list -> derived type).
export const OPTIMIZATION_EMAIL_KINDS = ["completed", "failed", "paused"] as const;
export type OptimizationEmailKind = (typeof OPTIMIZATION_EMAIL_KINDS)[number];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Render seed -> best as a 0–1 score pair (e.g. "0.62 → 0.81"), matching best_score's 3-dp
// precision. The same string drives the subject's "win" and the body's lift line.
function formatScore(score: number): string {
  return score.toFixed(2);
}

// Deep link to the run's detail on the Optimizations surface. The `?run=<id>` query is the
// addressable form the read surface (#103) already understands.
function runLink(appUrl: string, runId: string): string {
  return `${appUrl}/optimizations?run=${runId}`;
}

interface RenderedEmail {
  subject: string;
  html: string;
}

export interface OptimizationCompletionPayload {
  runId: string;
  connectionName: string;
  // Seed (Candidate 0) overall score and the run's best overall score — the score lift. Both
  // come from the workflow's full-set (Pareto) eval, so they share one metric and compare cleanly.
  seedScore: number;
  bestScore: number;
  rolloutsUsed: number;
  instanceCount: number;
  appUrl: string;
}

export interface OptimizationFailurePayload {
  runId: string;
  connectionName: string;
  errorMessage: string;
  appUrl: string;
}

export interface OptimizationPausedPayload {
  runId: string;
  connectionName: string;
  // Why the run paused — the same human-readable reason pauseRun writes to paused_reason.
  reason: string;
  appUrl: string;
}

function renderCompletion(p: OptimizationCompletionPayload): RenderedEmail {
  const seed = formatScore(p.seedScore);
  const best = formatScore(p.bestScore);
  const link = runLink(p.appUrl, p.runId);
  return {
    subject: `Optimization complete — ${p.connectionName} (${seed} → ${best})`,
    html: `
      <p>Your optimization run has completed.</p>
      <p><strong>Agent:</strong> ${escapeHtml(p.connectionName)}<br>
      <strong>Score lift:</strong> ${seed} → ${best}<br>
      <strong>Rollouts spent:</strong> ${p.rolloutsUsed}<br>
      <strong>Instances:</strong> ${p.instanceCount}</p>
      <p><a href="${escapeHtml(link)}">View run →</a></p>
    `,
  };
}

function renderFailure(p: OptimizationFailurePayload): RenderedEmail {
  const link = runLink(p.appUrl, p.runId);
  return {
    subject: `Optimization failed — ${p.connectionName}`,
    html: `
      <p>Your optimization run encountered an error.</p>
      <p><strong>Agent:</strong> ${escapeHtml(p.connectionName)}<br>
      <strong>Error:</strong> ${escapeHtml(p.errorMessage)}</p>
      <p><a href="${escapeHtml(link)}">View run →</a></p>
    `,
  };
}

// Paused (#102): the endpoint stopped responding mid-run. No progress was lost — the run is
// auto-retrying on a backoff schedule, and "Retry now" in the run detail (the deep link)
// resumes it immediately once the endpoint is back.
function renderPaused(p: OptimizationPausedPayload): RenderedEmail {
  const link = runLink(p.appUrl, p.runId);
  return {
    subject: `Optimization paused — ${p.connectionName}`,
    html: `
      <p>Your optimization run is paused — no progress has been lost.</p>
      <p><strong>Agent:</strong> ${escapeHtml(p.connectionName)}<br>
      <strong>Reason:</strong> ${escapeHtml(p.reason)}</p>
      <p>The run is checking your endpoint automatically (with backoff) and will resume on
      its own once it responds. If you know it's already fixed, use <strong>Retry now</strong>
      on the run to resume immediately.</p>
      <p><a href="${escapeHtml(link)}">View run →</a></p>
    `,
  };
}

// Kind-agnostic send. `to` is the starter's resolved email (v1 has no recipients field — the
// recipient is always the run's created_by). A null/empty recipient is a no-op, so an
// unresolvable starter never blocks the terminal transition.
async function send(to: string | null, email: RenderedEmail): Promise<void> {
  if (!to) return;
  const { error } = await client().emails.send({
    from: FROM,
    to: [to],
    subject: email.subject,
    html: email.html,
  });
  if (error) throw error;
}

export async function sendOptimizationCompletionEmail(
  to: string | null,
  payload: OptimizationCompletionPayload
): Promise<void> {
  await send(to, renderCompletion(payload));
}

export async function sendOptimizationFailureEmail(
  to: string | null,
  payload: OptimizationFailurePayload
): Promise<void> {
  await send(to, renderFailure(payload));
}

export async function sendOptimizationPausedEmail(
  to: string | null,
  payload: OptimizationPausedPayload
): Promise<void> {
  await send(to, renderPaused(payload));
}
