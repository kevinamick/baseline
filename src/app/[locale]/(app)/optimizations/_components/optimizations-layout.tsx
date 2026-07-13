"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useRouter, useSearchParams } from "next/navigation";
import { ClientDate } from "@/app/_components/client-date";
import { StatusBadge } from "@/app/_components/eval-run-helpers";
import { ChevronRightIcon } from "@/app/_components/icons";
import {
  getOptimizationRun,
  cancelOptimizationRun,
  retryOptimizationRun,
  loadWizardLiveModels,
} from "@/app/actions/optimizations";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { hasLift } from "@/lib/optimization/score";
import { isTerminationReason } from "@/lib/optimization/termination-reason";
import {
  isActiveOptimizationStatus,
  type OptimizableConnection,
  type DatasetConnectionOption,
  type EvalRunInstanceOption,
  type OptimizationRunStatus,
  type OptimizationRunSummary,
} from "@/types/optimization";
import type { RubricSummary } from "@/types/rubric";
import { OptimizationWizard } from "./optimization-wizard";
import type { UsableProvider } from "@/lib/llm/usable-providers";
import type { LlmProvider } from "@/lib/llm/providers";
import { RetentionWindowNote } from "@/app/_components/retention-window-note";

interface Props {
  runs: OptimizationRunSummary[];
  rubrics: RubricSummary[];
  connections: OptimizableConnection[];
  /** The Team's dataset Connections, eligible for the start wizard's Instances-step snapshot
   *  source (#82). Optional; defaults to none. */
  datasetConnections?: DatasetConnectionOption[];
  /** The Team's Eval Runs, eligible for the start wizard's Instances-step "From an Eval Run"
   *  source (#83). Optional; defaults to none. */
  evalRunOptions?: EvalRunInstanceOption[];
  /** Providers/models the start wizard may offer, with the key each run will use (#204).
   *  Optional for tests/surfaces that don't open the wizard; defaults to Anthropic on the
   *  Team's own key. */
  usableProviders?: UsableProvider[];
  /** Live-listed BYO models (#485) are loaded on demand when the wizard opens (the
   *  loadWizardLiveModels server action), NOT from a page prop — so a slow/unreachable BYO
   *  provider never blocks the page's DB-sourced content (#488). Until the fetch returns, the
   *  wizard shows curated models only — exactly the pre-#485 wizard. Tests can inject a resolver
   *  to skip the network. */
  loadLiveModels?: () => Promise<Partial<Record<LlmProvider, string[]>>>;
  /** Whether the Team is on a paid plan (#204): gates the wizard's paid-only Managed Agent path.
   *  Defaults false (the Free floor) for surfaces/tests that don't supply it. */
  isPaid?: boolean;
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
// A paused run (#102) can sit for up to pause_max_wait_minutes (24h default) with nothing
// changing server-side between probes — poll it on a much gentler cadence so an open tab
// isn't burning ~21k refetches per day. After "Retry now" the resume lands within seconds,
// so the fast cadence resumes until the status flips.
const PAUSED_POLL_MS = 30_000;

function fmtScore(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function OptimizationsLayout({
  runs,
  rubrics,
  connections,
  datasetConnections = [],
  evalRunOptions = [],
  usableProviders = [{ provider: "anthropic", keySource: "byo" }],
  loadLiveModels = loadWizardLiveModels,
  isPaid = false,
  canWrite,
  allowance,
  retentionDays = 14,
}: Props) {
  const t = useTranslations("Optimizations");
  const router = useRouter();
  const searchParams = useSearchParams();

  // Live-listed BYO models (#485) are fetched on demand the first time the wizard opens, NOT during
  // the page render (#488) — a slow/unreachable BYO provider must never block the page's TTFB. The
  // wizard renders immediately with curated models; the live ids fold into its optgroups when the
  // action returns (sub-3s, then cached per org so re-opens are instant). Fetched once per mounted
  // layout; loadLiveModels never rejects (live-models.ts collapses every failure to an empty map),
  // but guard anyway so a rejection can't surface as an unhandled promise.
  const [liveModelsByProvider, setLiveModelsByProvider] = useState<
    Partial<Record<LlmProvider, string[]>>
  >({});
  const liveModelsRequested = useRef(false);

  const [showWizard, setShowWizard] = useState(false);
  // Load the live BYO model lists the first time the wizard opens (#488) — see liveModelsByProvider
  // above. Not on mount, so a user who never opens the wizard never triggers the provider fetch.
  useEffect(() => {
    if (!showWizard || liveModelsRequested.current) return;
    liveModelsRequested.current = true;
    let active = true;
    loadLiveModels()
      .then((m) => {
        if (active) setLiveModelsByProvider(m);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [showWizard, loadLiveModels]);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // "Retry now" on a paused run (#102): signals the live workflow to resume immediately.
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // A successfully-sent retry signal: the resume is async on the workflow side, so until the
  // poll sees the status leave 'paused' the button holds a disabled "Resuming…" state —
  // re-enabling it as "Retry now" would read as a no-op and invite duplicate signals.
  const [retried, setRetried] = useState(false);
  // Bumped after a cancel to force an immediate detail refetch (don't wait for the next poll).
  const [reloadNonce, setReloadNonce] = useState(0);
  // A run needs a rubric (a hard prerequisite — not creatable inline). With none, the entry
  // point points at /rubrics instead of opening a dead-end wizard.
  const hasRubrics = rubrics.length > 0;
  // One active run per org (a partial unique index enforces it). Gate "New run" so a second
  // start isn't even attempted — the server's 23505 stays the backstop for a race.
  const hasActiveRun = runs.some((r) => isActiveOptimizationStatus(r.status));
  // When the only active run is paused, the list refresh below drops to the slow cadence too.
  const onlyPausedActive =
    hasActiveRun &&
    runs.every((r) => !isActiveOptimizationStatus(r.status) || r.status === "paused");

  // The URL is the source of truth for which run is open (?run=<id>), so a deep link
  // from an email opens the right run. Fall back to the newest run when unspecified.
  const runParam = searchParams.get("run");
  const selectedId = runParam ?? runs[0]?.id ?? null;

  const [detail, setDetail] = useState<RunDetail>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

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
      if (showLoading) {
        setDetailError(null);
        setLoadingDetail(true);
      }
      try {
        const d = await getOptimizationRun(selectedId);
        if (cancelled) return;
        setDetail(d);
        const status = (d?.run as { status?: OptimizationRunStatus } | undefined)?.status;
        if (status && isActiveOptimizationStatus(status)) {
          // Paused runs poll gently (nothing changes between probes) — except right after a
          // "Retry now", when the resume is expected within seconds.
          const pollMs = status === "paused" && !retried ? PAUSED_POLL_MS : POLL_MS;
          timer = setTimeout(() => void load(false), pollMs);
        }
      } catch {
        if (cancelled) return;
        if (showLoading) {
          // Initial load failure: surface the error to the user.
          setDetail(null);
          setDetailError(t("detailLoadError"));
        } else {
          // Poll failure: silently retry on the next interval rather than breaking the live view.
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
    // `retried` is a dep so a successful retry switches the schedule back to the fast cadence
    // (its flip also bumps reloadNonce, so in practice this restarts together with the refetch).
  }, [selectedId, reloadNonce, retried, t]);

  // The run list is server-rendered, so its status pills and the one-active-run gate don't
  // update on their own. While a run is active, softly refresh the page on an interval — the
  // refresh re-runs listOptimizationRuns, so a finish (status pill → completed/failed) and the
  // gate clearing land live; the interval stops once nothing's active. (The detail panel has
  // its own live poll above.)
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(
      () => router.refresh(),
      onlyPausedActive ? PAUSED_POLL_MS : POLL_MS
    );
    return () => clearInterval(timer);
  }, [hasActiveRun, onlyPausedActive, router]);

  async function handleCancel() {
    if (!selectedId) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await cancelOptimizationRun(selectedId);
      if ("error" in result) {
        setCancelError(result.error);
        return;
      }
      setShowCancel(false);
      setReloadNonce((n) => n + 1); // flip the detail to the cancelled (failed) view now
      router.refresh(); // update the list row + free the active-run gate
    } finally {
      setCancelling(false);
    }
  }

  // Resume a paused run immediately (#102). The signal is async on the workflow side — the
  // run flips back to 'running' when its resume Activity lands — so don't flip the status
  // here; the detail poll picks it up. `retried` holds the button in "Resuming…" meanwhile.
  async function handleRetryNow() {
    if (!selectedId) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const result = await retryOptimizationRun(selectedId);
      if ("error" in result) {
        setRetryError(result.error);
        return;
      }
      setRetried(true);
      setReloadNonce((n) => n + 1); // refetch now rather than waiting out the current poll
      router.refresh();
    } finally {
      setRetrying(false);
    }
  }

  function selectRun(id: string) {
    setRetryError(null); // a retry error belongs to the run it was attempted on
    setRetried(false); // ...and so does an in-flight "Resuming…" hold
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
  const isPaused = status === "paused";
  // queued + running share the in-progress treatment (derived progress, no result yet) — keyed
  // off the single-sourced active-status set so a new active status (e.g. paused) flows through.
  const isInProgress = status != null && isActiveOptimizationStatus(status);
  const seedScore = run ? detail?.seedScore ?? null : null;
  const bestScore = run?.best_score == null ? null : Number(run.best_score);
  // Why a completed run never entered iteration 1 (#469) — null for a normal completion, so the
  // callout below simply doesn't render (existing runs with a real optimization pass show
  // nothing new, per the issue's acceptance criteria).
  const terminationReason = run ? detail?.terminationReason ?? null : null;
  const seedPrompts = run ? detail?.seedPrompts ?? null : null;
  const winningPrompts = run ? detail?.winningPrompts ?? null : null;

  // The "Resuming…" hold ends once the run leaves 'paused' (the callout unmounts with it).
  // Resetting then also re-arms the button for a LATER pause of the same run — without it, a
  // run that pauses again would mount the callout stuck on "Resuming…". Render-phase state
  // adjustment (not an effect): converges immediately on the re-render.
  if (retried && !isPaused) setRetried(false);

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      {/* List — full-width first pane on mobile (drill-in via ?run=), fixed column at md+ */}
      <div
        className={`${runParam ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card md:w-[360px]`}
      >
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
                <span aria-hidden="true"> →</span>
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
                  <StatusBadge status={r.status} />
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

      {/* Detail — shown once a run is opened on mobile; always present at md+ */}
      <div
        className={`${runParam ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card`}
      >
        {detailError ? (
          <div className="flex flex-1 items-center justify-center text-sm text-danger-fg">
            {detailError}
          </div>
        ) : !selectedId || !run ? (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-4">
            {loadingDetail ? t("loading") : runs.length === 0 ? t("noRunsToShow") : t("selectRun")}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-1.5">
                <button
                  type="button"
                  onClick={() => router.replace("/optimizations", { scroll: false })}
                  aria-label={t("back")}
                  className="-ml-1.5 mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-2 transition-colors hover:bg-card-warm hover:text-ink md:hidden"
                >
                  <ChevronRightIcon size={18} className="rotate-180" />
                </button>
                <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold tracking-[-0.015em] text-ink">
                  {detailNested(run, "connections", "name")}
                </h2>
                <p className="mt-0.5 text-sm text-fg-3">
                  Started <ClientDate value={run.created_at as string} />
                </p>
                </div>
              </div>
              <StatusBadge
                status={run.status as OptimizationRunStatus}
                title={
                  (run.error_message as string | null) ??
                  // A paused run's "why" (#102): waiting for the endpoint to recover.
                  (run.paused_reason as string | null) ??
                  undefined
                }
              />
            </div>

            {isCompleted && (
              <LiftHeadline seed={seedScore} best={bestScore} />
            )}

            {isCompleted && terminationReason && (
              <TerminationReasonCallout reason={terminationReason} />
            )}

            {isPaused && (
              <PausedCallout
                reason={detail?.pausedReason ?? null}
                canWrite={canWrite}
                retrying={retrying}
                resuming={retried}
                error={retryError}
                onRetryNow={() => void handleRetryNow()}
              />
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
          datasetConnections={datasetConnections}
          evalRunOptions={evalRunOptions}
          usableProviders={usableProviders}
          liveModelsByProvider={liveModelsByProvider}
          isPaid={isPaid}
          maxBudgetRollouts={allowance.maxBudgetRollouts}
          remainingRuns={allowance.remaining}
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

// Compact lift on a list row: "62% → 81%" when a completed run improved on its seed; just
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
//  - real lift (seed known, best > seed): dominant best-score display with delta badge
//  - known no-improvement (seed known, best <= seed): final score + honest note
//  - unknown baseline (no seed score): just the final score — never claim "no improvement"
//    when we simply couldn't recompute the seed's score.
function LiftHeadline({ seed, best }: { seed: number | null; best: number | null }) {
  if (hasLift(seed, best)) {
    const delta = Math.round((best as number) * 100) - Math.round((seed as number) * 100);
    return (
      <div className="mt-4 rounded-xl border border-hairline bg-card-warm px-4 py-4">
        <p className="text-xs text-fg-3">Score lift</p>
        <div className="mt-2 flex items-baseline gap-3">
          <p className="text-4xl font-bold leading-none tracking-[-0.03em] text-success-fg">
            {fmtScore(best as number)}
          </p>
          <span className="rounded-full bg-success-bg px-2.5 py-0.5 text-sm font-semibold text-success-fg">
            +{delta}pp
          </span>
        </div>
        <p className="mt-2 text-xs text-fg-4">
          {fmtScore(seed as number)}
          <span className="mx-1.5">→</span>
          {fmtScore(best as number)}
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

// A completed run that never entered iteration 1 (#469) looks identical to a genuine
// optimization pass otherwise — same "completed" badge, best score equal to the seed. This
// callout is the honest explanation: it renders only when the run carries a termination reason
// code (a run with a real optimization pass carries none, so it shows nothing new). Deliberately
// plain, quiet copy — no "rollout"/"GEPA"/"Pareto" jargon, matching the panel's vocabulary
// elsewhere (#461).
function TerminationReasonCallout({ reason }: { reason: string }) {
  const t = useTranslations("Optimizations.terminationReason");
  if (!isTerminationReason(reason)) return null; // defensive: an unrecognized/future code shows nothing rather than a raw key path.
  const messageKey =
    reason === "no_modules"
      ? "noModules"
      : reason === "no_instances"
        ? "noInstances"
        : "budgetExhaustedByBaseline";
  return (
    <div className="mt-4 rounded-xl border border-hairline bg-card-warm px-4 py-3">
      <p className="text-xs font-medium text-fg-3">{t("label")}</p>
      <p className="mt-1 text-sm text-ink">{t(messageKey)}</p>
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

// Paused-run callout (#102): the amber slot reserved by the run detail design (#105). Shows
// why the run paused (the endpoint stopped responding), that it auto-retries with backoff,
// and — for contributors — the "Retry now" override that signals the workflow to resume
// immediately. Partial progress stays visible via RunningProgress (paused is an active state).
function PausedCallout({
  reason,
  canWrite,
  retrying,
  resuming,
  error,
  onRetryNow,
}: {
  reason: string | null;
  canWrite: boolean;
  retrying: boolean;
  // A retry signal was sent and accepted; hold the button disabled as "Resuming…" until the
  // poll sees the run leave 'paused' (re-enabling it would invite duplicate signals).
  resuming: boolean;
  error: string | null;
  onRetryNow: () => void;
}) {
  return (
    // role="status": the callout appears/disappears via background polling, so politely
    // announce the pause (and its clearing on resume) to screen readers — sighted users see
    // the amber panel arrive, SR users would otherwise hear nothing.
    <div role="status" className="mt-4 rounded-xl border border-warning bg-warning-bg px-4 py-3">
      <p className="text-xs font-medium text-warning-fg">Run paused</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-warning-fg">
        {reason && reason.trim().length > 0
          ? reason
          : "Waiting for your endpoint to recover."}
      </p>
      {/* Quieter tone than the reason line so the amber block isn't three runs of the same
          bright warning color in dark mode — the "why" stays the loudest element. */}
      <p className="mt-1 text-xs text-fg-2">
        No progress has been lost — the run checks your endpoint automatically and resumes on
        its own once it responds.
      </p>
      {canWrite && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onRetryNow}
            disabled={retrying || resuming}
            // Hover is a low-alpha warning wash (the panel bg IS warning-bg, so the usual
            // hover:bg-{semantic}-bg convention would be a no-op here).
            className="rounded-full border border-warning px-4 py-2 text-sm font-medium text-warning-fg transition-colors hover:bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {retrying ? "Retrying…" : resuming ? "Resuming…" : "Retry now"}
          </button>
          {error && (
            <p role="alert" className="mt-2 text-xs text-danger-fg">
              {error}
            </p>
          )}
        </div>
      )}
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
