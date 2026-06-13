import { escapeHtml } from "./escape";
import { EMAIL, ctaButton, wrapEmail } from "./layout";

/**
 * BYO key required (#184): a Free Team tried to run with no provider key on
 * file. Free Teams run on their own LLM provider key — there's no managed
 * fallback — so the run is blocked until a Contributor adds one. Emailed to the
 * Team's Contributors, throttled once per period. The team name is
 * admin-supplied, so every interpolation is escaped.
 */
export function providerKeyRequiredEmailHtml(opts: {
  teamName: string;
  apiKeysUrl: string;
}): string {
  const team = escapeHtml(opts.teamName);
  const url = escapeHtml(opts.apiKeysUrl);

  const body = `
    <h2 style="${EMAIL.h2}">${team} needs a provider key to run</h2>
    <p style="${EMAIL.p}">A run was just blocked: your team is on the Free plan, which runs on <strong style="${EMAIL.strong}">your own LLM provider key</strong>. There's no key on file yet, so judging can't start.</p>
    <p style="${EMAIL.p}">Add an Anthropic API key on the API Keys page and runs start immediately. The key is stored encrypted and never shown again.</p>
    ${ctaButton(url, "Add a provider key →")}
  `;

  return wrapEmail({
    previewText: `A run was blocked — ${team} has no LLM provider key on file.`,
    body,
  });
}
