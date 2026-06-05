// Registry of dataset adapters, keyed by Connection.provider. Slice 2 ships custom +
// posthog; cloud providers (appinsights/cloudtrail/cloudlogging) plug in here later
// behind the same seam — see docs/adr/0004-dataset-connections-provider-adapters.md.

import type { DatasetAdapter } from "./types.js";
import { customDatasetAdapter } from "./custom.js";
import { posthogDatasetAdapter } from "./posthog.js";

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

export type { DatasetAdapter, DatasetConnection, DatasetRow, FetchContext } from "./types.js";
