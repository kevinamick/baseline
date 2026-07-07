// Optimization Run state emails (#107, #102). Mirrors the eval-run emailer (emailer.ts) and
// shares its transport (`deliver`), fired from the Activities that own a run's state
// transition (completeRun / failRun / pauseRun in gepa/activities.ts) — never the Next tier.
//
// Three kinds: the two terminal transitions (#107) plus "paused" (#102) — sent when a
// sustained endpoint outage pauses the run, so the starter knows it's waiting (and how to
// resume it immediately). The send path, recipient resolution, and best-effort wrapper are
// kind-agnostic.

// Transport lives in the shared emailer path (emailer.ts): `deliver` picks Resend in production and
// local Mailpit over SMTP in dev (MAILPIT_SMTP_HOST), so optimization mail is inspectable locally
// for free alongside the eval-run mail.
import { deliver } from "./emailer.js";
// Baseline Design System email chrome (wrapEmail / ctaButton / EMAIL). Worker-local copy of
// the canonical app-tier layout at src/lib/email/templates/layout.ts — see email-layout.ts.
import { EMAIL, ctaButton, wrapEmail } from "./email-layout.js";
import { escapeHtml } from "./escape.js";

// Single-source the notification kinds (house convention: const list -> derived type).
export const OPTIMIZATION_EMAIL_KINDS = ["completed", "failed", "paused"] as const;
export type OptimizationEmailKind = (typeof OPTIMIZATION_EMAIL_KINDS)[number];

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
    html: wrapEmail({
      previewText: `${escapeHtml(p.connectionName)}: ${seed} → ${best}`,
      body: `
      <h2 style="${EMAIL.h2}">Optimization complete</h2>
      <p style="${EMAIL.p}">Your optimization run has completed.</p>
      <p style="${EMAIL.p}"><strong style="${EMAIL.strong}">Agent:</strong> ${escapeHtml(p.connectionName)}<br>
      <strong style="${EMAIL.strong}">Score lift:</strong> ${seed} → ${best}<br>
      <strong style="${EMAIL.strong}">Rollouts spent:</strong> ${p.rolloutsUsed}<br>
      <strong style="${EMAIL.strong}">Instances:</strong> ${p.instanceCount}</p>
      ${ctaButton(escapeHtml(link), "View run →")}
    `,
    }),
  };
}

function renderFailure(p: OptimizationFailurePayload): RenderedEmail {
  const link = runLink(p.appUrl, p.runId);
  return {
    subject: `Optimization failed — ${p.connectionName}`,
    html: wrapEmail({
      previewText: `${escapeHtml(p.connectionName)}: your optimization run hit an error.`,
      body: `
      <h2 style="${EMAIL.h2}">Optimization failed</h2>
      <p style="${EMAIL.p}">Your optimization run encountered an error.</p>
      <p style="${EMAIL.p}"><strong style="${EMAIL.strong}">Agent:</strong> ${escapeHtml(p.connectionName)}<br>
      <strong style="${EMAIL.strong}">Error:</strong> ${escapeHtml(p.errorMessage)}</p>
      ${ctaButton(escapeHtml(link), "View run →")}
    `,
    }),
  };
}

// Paused (#102): the endpoint stopped responding mid-run. No progress was lost — the run is
// auto-retrying on a backoff schedule, and "Retry now" in the run detail (the deep link)
// resumes it immediately once the endpoint is back.
function renderPaused(p: OptimizationPausedPayload): RenderedEmail {
  const link = runLink(p.appUrl, p.runId);
  return {
    subject: `Optimization paused — ${p.connectionName}`,
    html: wrapEmail({
      previewText: `${escapeHtml(p.connectionName)}: paused, no progress has been lost.`,
      body: `
      <h2 style="${EMAIL.h2}">Optimization paused</h2>
      <p style="${EMAIL.p}">Your optimization run is paused — no progress has been lost.</p>
      <p style="${EMAIL.p}"><strong style="${EMAIL.strong}">Agent:</strong> ${escapeHtml(p.connectionName)}<br>
      <strong style="${EMAIL.strong}">Reason:</strong> ${escapeHtml(p.reason)}</p>
      <p style="${EMAIL.p}">The run is checking your endpoint automatically (with backoff) and will resume on
      its own once it responds. If you know it's already fixed, use <strong style="${EMAIL.strong}">Retry now</strong>
      on the run to resume immediately.</p>
      ${ctaButton(escapeHtml(link), "View run →")}
    `,
    }),
  };
}

// Kind-agnostic send. `to` is the starter's resolved email (v1 has no recipients field — the
// recipient is always the run's created_by). A null/empty recipient is a no-op (deliver treats an
// empty list as such), so an unresolvable starter never blocks the terminal transition.
async function send(to: string | null, email: RenderedEmail): Promise<void> {
  await deliver(to ? [to] : [], email.subject, email.html);
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
