import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { analyticsAllowed } from "@/lib/consent/cookie";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

// Non-essential analytics (PostHog product analytics + Sentry error/session-
// replay monitoring) are consent-gated (#67/#68): off until the visitor accepts
// in the cookie banner. The banner reloads the page on accept, so this init
// re-runs and brings the SDKs online once consent is given.
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

if (sentryDsn && analyticsOn) {
  Sentry.init({
    dsn: sentryDsn,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    environment: process.env.NODE_ENV,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;