"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useRouter, useSearchParams } from "next/navigation";
import { ClientDate } from "@/app/_components/client-date";
import { StatusBadge } from "@/app/_components/eval-run-helpers";
import { getOptimizationRun, cancelOptimizationRun } from "@/app/actions/optimizations";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { hasLift } from "@/lib/optimization/score";
import {
  isActiveOptimizationStatus,
  type OptimizableConnection,
  type OptimizationRunStatus,
  type OptimizationRunSummary,
} from "@/types/optimization";
import type { RubricSummary } from "@/types/rubric";
import type { EvalRunStatus } from "@/types/eval-run";
import { OptimizationWizard } from "./optimization-wizard";
import { RetentionWindowNote } from "@/app/_components/retention-window-note";

interface Props {
  runs: OptimizationRunSummary[];
  rubrics: RubricSummary[];
  connections: OptimizableConnection[];
  canWrite: boolean;
  /** Per-period Optimization Run allowance (#181, ADR-0008). overageHeadroom:
   *  included runs are gone but the Team's Overage Cap (#183) still funds at
   *  least one more — the gate must not close. */
  allowance: {
    included: number;
    remaining: number;
    maxBudgetRollouts: number;
    overageHeadroom: boolean;
  };
  /** The plan's Retention Window in days (#187) — labels the list boundary.
   *  Defaults to the Free floor (14) for surfaces/tests that don't supply it. */
  retentionDays?: number;
}

type RunDetail = Awaited<ReturnType<typeof getOptimizationRun>>;

// An active (queued/running) run keeps acquiring rollouts/candidates, so its detail is
// re-fetched on a light interval until it leaves an active state (then polling stops).
const POLL_MS = 4000;

// Scores are stored as numeric(4,3); show two decimals ("0.81") to match the lift notation.
function fmtScore(n: number): string {
  return n.toFixed(2);
}

export function OptimizationsLayout({ runs, rubrics, connections, canWrite, allowance, retentionDays = 14 }: Props) {
  const t = useTranslations("Optimizations");
  const router = useRouter();
  const searchParams = useSearchParams();

  const [showWizard, setShowWizard] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Bumped after a cancel to force an immediate detail refetch (don't wait for the next poll).
  const [reloadNonce, setReloadNonce] = useState(0);
  // A run needs a rubric (a hard prerequisite — not creatable inline). With none, the entry
  // point points at /rubrics instead of opening a dead-end wizard.
  const hasRubrics = rubrics.length > 0;
  // One active run per org (a partial unique index enforces it). Gate "New run" so a second
  // start isn't even attempted — the server's 23505 stays the backstop for a race.
  const hasActiveRun = runs.some((r) => isActiveOptimizationStatus(r.status));

  // The URL is the source of truth for which run is open (?run=<id>), so a deep link
  // from an email opens the right run. Fall back to the newest run when unspecified.
  const runParam = searchParams.get("run");
  const selectedId = runParam ?? runs[0]?.id ?? null;

  const [detail, setDetail] = useState<RunDetail>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    // selectedId is only null when there are no runs at all; the JSX guards that case,
    // so there's nothing to fetch and no stale detail to clear.
    if (!selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // showLoading only on the first fetch — the background polls refresh detail in place
    // without flashing the loading state. A setTimeout chain (vs setInterval) reschedules the
    // next poll only after the current one resolves, so fetches never overlap, and it polls
    // only while the run is still active — a terminal/missing run (or a switched selection)
    // ends the loop with no dangling timer.
    const load = async (showLoading: boolean) => {
      if (showLoading) setLoadingDetail(true);
      try {
        const d = await getOptimizationRun(selectedId);
        if (cancelled) return;
        setDetail(d);
        const status = (d?.run as { status?: OptimizationRunStatus } | undefined)?.status;
        if (status && isActiveOptimizationStatus(status)) {
          timer = setTimeout(() => void load(false), POLL_MS);
        }
      } finally {
        if (!cancelled && showLoading) setLoadingDetail(false);
      }
    };

    void load(true);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedId, reloadNonce]);

  // The run list is server-rendered, so its status pills and the one-active-run gate don't
  // update on their own. While a run is active, softly refresh the page on an interval — the
  // refresh re-runs listOptimizationRuns, so a finish (status pill → completed/failed) and the
  // gate clearing land live; the interval stops once nothing's active. (The detail panel has
  // its own live poll above.)
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasActiveRun, router]);

  async function handleCancel() {
    if (!selectedId) return;
    setCancelling(true);
    setCancelError(null);
    const result = await cancelOptimizationRun(selectedId);
    setCancelling(false);
    if ("error" in result) {
      setCancelError(result.error);
      return;
    }
    setShowCancel(false);
    setReloadNonce((n) => n + 1); // flip the detail to the cancelled (failed) view now
    router.refresh(); // update the list row + free the active-run gate
  }

  function selectRun(id: string) {
    // Reflect the selection in the URL without a full navigation (deep-linkable).
    router.replace(`/optimizations?run=${id}`, { scroll: false });
  }

  // Only show detail that belongs to the currently-selected run. While switching runs the
  // previous run's detail is still in state until the new fetch resolves; gating on the id
  // shows a loading state instead of briefly rendering the wrong run's config.
  const loaded = detail?.run as Record<string, unknown> | undefined;
  const run = loaded && loaded.id === selectedId ? loaded : undefined;
  const status = run?.status as OptimizationRunStatus | undefined;
  const isCompleted = status === "completed";
  const isFailed = status === "failed";
  // queued + running share the in-progress treatment (derived progress, no result yet) — keyed
  // off the single-sourced active-status set so a new active status (e.g. paused) flows through.
  const isInProgress = status != null && isActiveOptimizationStatus(status);
  const seedScore = run ? detail?.seedScore ?? null : null;
  const bestScore = run?.best_score == null ? null : Number(run.best_score);
  const seedPrompts = run ? detail?.seedPrompts ?? null : null;
  const winningPrompts = run ? detail?.winningPrompts ?? null : null;

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      {/* List */}
      <div className="flex w-[360px] shrink-0 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t("panelTitle")}</h2>
          {canWrite &&
            (allowance.included === 0 ? (
              // Free plan: a gated state, not an error — runs aren't included (#181).
              <Link
                href="/pricing"
                data-testid="optimization-gate"
                title={t("upgradeTooltip")}
                className="inline-flex items-center gap-1 rounded-full border border-hairline-cool bg-card px-3 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:text-ink"
              >
                {t("upgradeToOptimize")}
              </Link>
            ) : !hasRubrics ? (
              <Link
                href="/rubrics"
                title={t("needRubricTooltip")}
                className="inline-flex items-center gap-1 rounded-full border border-hairline-cool bg-card px-3 py-1.5 text-xs font-medium text-fg-4 transition-colors hover:text-ink"
              >
                {t("newRun")}
              </Link>
            ) : allowance.remaining < 1 && !allowance.overageHeadroom ? (
              <span
                data-testid="optimization-exhausted"
                title={t("exhaustedTooltip", { included: allowance.included })}
                aria-disabled="true"
                className="inline-flex cursor-not-allowed items-center gap-1 rounded-full border border-hairline-cool bg-card px-3 py-1.5 text-xs font-medium text-fg-4"
              >
                {t("newRun")}
              </span>
            ) : hasActiveRun ? (
              <span
                title={t("activeTooltip")}
                aria-disabled="true"
                className="inline-flex cursor-not-allowed items-center gap-1 rounded-full border border-hairline-cool bg-card px-3 py-1.5 text-xs font-medium text-fg-4"
              >
                {t("newRun")}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setShowWizard(true)}
                className="inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
              >
                {t("newRun")}
              </button>
            ))}
        </div>
        {canWrite && hasRubrics && hasActiveRun && (
          <p className="border-b border-hairline px-4 py-2 text-[11px] text-fg-3">
            {t("activeNote")}
          </p>
        )}
        {canWrite && allowance.included > 0 && allowance.remaining < 1 &&
          (allowance.overageHeadroom ? (
            <p className="border-b border-hairline px-4 py-2 text-[11px] text-fg-3">
              {t("overageNote", { included: allowance.included })}
            </p>
          ) : (
            <p className="border-b border-hairline px-4 py-2 text-[11px] text-danger-fg">
              {t("exhaustedNote", { included: allowance.included })}
            </p>
          ))}
        <div className="flex-1 overflow-y-auto p-2">
          {runs.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-fg-3">
              {t("empty")}
            </p>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRun(r.id)}
                className={`mb-1 flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  selectedId === r.id ? "bg-accent-soft" : "hover:bg-card-warm"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{r.connection_name}</span>
                  <StatusBadge status={r.status as EvalRunStatus} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-fg-4">
                    <ClientDate value={r.created_at} relative />
                  </span>
                  <RowLift seed={r.seed_score} best={r.best_score} status={r.status} />
                </div>
              </button>
            ))
          )}
          {runs.length > 0 && <RetentionWindowNote days={retentionDays} />}
        </div>
      </div>

      {/* Detail */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card">
        {!selectedId || !run ? (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-4">
            {loadingDetail ? "Loading…" : runs.length === 0 ? "No runs to show" : "Select a run"}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold tracking-[-0.015em] text-ink">
                  {detailNested(run, "connections", "name")}
                </h2>
                <p className="mt-0.5 text-sm text-fg-3">
                  Started <ClientDate value={run.created_at as string} />
                </p>
              </div>
              <StatusBadge
                status={run.status as EvalRunStatus}
                title={(run.error_message as string | null) ?? undefined}
              />
            </div>

            {isCompleted && (
              <LiftHeadline seed={seedScore} best={bestScore} />
            )}

            {isInProgress && (
              <RunningProgress
                rolloutsSpent={detail?.rolloutsSpent ?? 0}
                budget={run.budget_rollouts as number | null}
                candidateCount={detail?.candidateCount ?? 0}
              />
            )}

            {isInProgress && canWrite && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setCancelError(null);
                    setShowCancel(true);
                  }}
                  className="rounded-full border border-danger px-4 py-2 text-sm font-medium text-danger-fg transition-colors hover:bg-danger-bg"
                >
                  Cancel run
                </button>
              </div>
            )}

            {isFailed && <FailedCallout message={(run.error_message as string | null) ?? null} />}

            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Detail label="Rubric" value={detailNested(run, "rubrics", "name")} />
              <Detail label="Agent" value={detailNested(run, "connections", "name")} />
              <Detail label="Instances" value={String(detail?.instanceCount ?? 0)} />
              <Detail label="Rollout budget" value={String(run.budget_rollouts ?? "—")} />
              <Detail label="Max iterations" value={String(run.max_iters ?? "—")} />
              <Detail
                label="Plateau patience"
                value={run.plateau_patience == null ? "Off" : String(run.plateau_patience)}
              />
              <Detail label="Reflection model" value={String(run.reflect_model ?? "—")} />
              <Detail
                label="Best score"
                value={bestScore == null ? "—" : `${(bestScore * 100).toFixed(0)}%`}
              />
            </dl>

            {isCompleted && (
              <PromptDiff seedPrompts={seedPrompts} winningPrompts={winningPrompts} />
            )}

            {isFailed && (
              <p className="mt-6 text-sm text-fg-3">No optimized prompt was produced.</p>
            )}
          </div>
        )}
      </div>

      {showWizard && (
        <OptimizationWizard
          rubrics={rubrics}
          connections={connections}
          maxBudgetRollouts={allowance.maxBudgetRollouts}
          onClose={() => setShowWizard(false)}
          onCreated={() => router.refresh()}
        />
      )}

      {showCancel && (
        <ConfirmDialog
          title="Cancel this optimization run?"
          message={
            <>
              Cancelling stops the run now and frees your team&apos;s active slot. The run is
              marked failed and can&apos;t be resumed.
              {cancelError && <span className="mt-2 block text-danger-fg">{cancelError}</span>}
            </>
          }
          confirmLabel="Cancel run"
          cancelLabel="Keep running"
          busy={cancelling}
          busyLabel="Cancelling…"
          onConfirm={handleCancel}
          onCancel={() => setShowCancel(false)}
        />
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="break-words text-ink">{value}</dd>
    </div>
  );
}

// Compact lift on a list row: "0.62 → 0.81" when a completed run improved on its seed; just
// the final score when it didn't (no misleading arrow); nothing for non-completed runs.
function RowLift({
  seed,
  best,
  status,
}: {
  seed: number | null;
  best: number | null;
  status: OptimizationRunSummary["status"];
}) {
  if (status !== "completed" || best == null) return null;
  if (hasLift(seed, best)) {
    return (
      <span className="text-[11px] font-medium text-success-fg">
        {fmtScore(seed as number)} → {fmtScore(best)}
      </span>
    );
  }
  return <span className="text-[11px] text-fg-4">{fmtScore(best)}</span>;
}

// The payoff headline on a completed run. Three cases:
//  - real lift (seed known, best > seed): "Score lift", seed → best
//  - known no-improvement (seed known, best <= seed): final score + honest note
//  - unknown baseline (no seed score): just the final score — never claim "no improvement"
//    when we simply couldn't recompute the seed's score.
function LiftHeadline({ seed, best }: { seed: number | null; best: number | null }) {
  if (hasLift(seed, best)) {
    return (
      <div className="mt-4 rounded-xl border border-hairline bg-card-warm px-4 py-3">
        <p className="text-xs text-fg-3">Score lift</p>
        <p className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-ink">
          <span className="text-fg-4">{fmtScore(seed as number)}</span>
          <span className="mx-2 text-fg-4">→</span>
          <span className="text-success-fg">{fmtScore(best as number)}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-xl border border-hairline bg-card-warm px-4 py-3">
      <p className="text-xs text-fg-3">Best score</p>
      <p className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-ink">
        {best == null ? "—" : fmtScore(best)}
      </p>
      {seed != null && (
        <p className="mt-0.5 text-xs text-fg-3">No improvement over the seed prompt.</p>
      )}
    </div>
  );
}

// In-progress headline for a queued/running run. No live best-so-far score (the completed
// view owns that) — just an honest, coarse sense of motion derived from child-row counts:
// rollouts spent against the budget ceiling, and how many Candidates have appeared so far.
function RunningProgress({
  rolloutsSpent,
  budget,
  candidateCount,
}: {
  rolloutsSpent: number;
  budget: number | null;
  candidateCount: number;
}) {
  // Budget is the hard rollout ceiling; clamp the bar so a final over-count can't overflow it.
  const pct =
    budget && budget > 0 ? Math.min(100, Math.round((rolloutsSpent / budget) * 100)) : null;
  return (
    <div className="mt-4 rounded-xl border border-hairline bg-card-warm px-4 py-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs text-fg-3">Rollouts spent</p>
        <p className="text-sm font-medium text-ink">
          {rolloutsSpent}
          {budget != null && <span className="text-fg-4"> / {budget}</span>}
        </p>
      </div>
      {pct != null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="mt-2 text-xs text-fg-3">
        {candidateCount} {candidateCount === 1 ? "candidate" : "candidates"} discovered
      </p>
    </div>
  );
}

// Failed-run callout: the workflow records the deepest root-cause on the run's error_message
// (circuit-breaker tripped, endpoint unreachable, timed-out-and-reaped). Show it verbatim.
function FailedCallout({ message }: { message: string | null }) {
  return (
    <div className="mt-4 rounded-xl border border-danger bg-danger-bg px-4 py-3">
      <p className="text-xs font-medium text-danger-fg">Run failed</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-danger-fg">
        {message && message.trim().length > 0 ? message : "No failure reason was recorded."}
      </p>
    </div>
  );
}

// Per-Module seed → optimized prompt comparison, the centerpiece of a completed run. Each
// Module's optimized text is independently copyable (read action — available to everyone), with
// a "Copy all" for the whole set.
function PromptDiff({
  seedPrompts,
  winningPrompts,
}: {
  seedPrompts: Record<string, string> | null;
  winningPrompts: Record<string, string> | null;
}) {
  const seed = seedPrompts ?? {};
  // Fall back to the seed when there's no validated winner so the panel still shows the prompt.
  const winning = winningPrompts ?? seed;
  const modules = Object.keys(seed).length > 0 ? Object.keys(seed) : Object.keys(winning);

  if (modules.length === 0) {
    return (
      <p className="mt-6 text-sm text-fg-3">No optimizable prompt was recorded for this run.</p>
    );
  }

  const copyAllText = modules
    .map((m) => (modules.length > 1 ? `## ${m}\n${winning[m] ?? ""}` : winning[m] ?? ""))
    .join("\n\n");

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Optimized prompts</h3>
        {modules.length > 1 && <CopyButton text={copyAllText} label="Copy all" />}
      </div>
      <div className="mt-3 flex flex-col gap-4">
        {modules.map((m) => (
          <div key={m} className="rounded-xl border border-hairline">
            <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
              <span className="text-xs font-medium text-ink">{m}</span>
              <CopyButton text={winning[m] ?? ""} />
            </div>
            <div className="grid gap-3 p-3 md:grid-cols-2">
              <PromptColumn label="Seed" text={seed[m] ?? ""} muted />
              <PromptColumn label="Optimized" text={winning[m] ?? ""} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PromptColumn({ label, text, muted }: { label: string; text: string; muted?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-fg-4">{label}</span>
      <pre
        className={`max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline px-3 py-2 text-xs ${
          muted ? "bg-card-warm text-fg-3" : "bg-card text-ink"
        }`}
      >
        {text || "—"}
      </pre>
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          // Clipboard can be unavailable (insecure context / denied permission); fail quietly.
        }
      }}
      className="rounded-md border border-hairline px-2 py-1 text-[11px] font-medium text-fg-2 transition-colors hover:bg-card-warm"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function detailNested(obj: Record<string, unknown>, rel: string, key: string): string {
  const nested = obj[rel];
  if (Array.isArray(nested)) return String((nested[0] as Record<string, unknown>)?.[key] ?? "—");
  if (nested && typeof nested === "object") return String((nested as Record<string, unknown>)[key] ?? "—");
  return "—";
}
