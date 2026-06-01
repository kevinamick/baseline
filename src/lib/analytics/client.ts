"use client";

import posthog from "posthog-js";
import type { AnalyticsEvent, LogLevel } from "./events";

const enabled = () =>
  typeof window !== "undefined" && !!process.env.NEXT_PUBLIC_POSTHOG_KEY;

export function track(event: AnalyticsEvent) {
  if (!enabled()) return;
  posthog.capture(event.name, event.props ?? {});
}

export function identify(userId: string, traits?: Record<string, unknown>) {
  if (!enabled()) return;
  posthog.identify(userId, traits);
}

export function reset() {
  if (!enabled()) return;
  posthog.reset();
}

export function log(
  level: LogLevel,
  message: string,
  properties?: Record<string, unknown>
) {
  if (!enabled()) return;
  posthog.capture("$log", {
    $log_message: message,
    $log_level: level,
    ...(properties ?? {}),
  });
}
