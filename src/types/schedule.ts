export type ScheduleFrequency = "hourly" | "daily" | "weekly" | "monthly";

export interface ScheduleSummary {
  id: string;
  name: string;
  frequency: ScheduleFrequency;
  local_hour: number | null;
  days_of_week: number[] | null;
  day_of_month: number | null;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  kind: string;
  provider: string;
  // "external" (HTTP) or "managed" (runs on Baseline's managed LLM). A managed agent is a
  // paid-plan System (#294), so the schedule picker gates it off the agent_kind.
  agent_kind: string;
  endpoint: string;
  response_path: string;
  created_at: string;
}

// isodow: 1=Mon .. 7=Sun — matches days_of_week storage and compute_next_run_at.
export const DAY_LABELS: { label: string; value: number }[] = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 7 },
];

export function frequencySummary(s: {
  frequency: ScheduleFrequency;
  local_hour: number | null;
  days_of_week: number[] | null;
  day_of_month: number | null;
  timezone: string;
}): string {
  const hh = s.local_hour != null ? `${String(s.local_hour).padStart(2, "0")}:00` : "";
  switch (s.frequency) {
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily at ${hh}`;
    case "weekly": {
      const days = (s.days_of_week ?? [])
        .map((d) => DAY_LABELS.find((l) => l.value === d)?.label)
        .filter(Boolean)
        .join(", ");
      return `Weekly · ${days || "—"} at ${hh}`;
    }
    case "monthly":
      return `Monthly · day ${s.day_of_month ?? "—"} at ${hh}`;
  }
}
