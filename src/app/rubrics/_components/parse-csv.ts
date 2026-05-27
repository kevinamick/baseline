import type { EvalRunRow } from "@/types/eval-run";

export function parseCsv(text: string): EvalRunRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const normalize = (s: string) =>
    s.trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/\s+/g, "_");

  const headers = lines[0].split(",").map(normalize);

  const colIndex = (names: string[]): number =>
    names.reduce((found, name) => (found >= 0 ? found : headers.indexOf(name)), -1);

  const uiCol = colIndex(["user_input", "userinput", "user"]);
  const aoCol = colIndex(["agent_output", "agentoutput", "agent", "output"]);
  const eoCol = colIndex(["expected_output", "expectedoutput", "expected"]);
  const rcCol = colIndex(["retrieval_context", "retrievalcontext", "context"]);

  if (uiCol < 0 || aoCol < 0) return [];

  const splitLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const cols = splitLine(line);
      return {
        userInput: cols[uiCol] ?? "",
        agentOutput: cols[aoCol] ?? "",
        expectedOutput: eoCol >= 0 ? cols[eoCol] || undefined : undefined,
        retrievalContext: rcCol >= 0 ? cols[rcCol] || undefined : undefined,
      };
    })
    .filter((r) => r.userInput && r.agentOutput);
}
