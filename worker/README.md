# eval-worker

Background worker for Baseline. It runs the Temporal worker that executes eval
runs and optimization runs (the sole executor — ADR-0006), and drains the pgmq
job queue as a thin dispatcher that starts scheduled eval-run workflows
(pg_cron can't call Temporal). Terminal-state emails are sent from the run's
Activities.

## Local development

1. Start the local Supabase stack from the repo root: `npm run db:start`.
2. Copy the env template and fill it in:
   ```sh
   cp .env.local.example .env.local
   ```
   Paste the `service_role` key from the `supabase start` output into
   `SUPABASE_SERVICE_ROLE_KEY`.
3. Run the worker: `npm run dev`.

## Transactional email (eval-run + optimization)

Both emailers route through one shared transport in `src/emailer.ts`
(`deliver`), so eval-run mail (`src/emailer.ts`) and optimization mail
(`src/optimization-emailer.ts`) pick the same transport:

- **Production** sends via [Resend](https://resend.com) using `RESEND_API_KEY` —
  the same provider the app's invitations and Supabase Auth emails use, so all
  transactional mail leaves through one provider.
- **Local dev** routes to **Mailpit over SMTP** instead. This is gated on
  `MAILPIT_SMTP_HOST`: when it is set, the worker delivers to Mailpit rather than
  Resend, so eval-run and optimization emails are inspectable in the Mailpit UI
  at <http://127.0.0.1:54324> and never bounce seed/test recipients off the real
  Resend account. No `RESEND_API_KEY` is needed on this path.

`.env.local.example` ships the local Mailpit defaults
(`MAILPIT_SMTP_HOST=127.0.0.1`, `MAILPIT_SMTP_PORT=54325` — Supabase's local
Mailpit `smtp_port` from `supabase/config.toml` `[inbucket]`). Production leaves
`MAILPIT_SMTP_HOST` **unset**, preserving the Resend path with the real key.

The SMTP transport (`nodemailer`) is a **devDependency** and is imported
dynamically only on the Mailpit path, so the production code path carries no
extra hard dependency.

Both emailers render their bodies through the Baseline Design System email
chrome (`wrapEmail` / `ctaButton` / `EMAIL`) in `src/email-layout.ts`. That file
is a deliberate copy of the canonical app-tier source
`src/lib/email/templates/layout.ts` — the worker is independently Dockerized (its
Dockerfile copies only `worker/src`), so it cannot import from the app's `src/`.
Keep the copy in sync when the design system chrome changes.
