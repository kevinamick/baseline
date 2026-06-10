import posthog from "posthog-js";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (posthogKey) {
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
