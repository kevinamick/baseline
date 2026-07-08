/**
 * Baseline Design System — transactional email layout (worker copy).
 * ──────────────────────────────────────────────────────────────────
 * DUPLICATED from the canonical app-tier source:
 *   src/lib/email/templates/layout.ts
 *
 * The worker is a separate, independently-Dockerized package (see worker/Dockerfile:
 * only `worker/src` is copied into the image), so it cannot import from the app's
 * `src/lib/email/`. This is a deliberate copy — keep it in sync with the canonical
 * file when the design system chrome changes. Only the worker needs `EMAIL`,
 * `ctaButton`, and `wrapEmail`, so the localization-specific footer params from the
 * canonical version are retained verbatim for fidelity but default to English.
 *
 * Tokens (inline, email-safe — no CSS variables):
 *   paper    #F5F3EC   warm porcelain background
 *   card     #FFFFFF   elevated card surface
 *   ink      #0E0E10   primary text
 *   muted    #3F3F46   secondary / body text
 *   accent   #2B5BD7   cobalt (CTA, links, logo mark)
 *   border   #E6E2D7   hairline
 */

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica Neue, Arial, sans-serif";

// ─── Style constants ──────────────────────────────────────────────────────────

/**
 * Inline style strings to apply directly to elements inside the body string.
 *
 *   `<h2 style="${EMAIL.h2}">Title</h2>`
 *   `<p style="${EMAIL.p}">Body with <strong style="${EMAIL.strong}">bold</strong>.</p>`
 */
export const EMAIL = {
  font: FONT,

  h2: [
    "margin:0 0 16px",
    `font-family:${FONT}`,
    "font-size:21px",
    "font-weight:600",
    "letter-spacing:-0.025em",
    "line-height:1.15",
    "color:#0E0E10",
  ].join(";"),

  p: [
    "margin:0 0 14px",
    `font-family:${FONT}`,
    "font-size:15px",
    "line-height:1.65",
    "color:#3F3F46",
  ].join(";"),

  /** Apply to <strong> inside a paragraph. */
  strong: "color:#0E0E10;font-weight:600",
};

// ─── CTA button ───────────────────────────────────────────────────────────────

/**
 * Full-bleed cobalt CTA button with VML fallback for Outlook.
 *
 *   ${ctaButton(url, "View run →")}
 */
export function ctaButton(href: string, label: string): string {
  return `
<div style="margin:24px 0 4px;">
  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
    href="${href}" style="height:46px;v-text-anchor:middle;width:220px;"
    arcsize="22%" fillcolor="#2B5BD7" stroke="f">
    <w:anchorlock/>
    <center style="color:#ffffff;font-family:${FONT};font-size:15px;font-weight:600;">${label}</center>
  </v:roundrect><![endif]-->
  <!--[if !mso]><!-->
  <a class="em-cta"
     href="${href}"
     style="display:inline-block;background:#2B5BD7;color:#ffffff;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;letter-spacing:-0.01em;text-decoration:none;padding:13px 26px;border-radius:10px;-webkit-text-size-adjust:none;">
    ${label}
  </a>
  <!--<![endif]-->
</div>`.trim();
}

// ─── Email wrapper ────────────────────────────────────────────────────────────

/**
 * Wraps body HTML in the Baseline transactional email chrome:
 *   warm-porcelain background → cobalt logo → white card → footer.
 *
 * @param opts.previewText  Inbox snippet (hidden before body, ~90 chars max).
 * @param opts.body         Card content — use EMAIL.h2/p/strong + ctaButton().
 * @param opts.logoUrl      Hosted 2× logo PNG URL. Falls back to styled text mark.
 */
export function wrapEmail(opts: {
  previewText?: string;
  body: string;
  logoUrl?: string;
  /** BCP-47 tag for the document `lang`. Defaults to English. */
  lang?: string;
  /** Localized footer chrome. Default to the English copy so non-localized
   *  callers (e.g. the worker's report notifications) render unchanged. */
  footerText?: string;
  questionsLabel?: string;
}): string {
  const {
    previewText = "",
    body,
    logoUrl,
    lang = "en",
    footerText = "You're receiving this because your team has an active Baseline subscription.",
    questionsLabel = "Questions?",
  } = opts;

  const preview = previewText
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#F5F3EC;">${previewText}&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>`
    : "";

  // The Baseline bar-chart mark (public/logo-mark.svg), rebuilt from table
  // cells because Gmail strips <svg> and a hosted <img> would be blank with
  // images blocked. Geometry is the SVG's at ~0.36 scale: two ink bars and a
  // cobalt bar (solid — the SVG's ink stroke would swamp the fill at this
  // size), all sitting on the baseline rule. Each bar is its own nested
  // single-cell table so it can be bottom-aligned at its own height
  // (a background on a shared-row td would paint the full row height).
  const bar = (
    style: string,
    cls: string
  ): string =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="${cls}" style="${style};border-radius:1px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
  const gap = (w: number): string =>
    `<td style="width:${w}px;font-size:0;line-height:0;">&nbsp;</td>`;
  const logoMark = `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                <tr>
                  ${gap(4)}
                  <td style="vertical-align:bottom;">${bar("width:4px;height:7px;background:#0E0E10", "em-mark-bar")}</td>
                  ${gap(3)}
                  <td style="vertical-align:bottom;">${bar("width:4px;height:12px;background:#0E0E10", "em-mark-bar")}</td>
                  ${gap(3)}
                  <td style="vertical-align:bottom;">${bar("width:4px;height:18px;background:#2B5BD7", "em-mark-accent")}</td>
                  ${gap(4)}
                </tr>
                <tr>
                  <td colspan="7" class="em-mark-bar" style="height:2px;background:#0E0E10;border-radius:1px;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
            <td style="padding-left:9px;vertical-align:middle;">
              <span class="em-logo-name" style="font-family:${FONT};font-size:15px;font-weight:600;color:#0E0E10;letter-spacing:-0.025em;line-height:1;">Baseline</span>
            </td>
          </tr>
        </table>`;

  const logo = logoUrl
    ? `<img src="${logoUrl}" alt="Baseline" height="28" style="display:block;border:0;">`
    : logoMark;

  return `<!DOCTYPE html>
<html lang="${lang}"
      xmlns="http://www.w3.org/1999/xhtml"
      xmlns:v="urn:schemas-microsoft-com:vml"
      xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>Baseline</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings>
    <o:PixelsPerInch>96</o:PixelsPerInch>
  </o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style>
    * { box-sizing: border-box; }
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; height: auto; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; }
    a { color: #2B5BD7; }

    /* ── Dark mode (Apple Mail, iOS, Samsung; not Gmail web) ── */
    @media (prefers-color-scheme: dark) {
      body, .em-bg       { background-color: #0F1116 !important; }
      .em-card           { background-color: #181B24 !important;
                           border-color: #262B36 !important; }
      h2                 { color: #F5F1E4 !important; }
      p                  { color: #A1A1AA !important; }
      strong             { color: #F5F1E4 !important; }
      .em-logo-name      { color: #F5F1E4 !important; }
      .em-mark-bar       { background-color: #FAFAFA !important; }
      .em-mark-accent    { background-color: #5E86F2 !important; }
      .em-footer         { color: #71717A !important; }
      a.em-cta           { background-color: #5E86F2 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F5F3EC;" class="em-bg">
${preview}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       class="em-bg" style="background:#F5F3EC;">
  <tr><td align="center" style="padding:40px 20px 52px;">

    <table role="presentation" cellpadding="0" cellspacing="0" border="0"
           style="max-width:576px;width:100%;">

      <!-- Logo ─────────────────────────────────────────────────────── -->
      <tr>
        <td align="left" style="padding-bottom:20px;">
          ${logo}
        </td>
      </tr>

      <!-- Card ─────────────────────────────────────────────────────── -->
      <tr>
        <td class="em-card"
            style="background:#ffffff;border-radius:20px;border:1px solid #E6E2D7;padding:36px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td>${body}</td></tr>
          </table>
        </td>
      </tr>

      <!-- Footer ───────────────────────────────────────────────────── -->
      <tr>
        <td class="em-footer" align="center"
            style="padding-top:24px;font-family:${FONT};font-size:12px;line-height:1.55;color:#71717A;">
          ${footerText}<br>
          ${questionsLabel}&nbsp;<a href="mailto:support@baselinelab.ai"
                             style="color:#2B5BD7;text-decoration:none;">support@baselinelab.ai</a>
        </td>
      </tr>

    </table>

  </td></tr>
</table>
</body>
</html>`;
}
