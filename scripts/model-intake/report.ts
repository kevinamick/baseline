/**
 * Builds the human-readable model-intake report (#484) — printed to stdout and written to a
 * markdown file, which the workflow posts verbatim as the tracking issue body. One function
 * builds both: the report has no format that differs between the two destinations.
 */
import type { LlmProvider } from "../../worker/src/providers/registry.ts";
import type { ModelDiff, ProviderLiveResult } from "./diff.ts";
import type { LiteLlmData } from "./litellm-prices.ts";
import { suggestPriceFromLiteLlm } from "./litellm-prices.ts";
import { buildRegistrySnippet } from "./snippet.ts";

/** Stable title marker the workflow greps for to find (and update, never duplicate) the
 *  tracking issue. Keep this string identical everywhere it's referenced. */
export const TRACKING_ISSUE_TITLE = "Model intake: new provider models detected";

export interface BuildReportInput {
  diff: ModelDiff;
  results: readonly ProviderLiveResult[];
  litellmData: LiteLlmData | null;
  generatedAt: Date;
}

export function buildMarkdownReport(input: BuildReportInput): string {
  const { diff, results, litellmData, generatedAt } = input;
  const lines: string[] = [];

  lines.push(`## ${TRACKING_ISSUE_TITLE}`);
  lines.push("");
  lines.push(`_Generated ${generatedAt.toISOString()} by \`npm run detect-new-models\`._`);
  lines.push("");

  const anyNew = Object.values(diff.added).some((ids) => ids.length > 0);
  if (!anyNew) {
    lines.push("No new chat-capable models detected since the last run.");
    lines.push("");
  }

  for (const result of results) {
    const provider: LlmProvider = result.provider;
    lines.push(`### ${provider}`);
    lines.push("");

    if (result.liveIds === null) {
      lines.push(`_Skipped — no API key configured (${result.warning ?? "missing key"})._`);
      lines.push("");
      continue;
    }

    const added = diff.added[provider] ?? [];
    const ignoredNew = diff.ignoredNew[provider] ?? [];
    const disappeared = diff.disappeared[provider] ?? [];

    if (added.length === 0) {
      lines.push("No new models.");
      lines.push("");
    } else {
      for (const id of added) {
        const price = litellmData ? suggestPriceFromLiteLlm(provider, id, litellmData) : null;
        lines.push(`#### \`${id}\` (new)`);
        lines.push("");
        lines.push(buildRegistrySnippet(provider, id, price));
        lines.push("");
        lines.push("- [ ] verify price against the provider's pricing page");
        lines.push(
          "- [ ] decide whether judge/reflect defaults should change (default: no change)"
        );
        lines.push(
          "- [ ] or add to the ignore list (`scripts/model-intake-ignore.json`) and close"
        );
        lines.push("");
      }
    }

    if (ignoredNew.length > 0) {
      lines.push(
        `Ignored (already dismissed, see \`scripts/model-intake-ignore.json\`): ${ignoredNew
          .map((id) => `\`${id}\``)
          .join(", ")}`
      );
      lines.push("");
    }

    if (disappeared.length > 0) {
      lines.push(
        `**Possible deprecation** — in the registry but missing from ${provider}'s live list ` +
          `(report-only, no action taken): ${disappeared.map((id) => `\`${id}\``).join(", ")}`
      );
      lines.push("");
    }
  }

  if (!litellmData) {
    lines.push(
      "_Note: the LiteLLM price dataset could not be fetched this run — every suggested price " +
        "above is a TODO rather than a LiteLLM-sourced suggestion. This is not a script failure._"
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
