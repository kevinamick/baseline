import type { EvalRunRow } from "@/types/eval-run";
import { splitCsvLine, normalizeHeader, pickColumn } from "@/lib/csv";

export function parseCsv(text: string): EvalRunRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Split the header with the same quote-aware splitter as the data rows, so a quoted header
  // field containing a comma can't shift the column indices out of alignment with the data.
  const headers = splitCsvLine(lines[0]).map(normalizeHeader);

  const uiCol = pickColumn(headers, ["user_input", "userinput", "user"]);
  const aoCol = pickColumn(headers, ["agent_output", "agentoutput", "agent", "output"]);
  const eoCol = pickColumn(headers, ["expected_output", "expectedoutput", "expected"]);
  const rcCol = pickColumn(headers, ["retrieval_context", "retrievalcontext", "context"]);

  if (uiCol < 0 || aoCol < 0) return [];

  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const cols = splitCsvLine(line);
      return {
        userInput: cols[uiCol] ?? "",
        agentOutput: cols[aoCol] ?? "",
        expectedOutput: eoCol >= 0 ? cols[eoCol] || undefined : undefined,
        retrievalContext: rcCol >= 0 ? cols[rcCol] || undefined : undefined,
      };
    })
    .filter((r) => r.userInput && r.agentOutput);
}
