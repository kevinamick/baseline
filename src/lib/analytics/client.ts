"use client";

import posthog from "posthog-js";
import type { AnalyticsEvent } from "./events";
import { analyticsAllowed } from "@/lib/consent/cookie";

// Mirror the opt-out gate that instrumentation-client.ts applies at init: once
// the visitor rejects, PostHog is never initialized, so capturing here would
// only warn.
const enabled = () =>
  typeof window !== "undefined" &&
  !!process.env.NEXT_PUBLIC_POSTHOG_KEY &&
  analyticsAllowed();

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
