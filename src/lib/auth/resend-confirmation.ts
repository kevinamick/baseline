/**
 * Shared cooldown for the "Resend confirmation email" control (#498). Both
 * resend surfaces — the "check your email" screen (starts its countdown at
 * mount, since the initial confirmation just went out) and the sign-in page's
 * expired-link recovery banner (starts its countdown after a submit) — enforce
 * this same visible cooldown so the UI never offers a resend that prod's
 * GoTrue would refuse: `smtp_max_frequency` is 60s in prod (confirmed via the
 * Management API, 2026-07-13). Local `config.toml` sets `max_frequency = "1s"`
 * so e2e can exercise an actual second send without waiting out the full
 * window — this constant only governs the UI's own disabled state, not
 * GoTrue's send-frequency limit. No "use server"/"server-only" here so a
 * client component and a plain e2e import can both read the same number.
 */
export const RESEND_CONFIRMATION_COOLDOWN_SECONDS = 60;
