/**
 * The model-intake ignore list (#484): model ids a human has already reviewed and dismissed
 * (old snapshots we'll never wire in, models we've decided not to support) — once dismissed, a
 * model never re-alerts in the weekly detection report.
 *
 * Data file: scripts/model-intake-ignore.json — a plain JSON array (JSON has no comments, hence
 * this doc-comment carrying the schema) of:
 *   [{ "provider": "anthropic" | "openai" | "google" | "mistral", "id": "claude-2.1",
 *      "reason": "optional free-text note" }]
 *
 * "provider" is included (not just "id") because a bare model id string is only unique within a
 * provider's namespace, not globally — scoping every ignore entry to its provider avoids an
 * accidental cross-provider match.
 */
import { readFileSync } from "node:fs";
import type { IntakeProvider } from "../../worker/src/providers/model-filter.ts";

export interface IgnoreEntry {
  provider: IntakeProvider;
  id: string;
  reason?: string;
}

/** Parse the ignore-list JSON text into validated entries. Throws on malformed input — a broken
 *  ignore list is a script-authoring bug, not a "degrade gracefully" case like the LiteLLM fetch. */
export function parseIgnoreList(raw: string): IgnoreEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("model-intake-ignore.json must be a JSON array");
  }
  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`model-intake-ignore.json entry ${i} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.provider !== "string" || typeof record.id !== "string") {
      throw new Error(
        `model-intake-ignore.json entry ${i} must have string "provider" and "id" fields`
      );
    }
    return {
      provider: record.provider as IntakeProvider,
      id: record.id,
      reason: typeof record.reason === "string" ? record.reason : undefined,
    };
  });
}

export function loadIgnoreList(path: string): IgnoreEntry[] {
  return parseIgnoreList(readFileSync(path, "utf8"));
}

export function isIgnored(
  entries: readonly IgnoreEntry[],
  provider: IntakeProvider,
  id: string
): boolean {
  return entries.some((e) => e.provider === provider && e.id === id);
}
