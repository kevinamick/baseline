"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Switch } from "@/app/_components/switch";
import { ClientDate } from "@/app/_components/client-date";
import { ChevronRightIcon, PlusIcon, TrashIcon } from "@/app/_components/icons";
import { ScheduleWizard } from "./schedule-wizard";
import {
  getSchedule,
  setScheduleEnabled,
  deleteSchedule,
} from "@/app/actions/schedules";
import { StatusBadge } from "@/app/_components/eval-run-helpers";
import { frequencySummary, type ScheduleSummary, type ConnectionSummary } from "@/types/schedule";
import type { RubricSummary } from "@/types/rubric";
import type { EvalRunStatus } from "@/types/eval-run";

interface Props {
  schedules: ScheduleSummary[];
  rubrics: RubricSummary[];
  connections: ConnectionSummary[];
  canWrite: boolean;
  /** Paid plans can select/create a Managed Agent System; Free sees it gated (#294). */
  managedAllowed: boolean;
}

type ScheduleDetail = Awaited<ReturnType<typeof getSchedule>>;

export function SchedulesLayout({ schedules, rubrics, connections, canWrite, managedAllowed }: Props) {
  const t = useTranslations("Schedules");
  const router = useRouter();
  const [showWizard, setShowWizard] = useState(false);
  // `selectedId` is the explicit pick and starts null, so mobile opens on the
  // list (drill-in). `detailId` is what the right pane actually shows: it falls
  // back to the first schedule, so the md+ two-pane split is never half-empty
  // even before a pick. The mobile show/hide keys off selectedId (null → list);
  // the detail content/fetch and the list highlight key off detailId.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailId = selectedId ?? schedules[0]?.id ?? null;
  const [detail, setDetail] = useState<ScheduleDetail>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!detailId) return;
    let cancelled = false;
    setDetailError(null);
    void (async () => {
      setLoadingDetail(true);
      try {
        const d = await getSchedule(detailId);
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) {
          setDetail(null);
          setDetailError(t("detailLoadError"));
        }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detailId, schedules, t]);

  async function toggleEnabled(id: string, next: boolean) {
    await setScheduleEnabled(id, next);
    router.refresh();
  }

  async function handleDelete(id: string) {
    if (!confirm(t("deleteConfirm"))) return;
    await deleteSchedule(id);
    if (detailId === id) {
      setSelectedId(null);
      setDetail(null);
    }
    router.refresh();
  }

  const sched = detail?.schedule as Record<string, unknown> | undefined;

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
      {/* List — full-width first pane on mobile (drill-in), fixed-width column at md+ */}
      <div
        className={`${selectedId ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card md:w-[360px]`}
      >
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{t("panelTitle")}</h2>
          {canWrite && (
            <button
              type="button"
              onClick={() => setShowWizard(true)}
              className="inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-fg-on-ink transition-colors hover:bg-ink-hover"
            >
              <PlusIcon size={13} /> {t("new")}
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {schedules.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-fg-3">
              {t("empty")}
            </p>
          ) : (
            schedules.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={`mb-1 flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  detailId === s.id ? "bg-accent-soft" : "hover:bg-card-warm"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{s.name}</span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      s.enabled ? "bg-success-bg text-success-fg" : "bg-card-warm text-fg-3"
                    }`}
                  >
                    {s.enabled ? t("on") : t("off")}
                  </span>
                </div>
                <span className="text-xs text-fg-3">{frequencySummary(s)}</span>
                <span className="text-[11px] text-fg-4">
                  {t("next")} <ClientDate value={s.next_run_at} />
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail — shown once a schedule is picked on mobile; always present at md+ */}
      <div
        className={`${selectedId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-hairline-cool bg-card`}
      >
        {detailError ? (
          <div className="flex flex-1 items-center justify-center text-sm text-danger-fg">
            {detailError}
          </div>
        ) : !detailId || !sched ? (
          <div className="flex flex-1 items-center justify-center text-sm text-fg-4">
            {loadingDetail ? t("loading") : t("selectSchedule")}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  aria-label={t("back")}
                  className="-ml-1.5 mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-2 transition-colors hover:bg-card-warm hover:text-ink md:hidden"
                >
                  <ChevronRightIcon size={18} className="rotate-180" />
                </button>
                <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold tracking-[-0.015em] text-ink">
                  {String(sched.name)}
                </h2>
                {sched.description ? (
                  <p className="mt-0.5 text-sm text-fg-3">{String(sched.description)}</p>
                ) : null}
                </div>
              </div>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-3">
                  <Switch
                    checked={Boolean(sched.enabled)}
                    onChange={(next) => toggleEnabled(String(sched.id), next)}
                    label={t("enabled")}
                  />
                  <button
                    type="button"
                    onClick={() => handleDelete(String(sched.id))}
                    aria-label={t("deleteAria")}
                    className="flex h-11 w-11 items-center justify-center rounded-full text-fg-4 transition-colors hover:bg-danger-bg hover:text-danger sm:h-8 sm:w-8"
                  >
                    <TrashIcon size={15} />
                  </button>
                </div>
              )}
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <Detail label={t("detail.rubric")} value={detailNested(sched, "rubrics", "name")} />
              <Detail label={t("detail.system")} value={detailNested(sched, "connections", "name")} />
              <Detail label={t("detail.cadence")} value={frequencySummary(sched as never)} />
              <Detail label={t("detail.timezone")} value={String(sched.timezone)} />
              <Detail label={t("detail.nextRun")} value={<ClientDate value={sched.next_run_at as string | null} />} />
              <Detail label={t("detail.lastRun")} value={<ClientDate value={sched.last_run_at as string | null} />} />
              <Detail
                label={t("detail.recipients")}
                value={
                  Array.isArray(sched.notification_emails) && sched.notification_emails.length
                    ? (sched.notification_emails as string[]).join(", ")
                    : "—"
                }
              />
            </dl>

            <h3 className="mt-7 text-sm font-semibold text-ink">{t("runHistory")}</h3>
            <div className="mt-2 flex flex-col gap-1.5">
              {(detail?.runs ?? []).length === 0 ? (
                <p className="py-4 text-sm text-fg-3">{t("noRuns")}</p>
              ) : (
                detail!.runs.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-card-warm px-3 py-2"
                  >
                    <span className="text-xs text-fg-3">
                      <ClientDate value={run.created_at} />
                    </span>
                    <div className="flex items-center gap-2">
                      {run.status === "completed" && run.overall_score != null && (
                        <span className="text-xs font-medium text-ink">
                          {(Number(run.overall_score) * 100).toFixed(0)}%
                        </span>
                      )}
                      <StatusBadge
                        status={run.status as EvalRunStatus}
                        title={run.error_message ?? undefined}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {showWizard && (
        <ScheduleWizard
          rubrics={rubrics}
          connections={connections}
          managedAllowed={managedAllowed}
          onClose={() => setShowWizard(false)}
          onCreated={() => router.refresh()}
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

function detailNested(obj: Record<string, unknown>, rel: string, key: string): string {
  const nested = obj[rel];
  if (Array.isArray(nested)) return String((nested[0] as Record<string, unknown>)?.[key] ?? "—");
  if (nested && typeof nested === "object") return String((nested as Record<string, unknown>)[key] ?? "—");
  return "—";
}
