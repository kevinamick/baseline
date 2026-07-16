/**
 * Shared cooldown for the "Resend confirmation email" control (#498),
 * matching prod GoTrue's `smtp_max_frequency` of 60s (confirmed via the
 * Management API, 2026-07-13). The "check your email" screen starts its
 * countdown at mount (the initial confirmation just went out) and the
 * sign-in page's expired-link recovery card after each submit, so REPEAT
 * clicks are always spaced past GoTrue's send-frequency window.
 *
 * Known residual: the sign-in card's FIRST click has no cooldown in front of
 * it (nothing precedes it from that page's perspective), so a user who
 * reaches it within 60s of the original send — e.g. a mail-scanner burned
 * the token seconds after sign-up — can click into GoTrue's refusal window.
 * The action swallows that refusal into the same generic success
 * (anti-enumeration, see resendConfirmation in src/app/actions/auth.ts), so
 * they see "on its way" for a mail that was refused. Accepted trade-off: the
 * alternative is an error shape that leaks account state, and a retry after
 * the visible 60s cooldown succeeds.
 *
 * This constant only governs the UI's own disabled state, never GoTrue's
 * limit itself. Local `config.toml` sets `max_frequency = "1s"` so e2e can
 * exercise an actual second send without waiting out the full window. No
 * "use server"/"server-only" here so a client component and a plain e2e
 * import can both read the same number.
 */
export const RESEND_CONFIRMATION_COOLDOWN_SECONDS = 60;
