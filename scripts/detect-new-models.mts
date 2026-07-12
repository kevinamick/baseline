/**
 * Scheduled detection of new provider models against the shared registry (#379, #484).
 * ─────────────────────────────────────────────────────────────────────────────
 * The registry (`worker/src/providers/registry.ts`) is the single source for supported models
 * and managed prices, and adding a model is deliberately a one-file human edit. No provider
 * exposes list prices via API, and ADR-0008 fails closed on any unpriced managed call — a wrong
 * auto-ingested price would become billed history (managed_spend_ledger snapshots the unit price
 * at call time). So pricing stays human-approved; this script automates only DETECTION: for every
 * `RUNTIME_READY_PROVIDERS` member, it calls that provider's list-models endpoint, filters to
 * chat-capable models (`worker/src/providers/model-filter.ts`), diffs the result against the
 * registry's `MODEL_PROVIDER` map, and writes a report with paste-ready registry snippets — never
 * an auto-PR, never a written price.
 *
 * Usage: `npm run detect-new-models`
 *
 * Provider keys come from the SAME env var names as the registry's `MANAGED_KEY_ENV`
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY) — same
 * "talk to whatever environment's keys it's given" posture as scripts/access-codes.mts. A
 * provider with no key configured is skipped with a warning, never a hard failure: partial
 * coverage beats a red cron.
 *
 * Output: a human-readable report to stdout, and the same report written to
 * `model-intake-report.md` at the repo root (the `.github/workflows/model-intake.yml` workflow
 * posts that file verbatim as the tracking-issue body).
 *
 * Exit codes (the acceptance criteria's "exits distinguishably when something new was found"):
 *   0 — ran successfully, no new (non-ignored) models found
 *   2 — ran successfully, new models found — see the report
 *   1 — the script itself failed (e.g. a malformed ignore-list file, an unexpected error)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  RUNTIME_READY_PROVIDERS,
  MANAGED_KEY_ENV,
  MODEL_PROVIDER,
  type LlmProvider,
} from "../worker/src/providers/registry.ts";
import { extractChatCapableModelIds } from "../worker/src/providers/model-filter.ts";
import { loadIgnoreList } from "./model-intake/ignore-list.ts";
import { computeModelDiff, hasNewModels, type ProviderLiveResult } from "./model-intake/diff.ts";
import { fetchLiteLlmData } from "./model-intake/litellm-prices.ts";
import { buildMarkdownReport } from "./model-intake/report.ts";

const here = dirname(fileURLToPath(import.meta.url));
const IGNORE_LIST_PATH = join(here, "model-intake-ignore.json");
const REPORT_PATH = join(here, "..", "model-intake-report.md");

const ANTHROPIC_VERSION = "2023-06-01"; // matches the pinned SDK version in worker/src/providers/anthropic.ts

/**
 * Build the fetch Request for a provider's list-models endpoint — auth scheme + host per
 * provider, exactly as documented in #484's plan. Never logs the key.
 *
 * Anthropic/Google both cap+paginate their listings (`limit`/`pageSize` + a cursor); this
 * requests the maximum single-page size from each rather than implementing cursor pagination —
 * both catalogs are well under that ceiling today, and a provider crossing it would first show up
 * as a stale/incomplete "disappeared" report (report-only, human-visible) rather than a silent
 * gap, which is an acceptable trade-off against the complexity of a second network round-trip
 * loop for a case that doesn't exist yet.
 */
function buildListModelsRequest(provider: LlmProvider, apiKey: string): { url: string; init: RequestInit } {
  switch (provider) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1000",
        init: {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
        },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/models",
        init: { headers: { Authorization: `Bearer ${apiKey}` } },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
        init: {},
      };
    case "mistral":
      return {
        url: "https://api.mistral.ai/v1/models",
        init: { headers: { Authorization: `Bearer ${apiKey}` } },
      };
  }
}

/** Fetch + filter one provider's live chat-capable model ids. Never throws — any failure (missing
 *  key, HTTP error, network error) resolves to a skipped/warned result so one provider's outage
 *  can't fail the whole run. */
async function fetchProviderModels(provider: LlmProvider): Promise<ProviderLiveResult> {
  const envVar = MANAGED_KEY_ENV[provider];
  const apiKey = process.env[envVar];
  if (!apiKey) {
    console.warn(`[${provider}] skipped — ${envVar} is not set`);
    return { provider, liveIds: null, warning: `${envVar} not set` };
  }

  const { url, init } = buildListModelsRequest(provider, apiKey);
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const warning = `list-models request failed: HTTP ${res.status}`;
      console.warn(`[${provider}] ${warning}`);
      return { provider, liveIds: null, warning };
    }
    const payload: unknown = await res.json();
    const liveIds = extractChatCapableModelIds(provider, payload);
    return { provider, liveIds };
  } catch (err) {
    const warning = `list-models request errored: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[${provider}] ${warning}`);
    return { provider, liveIds: null, warning };
  }
}

async function main(): Promise<number> {
  const ignoreEntries = loadIgnoreList(IGNORE_LIST_PATH);

  const results = await Promise.all(
    RUNTIME_READY_PROVIDERS.map((provider) => fetchProviderModels(provider))
  );

  const diff = computeModelDiff(results, MODEL_PROVIDER, ignoreEntries);
  const litellmData = await fetchLiteLlmData();

  const report = buildMarkdownReport({
    diff,
    results,
    litellmData,
    generatedAt: new Date(),
  });

  console.log(report);
  writeFileSync(REPORT_PATH, report, "utf8");
  console.log(`\nReport written to ${REPORT_PATH}`);

  return hasNewModels(diff) ? 2 : 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`detect-new-models failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
}
