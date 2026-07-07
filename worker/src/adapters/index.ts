// Registry of dataset adapters, keyed by Connection.provider. Slice 2 ships custom +
// posthog; cloud providers (appinsights/cloudtrail/cloudlogging) plug in here later
// behind the same seam — see docs/adr/0004-dataset-connections-provider-adapters.md.

// NOTE: relative imports in this dataset-adapter subtree (index/custom/posthog + their
// safe-fetch/template/posthog-hosts/ip-ranges deps) are intentionally extensionless rather
// than the worker's usual `.js`. The Next app's "Test query" preview (#39) imports this seam
// across the package boundary and bundles it with Turbopack, which — unlike the worker's tsx
// runtime — does not resolve a `.js` specifier to its `.ts` source. Extensionless resolves the
// same under both, so the adapter stays a single shared definition with no behavior change.
import type { DatasetAdapter } from "./types";
import { customDatasetAdapter } from "./custom";
import { posthogDatasetAdapter } from "./posthog";

const adapters: Record<string, DatasetAdapter> = {
  custom: customDatasetAdapter,
  posthog: posthogDatasetAdapter,
};

export function getDatasetAdapter(provider: string): DatasetAdapter {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(`Unsupported dataset provider: ${provider}`);
  }
  return adapter;
}

export type { DatasetAdapter, DatasetConnection, DatasetRow, FetchContext } from "./types";
