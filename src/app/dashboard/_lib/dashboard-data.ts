import type { EvalRunStatus } from "@/types/eval-run";
import type { EvaluationMode } from "@/types/rubric";

export const DAY_MS = 86_400_000;

// Selectable score-over-time windows (days). Mirrors the design-system mockup.
export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

// Minimum latest score (0–1) for a rubric to count as "passing". Hardcoded for
// now; will become a per-team configurable setting.
export const PASSING_THRESHOLD = 0.8;

// Quiet, low-chroma line tones (shared L/C, varied hue) so multiple series read
// as distinct without fighting the yellow accent. The focused series overrides
// to ink + yellow markers at render time. Assigned by rubric index.
export const RUBRIC_TONES = [
  "oklch(0.60 0.055 250)",
  "oklch(0.60 0.055 150)",
  "oklch(0.60 0.055 25)",
  "oklch(0.60 0.055 310)",
  "oklch(0.60 0.055 195)",
  "oklch(0.60 0.055 90)",
  "oklch(0.60 0.055 340)",
  "oklch(0.60 0.055 120)",
];

export function toneFor(index: number): string {
  return RUBRIC_TONES[index % RUBRIC_TONES.length];
}

// Request-time clock read, isolated here so the page (a Server Component that
// renders once per request) can use "now" without tripping the render-purity rule.
export function nowMs(): number {
  return Date.now();
}

// ---- Serializable payload (server → client) ------------------------------

export interface DashRun {
  id: string;
  rubricId: string;
  runNo: number; // sequential per-rubric, oldest = 1
  t: number; // created_at epoch ms
  score: number | null; // overall_score, 0–1
  status: EvalRunStatus;
}

export interface DashCriterion {
  name: string;
  weight: number;
  score: number | null; // avg over the latest completed run's rows
}

export interface DashRubric {
  id: string;
  name: string;
  mode: EvaluationMode;
  createdAt: string;
  tone: string;
  criteria: DashCriterion[];
}

export interface DashboardData {
  teamName: string;
  rubrics: DashRubric[];
  // 90d window ∪ each rubric's last-N runs ∪ its latest scored run (see the
  // dashboard_runs RPC) — ascending by created_at.
  runs: DashRun[];
  today: number; // server "now" epoch ms — keeps the x-axis hydration-stable
}

// ---- Pure presentation helpers -------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDay(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function fmtDayShort(t: number): string {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function relTime(t: number, now: number): string {
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function pct(score: number): number {
  return Math.round(score * 100);
}

// Theme-aware text-color buckets for a 0–1 score. The `score-*-ink` tokens resolve
// to dark shades in light mode (which clear WCAG AA on white/warm and the
// soft-cobalt selected-row surface #dfe6fb) and to the bright fills in dark mode,
// so small bold score numbers stay accessible on any surface in either theme.
export function scoreClass(score: number): string {
  if (score >= 0.8) return "text-score-high-ink";
  if (score >= 0.5) return "text-score-mid-ink";
  return "text-score-low-ink";
}

// Hex variants for the dark focus card, where the light bucket colors are too dim.
export function scoreHexDark(score: number): string {
  if (score >= 0.8) return "#34D399";
  if (score >= 0.5) return "#FBBF24";
  return "#F87171";
}
