import posthog from "posthog-js";
import { analyticsAllowed } from "@/lib/consent/cookie";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

// Non-essential analytics (PostHog product analytics + client-side exception
// autocapture) are consent-gated (#67/#68): off until the visitor accepts in the
// cookie banner. The banner reloads the page on accept, so this init re-runs and
// brings PostHog online once consent is given.
const analyticsOn = analyticsAllowed();

if (posthogKey && analyticsOn) {
  posthog.init(posthogKey, {
    api_host: "/ingest",
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_pageview: false, // app.page_viewed is emitted by PageView component
    capture_pageleave: true,
    capture_exceptions: true,
    person_profiles: "identified_only",
  });
}
