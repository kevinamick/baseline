# Localizing Supabase auth emails (#247)

Supabase Auth (GoTrue) sends four emails itself, outside the app: **confirmation**
(sign-up), **recovery** (password reset), **email-change**, and **reauthentication**
(the password-change code). Their templates live in `supabase/templates/` and are
wired up in `[auth.email.template.*]` in `supabase/config.toml`.

Because GoTrue renders them — not Next.js — they have no access to the i18n
catalogs (`messages/*.json`) the app's own mail uses (#241). So localization here
works differently: each template embeds every locale inline and branches on the
recipient's locale, which we carry in Supabase `user_metadata`.

## How it works

1. **The locale travels in `user_metadata`.** GoTrue exposes a user's
   `user_metadata` to the template as `.Data`. The app stamps the actor's current
   request locale into it at the points that trigger one of these emails:

   | Email | Stamped by | Call |
   | --- | --- | --- |
   | confirmation | `signUp` (`src/app/actions/auth.ts`) | `signUp({ …, options: { data: { locale } } })` |
   | email-change | `changeEmail` (`src/app/actions/account.ts`) | `updateUser({ email, data: { locale } })` |
   | reauthentication | `changePassword` send-code step | `updateUser({ data: { locale } })` before `reauthenticate()` |
   | recovery | — | uses whatever locale is already stored (see below) |

   The locale comes from `currentUserLocale()` (`src/lib/email/i18n.ts`), which
   validates the request locale against `routing.locales` and falls back to the
   default — the same precedence as `resolveEmailLocale` (recipient preference →
   default), since for these flows the recipient is the actor.

2. **The templates branch on it.** Each `.html` wraps its body in
   `{{ if eq (index .Data `locale`) `es` }} … {{ else }} … {{ end }}`. A missing
   key (`index` on an absent metadata key) compares unequal to `es`, so the
   English branch is the safe default.

3. **Subjects branch too.** GoTrue renders the `subject` in `config.toml` through
   the same Go-template engine, so each subject carries the same conditional.

## Styling: generated from the design system (#301)

The four `.html` files are **generated**, not hand-written. They carry the same
Baseline email chrome as the app's own mail — porcelain background, cobalt logo,
white card, footer, dark-mode, hidden preview text, and the Outlook-safe cobalt
CTA (the reauthentication code uses a styled code chip instead of a button).

GoTrue renders static `.html`, so it can't import the design system
(`src/lib/email/templates/layout.ts`: `wrapEmail()` / `EMAIL` / `ctaButton()`) the
way the app templates do. Instead, `scripts/generate-auth-email-templates.mts`
imports those same helpers and renders each template once. The locale branches and
the GoTrue variables (`{{ .SiteURL }}`, `{{ .TokenHash }}`, `{{ .Token }}`) are
plain strings to the layout helpers, so they pass straight through into the output
for GoTrue to evaluate at send time — the design system stays single-sourced in
`layout.ts` with no drift.

> **Do not hand-edit `supabase/templates/*.html`** — a regenerate overwrites them.
> To change copy or layout, edit the generator (or `layout.ts`) and re-run:
>
> ```bash
> npm run gen:auth-emails
> ```
>
> The command is deterministic; the output is committed and read by `config.toml`.

### GoTrue strips HTML comments (Outlook VML caveat)

GoTrue renders these through Go's `html/template`, which **elides every HTML
comment** (`<!-- … -->`). Two consequences, both verified in Mailpit:

- The `ctaButton` Outlook **VML fallback** (`<!--[if mso]> … <![endif]-->`) is
  removed at send time, so legacy Outlook desktop falls back to the plain
  `<a class="em-cta">` button (a square-cornered filled button — the link still
  works in every client). This is a GoTrue-only effect; the app's own mail keeps
  its VML because it sends through nodemailer, not GoTrue. Accepted as-is — don't
  add MSO-conditional markup here expecting it to survive.
- The generator's `<!-- GENERATED FILE … -->` banner never reaches recipients
  (also stripped); it's only a signpost for anyone opening the committed `.html`.

### Recovery is the one exception

A password reset can be requested by an unauthenticated visitor, and we
deliberately don't reveal whether the address has an account (anti-enumeration in
`requestPasswordReset`). So there's no session to read a fresh locale from — the
recovery email renders in whatever locale is already on the account
(`user_metadata.locale`, stamped at sign-up or the last email-change /
password-change). If none is stored (pre-#247 accounts, or a user who never
triggered a stamp), it falls back to English. This matches the required
precedence: recipient preference → default.

> **Known staleness:** if a user signs up in `en`, later switches the app to `es`,
> and never changes their email or password, their stored locale stays `en` until
> the next stamping event. Refreshing it on sign-in would close this; left as a
> follow-up to keep this slice small.

## Adding another locale

`routing.locales` already includes `fr`, but these templates only carry `en` + `es`
per the issue scope, so `fr` recipients get English. To add `fr`: extend the
`goIf` helper (or the per-string variants) in
`scripts/generate-auth-email-templates.mts` with a
`{{ else if eq (index .Data `locale`) `fr` }}` branch, re-run `npm run
gen:auth-emails`, and add the same branch to each `subject` in `config.toml`. No
app code changes are needed — `currentUserLocale()` already stores any supported
locale.

## Verifying & applying

`config.toml` and template edits do **not** hot-reload — they're read at GoTrue
boot. Restarting is required, and unit tests only cover the app-side wiring (that
the locale reaches the GoTrue call); the rendered output must be checked in
Mailpit.

### Local

```bash
supabase stop && supabase start
```

Then drive each flow and read the captured mail in Mailpit (http://localhost:54324):

- **confirmation** — sign up at `/es/signup` (Spanish) and `/signup` (English).
- **email-change** — from `/es/settings/account`, request an email change; both the
  current and new address receive the Spanish version.
- **reauthentication** — from `/es/settings/account`, start a password change to get
  the code email in Spanish.
- **recovery** — sign up in `es` first (so the account stores `locale=es`), then use
  forgot-password; the reset email is Spanish.

For each, confirm **both the subject and the body** are localized — the subject is
the piece most worth eyeballing, since it depends on GoTrue templating the
`config.toml` subject string. If a subject ever shows literal `{{ … }}` text,
GoTrue on that version isn't templating subjects: revert just the four `subject`
lines to plain English and keep the body localization.

### Staging & production

The styled templates are shipped to prod automatically by CI on merge to `main`:
the "Push styled auth email templates to prod" step in `.github/workflows/ci.yml`
runs `.github/scripts/push-auth-email-templates.py`, which PATCHes **only** the
`mailer_subjects_*` / `mailer_templates_*_content` fields (subjects + bodies,
sourced from `content_path` in `config.toml`) onto the linked project via the
Management API. Do **not** run `supabase config push` — it applies the entire
`[auth]` config (OAuth provider state, redirect allow-list, SMTP) all-or-nothing
and would clobber the Dashboard-configured prod settings (see AGENTS.md). To apply
templates by hand instead, paste the equivalent subjects/bodies into **Auth →
Email Templates** in the Dashboard.

After a deploy, re-run the same Mailpit-equivalent checks against the deployed
SMTP (Resend) — send yourself each email in `es` and `en` and confirm subject +
body. No database migration is involved; this is auth config only.
