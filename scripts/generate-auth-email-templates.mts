/**
 * Generate the four Supabase/GoTrue auth email templates from the Baseline
 * design-system layout (#301).
 * ─────────────────────────────────────────────────────────────────────────────
 * GoTrue renders these as *static* `.html` files at send time, so it can't
 * import `wrapEmail()`/`EMAIL`/`ctaButton()` from `layout.ts` the way the
 * app-rendered templates do (#202). Instead of hand-porting the chrome into each
 * file (which drifts), this script imports the SAME layout helpers and renders
 * them once, keeping the design system single-sourced.
 *
 * The trick: `wrapEmail`/`ctaButton`/`EMAIL` only do string interpolation, so
 * the GoTrue directives we feed them — the `{{ if eq (index .Data `locale`)
 * `es` }}…{{ end }}` locale branches (#247) and the `{{ .SiteURL }}` /
 * `{{ .TokenHash }}` / `{{ .Token }}` variables — pass through verbatim into the
 * generated HTML. GoTrue then evaluates them at send time. We never run the Go
 * template here; we only emit it.
 *
 * Regenerate after editing this script or `layout.ts`:
 *   npm run gen:auth-emails
 * The output is committed; CI/`config.toml` point at these files. Do NOT edit
 * the generated `supabase/templates/*.html` by hand — change this script.
 *
 * Caveat: GoTrue renders via Go `html/template`, which strips ALL HTML comments.
 * So `ctaButton`'s Outlook VML fallback (in `<!--[if mso]>`) does not survive —
 * legacy Outlook desktop gets the plain `<a>` button (the link works everywhere).
 * Don't add MSO-conditional markup here expecting it to render. See the runbook.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EMAIL, ctaButton, wrapEmail } from "../src/lib/email/templates/layout.ts";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "supabase", "templates");

// ─── GoTrue / Go-template fragments (emitted, never evaluated here) ────────────

/** Backtick — Go template-literal delimiter. Kept out of the JS string literals
 *  below so we don't have to escape it inside our own template literals. */
const BT = "`";

/** Wrap Spanish + English variants in a GoTrue locale branch (#247). A missing
 *  `locale` key yields nil, so `eq nil "es"` is false → the English fallback. */
const goIf = (es: string, en: string): string =>
  `{{ if eq (index .Data ${BT}locale${BT}) ${BT}es${BT} }}${es}{{ else }}${en}{{ end }}`;

// GoTrue variables, preserved exactly (incl. query params) from the #247
// templates. `&amp;` is the HTML-correct separator; clients decode it on click,
// and it matches how `ctaButton` is fed escaped URLs by the app templates.
const CONFIRM_HREF =
  "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email";
const RECOVERY_HREF =
  "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/reset-password";
const EMAIL_CHANGE_HREF =
  "{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=email_change&amp;next=/settings/account";
const TOKEN = "{{ .Token }}";

// ─── Small body helpers (mirror the app templates' EMAIL-token usage) ─────────

const h2 = (text: string): string => `<h2 style="${EMAIL.h2}">${text}</h2>`;
const p = (text: string): string => `<p style="${EMAIL.p}">${text}</p>`;

/** Styled one-time-code block for reauthentication — the design-system analogue
 *  of `ctaButton`, but for a code the user copies rather than a link. A light
 *  chip stays legible on the dark-mode card (dark ink on porcelain). */
const codeBlock = (token: string): string =>
  `
<div style="margin:24px 0 6px;text-align:center;">
  <span style="display:inline-block;background:#F5F3EC;border:1px solid #E6E2D7;border-radius:12px;padding:14px 26px;font-family:${EMAIL.font};font-size:28px;font-weight:700;letter-spacing:8px;color:#0E0E10;-webkit-text-size-adjust:none;">${token}</span>
</div>`.trim();

// Footer chrome, localized (mirrors `wrapEmail`'s footerText/questionsLabel).
// These are security/auth emails, so the copy identifies the sender rather than
// reusing the app templates' subscription line.
const FOOTER = goIf(
  "Este es un mensaje de seguridad automático de Baseline.",
  "This is an automated security message from Baseline."
);
const QUESTIONS = goIf("¿Preguntas?", "Questions?");
const LANG = goIf("es", "en");

// ─── Template bodies ──────────────────────────────────────────────────────────

const confirmationBody = goIf(
  [
    h2("Confirma tu correo"),
    p("Te damos la bienvenida a Baseline. Sigue este enlace para confirmar tu cuenta y terminar de registrarte:"),
    ctaButton(CONFIRM_HREF, "Confirmar mi correo"),
    p("Si no creaste una cuenta de Baseline, puedes ignorar este mensaje sin problema."),
  ].join("\n"),
  [
    h2("Confirm your email"),
    p("Welcome to Baseline. Follow this link to confirm your account and finish signing up:"),
    ctaButton(CONFIRM_HREF, "Confirm your email"),
    p("If you didn't create a Baseline account, you can safely ignore this email."),
  ].join("\n")
);

const recoveryBody = goIf(
  [
    h2("Restablece tu contraseña"),
    p("Recibimos una solicitud para restablecer la contraseña de tu cuenta de Baseline. Sigue este enlace para elegir una nueva:"),
    ctaButton(RECOVERY_HREF, "Restablecer mi contraseña"),
    p("Si no solicitaste esto, puedes ignorar este mensaje sin problema. Tu contraseña no cambiará."),
  ].join("\n"),
  [
    h2("Reset your password"),
    p("We received a request to reset the password on your Baseline account. Follow this link to choose a new one:"),
    ctaButton(RECOVERY_HREF, "Reset your password"),
    p("If you didn't request this, you can safely ignore this email — your password won't change."),
  ].join("\n")
);

const emailChangeBody = goIf(
  [
    h2("Confirma el cambio de tu correo"),
    p("Recibimos una solicitud para cambiar el correo de tu cuenta de Baseline. Sigue este enlace para confirmarlo:"),
    ctaButton(EMAIL_CHANGE_HREF, "Confirmar el cambio de correo"),
    p("Con la doble confirmación activada, recibirás este mensaje en tu dirección actual y en la nueva. Confírmalo desde cada una para completar el cambio."),
    p("Si no solicitaste esto, puedes ignorar este mensaje sin problema."),
  ].join("\n"),
  [
    h2("Confirm your email change"),
    p("We received a request to change the email on your Baseline account. Follow this link to confirm:"),
    ctaButton(EMAIL_CHANGE_HREF, "Confirm email change"),
    p("With double confirmation on, you'll get this on both your current and new address — confirm from each to finish the change."),
    p("If you didn't request this, you can safely ignore this email."),
  ].join("\n")
);

const reauthenticationBody = goIf(
  [
    h2("Confirma el cambio de tu contraseña"),
    p("Recibimos una solicitud para cambiar la contraseña de tu cuenta de Baseline. Escribe este código en los ajustes de la cuenta para confirmar que eres tú:"),
    codeBlock(TOKEN),
    p("Este código caduca pronto. Si no solicitaste un cambio de contraseña, puedes ignorar este mensaje sin problema. Tu contraseña no cambiará."),
  ].join("\n"),
  [
    h2("Confirm your password change"),
    p("We received a request to change the password on your Baseline account. Enter this code back in the account settings to confirm it's really you:"),
    codeBlock(TOKEN),
    p("This code expires shortly. If you didn't request a password change, you can safely ignore this email — your password won't change."),
  ].join("\n")
);

// ─── Render + write ───────────────────────────────────────────────────────────

const BANNER =
  "<!-- GENERATED FILE — do not edit by hand.\n" +
  "     Source: scripts/generate-auth-email-templates.mts + src/lib/email/templates/layout.ts\n" +
  "     Regenerate: npm run gen:auth-emails -->\n";

const templates: { file: string; previewText: string; body: string }[] = [
  {
    file: "confirmation.html",
    previewText: goIf(
      "Confirma tu correo para terminar de registrarte.",
      "Confirm your email to finish signing up."
    ),
    body: confirmationBody,
  },
  {
    file: "recovery.html",
    previewText: goIf(
      "Restablece la contraseña de tu cuenta de Baseline.",
      "Reset your Baseline account password."
    ),
    body: recoveryBody,
  },
  {
    file: "email-change.html",
    previewText: goIf(
      "Confirma el cambio de correo de tu cuenta.",
      "Confirm the email change on your account."
    ),
    body: emailChangeBody,
  },
  {
    file: "reauthentication.html",
    previewText: goIf(
      "Tu código para confirmar el cambio de contraseña.",
      "Your password-change confirmation code."
    ),
    body: reauthenticationBody,
  },
];

for (const { file, previewText, body } of templates) {
  const html =
    BANNER +
    wrapEmail({
      previewText,
      body,
      lang: LANG,
      footerText: FOOTER,
      questionsLabel: QUESTIONS,
    }) +
    "\n";
  writeFileSync(join(templatesDir, file), html, "utf8");
  console.log(`wrote supabase/templates/${file}`);
}
