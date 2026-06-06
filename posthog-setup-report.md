<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into this Next.js 16 App Router project.

## Summary of changes

### New and modified files

| File | Change |
|---|---|
| `src/instrumentation-client.ts` | Added `capture_exceptions: true`, `defaults: "2026-01-30"`, switched `api_host` to `/ingest` reverse proxy, added `ui_host` |
| `next.config.ts` | Added PostHog reverse proxy rewrites (`/ingest/*`) and `skipTrailingSlashRedirect: true` |
| `src/lib/analytics/events.ts` | Added `auth.sign_in_clicked`, `billing.checkout_success`, `billing.checkout_cancelled` event types |
| `src/app/_components/sign-in-cta.tsx` | **New** — `/sign-in` link that fires `auth.sign_in_clicked` |
| `src/app/_components/checkout-status.tsx` | **New** — Detects `?checkout=success/cancel` URL params and fires the corresponding billing event |
| `src/app/_components/user-identifier.tsx` | **New** — Calls `posthog.identify()` with the Supabase Auth user id + traits on sign-in; calls `posthog.reset()` on sign-out |
| `src/app/page.tsx` | Replaced raw `SignInButton` with `SignInCta`; added `CheckoutStatus` (in Suspense boundary) |
| `src/app/layout.tsx` | Added `UserIdentifier` to the root layout body |
| `.env.local` | Set `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` |

### Events tracked

| Event name | Description | File |
|---|---|---|
| `app.page_viewed` | Page view on every route change | `src/app/_components/page-view.tsx` |
| `auth.signup_started` | User clicked a Sign Up CTA | `src/app/_components/sign-up-cta.tsx` |
| `auth.sign_in_clicked` | User clicked the Sign In button | `src/app/_components/sign-in-cta.tsx` |
| `auth.user_signed_up` | New user created (event type defined, **not currently emitted** — its only emitter was the removed Clerk webhook; re-wiring into the Supabase sign-up flow is tracked separately) | `src/lib/analytics/events.ts` |
| `billing.checkout_started` | User initiated a Stripe Checkout session | `src/app/actions/checkout.ts` |
| `billing.subscription_started` | Stripe checkout completed; subscription activated | `src/app/api/webhooks/stripe/route.ts` |
| `billing.checkout_success` | User returned to app after successful checkout | `src/app/_components/checkout-status.tsx` |
| `billing.checkout_cancelled` | User returned to app after cancelling checkout | `src/app/_components/checkout-status.tsx` |
| `system.web_vital` | Core Web Vitals (LCP, FID, CLS, etc.) | `src/app/_components/web-vitals.tsx` |

### User identification
- `UserIdentifier` component (added to root layout) calls `posthog.identify(userId, { email, name, created_at })` whenever a Supabase Auth user is signed in (via `onAuthStateChange`), correlating all client-side events to the server-side distinct ID.
- `posthog.reset()` is called when the user signs out to disconnect the anonymous session.

### Error tracking
- `capture_exceptions: true` in `instrumentation-client.ts` enables automatic unhandled exception capture via PostHog Error Tracking.

### Reverse proxy
- All PostHog requests are routed through `/ingest` in `next.config.ts`, bypassing ad blockers and improving data quality.

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/1628330)
- [Signup → Subscription funnel](/insights/5VeIyWzM) — 4-step conversion funnel
- [New signups over time](/insights/IyPjGtnr) — Daily new user registrations
- [Checkout conversion](/insights/knfitYnM) — Checkout started vs subscriptions activated
- [Daily active users](/insights/Yh0aNSyJ) — Unique daily active users
- [Checkout outcomes](/insights/F3lNCwuI) — Post-checkout success vs cancellation

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
