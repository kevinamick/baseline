# Social launch attribution

Conventions and measurement for Baseline's pseudonymous social launch (X, LinkedIn,
Reddit, Hacker News). Two independent rails feed attribution: PostHog UTM tracking
(consented traffic only) and per-post Access Codes (consent-independent, server-side
redemption counts). Read both sections below before dropping a post.

## UTM convention

| Param | Allowed values | Notes |
| --- | --- | --- |
| `utm_source` | `x`, `linkedin`, `reddit`, `hn` | The platform, not the account. |
| `utm_medium` | `social` (our own post), `community` (a reply in someone else's thread) | Distinguishes an original drop from a reply/comment placement. |
| `utm_campaign` | `YYYY-MM-DD-<slug>`, e.g. `2026-07-14-rubric-demo` | One campaign per post/drop. The date is the post date, not the link-click date. `<slug>` is short, kebab-case, and doubles as the Access Code name (see below). |
| `utm_content` | free-form, optional | Only when a single campaign has multiple placements worth telling apart, e.g. `thread-t6` (the 6th tweet in a thread) vs `reply-link` (a link dropped in a reply). Omit when there's only one placement. |

Rules:

- Links always target a specific marketing page (a category guide or a `/compare/*`
  page) — never the bare root `/`. The marketing surface is `src/lib/marketing/
  categories.ts` (9 guides) and `src/lib/marketing/comparisons.ts` (4 pages); pick
  the page whose angle matches the post's hook.
- `utm_source`/`utm_medium` are a closed enum (the table above) so breakdowns stay
  clean — don't invent new values ad hoc. Add a value here first if a new platform
  or placement type shows up.
- `utm_campaign` is one slug per post. If a post gets reposted or pinned later,
  that's a new campaign (new date), not a reused one — campaign identity should
  map 1:1 to "one thing we dropped on one day."

### Worked examples

Original X post promoting the rubric-based-evaluation guide:

```
https://www.usebaseline.com/rubric-based-evaluation?utm_source=x&utm_medium=social&utm_campaign=2026-07-14-rubric-demo
```

Same campaign, a reply deep in the thread with a different placement worth
distinguishing from the top-level post:

```
https://www.usebaseline.com/rubric-based-evaluation?utm_source=x&utm_medium=social&utm_campaign=2026-07-14-rubric-demo&utm_content=thread-t6
```

Reddit comment (not our own post) linking the hallucinations lander:

```
https://www.usebaseline.com/reduce-ai-hallucinations?utm_source=reddit&utm_medium=community&utm_campaign=2026-07-16-hallucination-fix
```

LinkedIn post comparing Baseline to Braintrust:

```
https://www.usebaseline.com/compare/braintrust?utm_source=linkedin&utm_medium=social&utm_campaign=2026-07-20-vs-braintrust
```

Hacker News comment reply linking the pricing explainer:

```
https://www.usebaseline.com/ai-eval-pricing?utm_source=hn&utm_medium=community&utm_campaign=2026-07-22-eval-points&utm_content=reply-link
```

## The dual-rail attribution model

**Rail 1 — PostHog UTMs.** Consented traffic only. Baseline's analytics are
opt-in (GDPR): posthog-js only initializes after a visitor accepts the cookie
banner (`src/instrumentation-client.ts`, gated on `analyticsAllowed()` from
`src/lib/consent/cookie.ts`). A visitor who declines, or who hasn't yet chosen,
is invisible to every insight in this doc — their pageview, their UTM tags, and
any conversion they complete leave zero PostHog trace. Treat every PostHog number
here as a **floor**, not a total, and never quote it as "total clicks from this
post."

**Rail 2 — per-post Access Codes.** Consent-independent. Each social drop mints
its own Access Code (`access_codes` table, `scripts/access-codes.mts`), whose
redemption count (`access_code_redemptions`, a server-side row written at
sign-up) is unaffected by cookie consent — a redemption is recorded whenever
someone actually signs up with the code, whether or not they accepted analytics.
This is the conversion **truth** for a given post; PostHog UTMs are the
**shape** (which platform, which placement, how the traffic behaved on-site).

**Convention:** the code's name mirrors the campaign slug, uppercased, dropping
the date — e.g. campaign `2026-07-14-rubric-demo` mints code `RUBRIC-DEMO` (or a
short evocative variant like `RUBRIC10` when a shorter code reads better in a
screenshot or a spoken mention). Keep max_redemptions small (the launch is
invite-only and pseudonymous — a code isn't meant to go viral past the post's
actual reach) and expiry short (a code tied to one post shouldn't still be live
weeks later attributing unrelated traffic to it). Pattern:

```
npm run access-codes:mint -- --code RUBRIC10 --max-redemptions 25 --expires-at 2026-07-21T00:00:00Z
```

Adjust `--max-redemptions` to the post's expected reach and `--expires-at` to
roughly a week out — long enough for a slow reader, short enough that a late
redemption isn't credited to a campaign that's gone cold. See
`scripts/access-codes.mts` for the full flag set (`--trial-days`,
`--stripe-coupon-id`, `--plan-slug`).

### Campaign ↔ code mapping

One row per post. Fill in as codes are minted.

| Date | Platform | Campaign slug (`utm_campaign`) | Page | Access Code | max_redemptions | Expires |
| --- | --- | --- | --- | --- | --- | --- |
| _2026-07-14_ | _x_ | _2026-07-14-rubric-demo_ | _/rubric-based-evaluation_ | _RUBRIC10_ | _25_ | _2026-07-21_ |

## Current instrumentation

What actually happens today, verified by reading the code and querying the live
PostHog schema (project 440128) — not assumed from docs.

**UTM capture is automatic, SDK-level, and requires consent.** `posthog.init()`
only runs once `analyticsAllowed()` is true (`src/instrumentation-client.ts:10-21`).
Once initialized, posthog-js's built-in campaign-params behavior (`utm_source`,
`utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, confirmed present in the
vendored SDK's `node_modules/posthog-js/dist/customizations.full.js`) auto-captures
these as **person properties** — both a "last touch" (`utm_source`, etc.) and a
"first touch" (`$initial_utm_source`, etc.) — with no config needed. This is
confirmed empirically against this project's live schema: `utm_source`,
`utm_medium`, `utm_campaign`, `utm_content`, `utm_term` and their `$initial_*`
counterparts all appear in the person-property schema.

**They do NOT land as event properties on `app.page_viewed`.** Baseline disables
posthog-js's autocaptured `$pageview` (`capture_pageview: false`,
`src/instrumentation-client.ts:17`) and instead fires a custom `app.page_viewed`
event from `src/app/_components/page-view.tsx:11-21`. Querying this project's
live data (last 180 days, 72 `app.page_viewed` events) confirms **0 of them**
carry a `utm_source` event property — UTM tags only land on the **person**, not
on this specific event. Every insight in the dashboard below therefore breaks
down and filters on `person`-type `utm_source`/`utm_medium`/`utm_campaign`
properties, never `event`-type ones.

**A sign-up conversion event exists: `auth.user_signed_up`.** Fired server-side
from `signUp` (`src/app/actions/auth.ts:236-243`) via the posthog-node client in
`src/lib/analytics/server.ts:26-46`, keyed on `{ userId, email_domain }` only —
confirmed against the live schema, which shows no URL/UTM property on this event.
This server-side `track()` is **not** consent-gated (it's a different code path
from the client's consent-gated `track()`/`identify()` in `src/lib/analytics/
client.ts`) and always fires on a genuine new sign-up (guarded against Supabase's
anti-enumeration empty-`identities` response, `auth.ts:222-229`).

**How UTM data reaches the sign-up event at all: the identify() merge.**
`UserIdentifier` (`src/app/_components/user-identifier.tsx:30-34`), mounted
site-wide in the root layout, calls the client's consent-gated `identify(userId,
...)` on every auth-state change, including right after sign-up. PostHog's
standard `identify()` behavior merges the pre-sign-up anonymous person (who
carries the `$initial_utm_source` etc. set during the UTM-tagged visit) into the
now-identified person keyed by `userId` — the same `distinct_id` the server-side
`auth.user_signed_up` event used. So a funnel from a UTM-tagged `app.page_viewed`
to `auth.user_signed_up`, aggregated by person, **can** work — but only when
**both** hold: (1) the visitor consented (else there's no anonymous PostHog
identity to merge from), and (2) the client-side `identify()` call actually runs
and completes the merge (it's not guaranteed to race ahead of or behind the
server-side capture, though PostHog's person-merge is eventually consistent
either order). The funnel insight below exists and is wired correctly, but read
it as directional, not exact, for exactly this reason.

### Proposed follow-up (not implemented)

The signup event's reliance on the identify()-merge is fragile: it depends on
consent AND on client/server timing outside our control. A consent-safe,
deterministic alternative — **not implemented as part of this change** — would be
to read the visitor's first-touch UTM params client-side (posthog-js already
exposes them via `posthog.get_property("$initial_utm_source")` once consented)
and pass them as hidden fields into the `signUp` server action, so
`auth.user_signed_up` carries `utm_source`/`utm_campaign` directly as event
properties rather than relying on a person merge. This still respects the
consent gate (the values are only readable client-side after posthog-js has
initialized) and needs no new tracking surface — it's a matter of threading three
already-captured values one hop further. Left for a follow-up issue rather than
built here, since the dual-rail model (Access Codes) already gives an exact,
consent-independent conversion count per campaign without it.

## Reading results

**PostHog — "Social attribution" dashboard** (project 440128):
<https://us.posthog.com/project/501872/dashboard/1832923>

Four insights, all filtered/broken down on **person**-type UTM properties (see
above for why):

1. **Pageviews by UTM source** — `app.page_viewed`, breakdown by person
   `utm_source`, filtered to `utm_source is_set`. Which platform is sending
   consented traffic.
2. **Pageviews by UTM campaign (top campaigns)** — same event, breakdown by
   person `utm_campaign`. Which post is performing.
3. **Marketing-page pageviews from social/community** — `app.page_viewed`
   filtered to `$pathname` in the 13 marketing pages (9 category guides + 4
   `/compare/*` pages) AND person `utm_medium` in `{social, community}`,
   broken down by `utm_source`. Confirms social/community traffic is actually
   landing on a real page, not just the root.
4. **UTM-tagged visit to sign-up** — funnel from a UTM-tagged `app.page_viewed`
   (person `utm_source` set) to `auth.user_signed_up`. Read directionally per
   the consent + identify-timing caveat above, not as an exact count.

**Access Codes — redemption truth per post:**

```
npm run access-codes:status -- --code RUBRIC10
```

Reports `redeemed_count / max_redemptions`, expiry, and active/expired/exhausted
status. This is the number to put in a "how did the launch do" recap — it's
exact and consent-independent. Use the PostHog dashboard to explain *why* (which
platform, which placement, whether traffic reached the intended page) — not to
recount *how many* signed up.
