/**
 * Shared UI helpers for guide-related components. Extracted here to prevent
 * the same constants/functions from being duplicated across category-content.tsx,
 * interactive-step-list.tsx, and the /docs index page.
 */

export function difficultyBadgeClass(level: string): string {
  if (level === "Beginner") return "bg-success-bg text-success-fg";
  if (level === "Advanced") return "bg-accent/10 text-accent-ink";
  return "bg-fg-3/10 text-fg-3";
}

export const ROUTE_LABELS: Record<string, string> = {
  "/rubrics": "Go to Rubrics",
  "/schedules": "Go to Schedules",
  "/optimizations": "Go to Optimizations",
  "/dashboard": "Go to Dashboard",
  "/settings/connections": "Go to Connections",
  "/settings/team": "Go to Team Settings",
};

export function routeLabel(href: string): string {
  return ROUTE_LABELS[href] ?? "Open in Baseline";
}
