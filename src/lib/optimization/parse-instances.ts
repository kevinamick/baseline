import type { InstanceRow } from "@/types/instances";
import { splitCsvLine, normalizeHeader, pickColumn } from "@/lib/csv";

// Parsers for the start wizard's instance ingester. Unlike an Eval Run's rows, an optimization
// instance has NO agent_output — the agent is invoked live during the run — so the only required
// column is user_input; expected_output and retrieval_context are optional.

// Parse a CSV with a header row. Returns rows that have a non-empty user_input; returns []
// when there's no user_input column or no data rows (the caller surfaces "add an instance").
export function parseInstancesCsv(text: string): InstanceRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Split the header with the same quote-aware splitter as the data rows, so a quoted header
  // field containing a comma can't shift the column indices out of alignment with the data.
  const headers = splitCsvLine(lines[0]).map(normalizeHeader);

  const uiCol = pickColumn(headers, ["user_input", "userinput", "user", "input"]);
  const eoCol = pickColumn(headers, ["expected_output", "expectedoutput", "expected"]);
  const rcCol = pickColumn(headers, ["retrieval_context", "retrievalcontext", "context"]);

  if (uiCol < 0) return [];

  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const cols = splitCsvLine(line);
      return {
        userInput: cols[uiCol] ?? "",
        expectedOutput: eoCol >= 0 ? (cols[eoCol] ?? "") : "",
        retrievalContext: rcCol >= 0 ? (cols[rcCol] ?? "") : "",
      };
    })
    .filter((r) => r.userInput.trim());
}

// Read a string field from a parsed JSON row under any of the accepted key aliases, trimmed so
// the JSON path matches the CSV path (whose splitter trims every field).
function field(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// Parse a JSON array of instance objects. Throws on invalid JSON or a non-array root (the caller
// turns that into a "must be a valid JSON array" message). Keys accept snake_case or camelCase;
// rows without a user_input are dropped.
export function parseInstancesJson(text: string): InstanceRow[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("Expected a JSON array of instances.");
  return data
    .map((row) => {
      const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
      return {
        userInput: field(r, "user_input", "userInput", "input"),
        expectedOutput: field(r, "expected_output", "expectedOutput", "expected"),
        retrievalContext: field(r, "retrieval_context", "retrievalContext", "context"),
      };
    })
    .filter((r) => r.userInput.trim());
}
