"use client";

import posthog from "posthog-js";
import type { DeviceProps } from "./events";
import { track } from "./client";

const enabled = () =>
  typeof window !== "undefined" && !!process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Mirror PostHog's auto-detected $browser/$os/$device_type onto our own props
// so events stay queryable if we ever swap vendors or export to a warehouse.
export function deviceProps(): DeviceProps {
  if (!enabled()) return {};
  const read = (k: string) => {
    try {
      const v = posthog.get_property(k);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  return {
    browser: read("$browser"),
    browser_version: read("$browser_version"),
    os: read("$os"),
    device_type: read("$device_type"),
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
  };
}

// Emit `session.started` exactly once per PostHog session.
// PostHog's session boundary is 30 min of inactivity; we mirror it by
// keying off get_session_id() in localStorage.
const SESSION_KEY = "baseline.session.started";

export function ensureSessionStarted() {
  if (!enabled()) return;
  let sessionId: string | null = null;
  try {
    sessionId = posthog.get_session_id?.() ?? null;
  } catch {
    return;
  }
  if (!sessionId) return;

  const last = window.localStorage.getItem(SESSION_KEY);
  if (last === sessionId) return;
  window.localStorage.setItem(SESSION_KEY, sessionId);

  track({
    name: "session.started",
    props: { session_id: sessionId, ...deviceProps() },
  });
}
