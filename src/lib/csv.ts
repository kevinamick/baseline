// Shared CSV machinery for the header-row parsers (the Eval Run parser in
// src/app/rubrics/_components/parse-csv.ts and the optimization instance parser in
// src/lib/optimization/parse-instances.ts). The parsers differ only in which columns
// they require — the splitting/normalizing/column-lookup primitives live here once.

// Split one CSV line on commas, respecting double-quoted fields (so a quoted value may
// contain commas). Every field is trimmed.
export function splitCsvLine(line: string): string[] {
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
}

// Normalize a header cell for column matching: strip wrapping quotes, lowercase, and
// snake_case the whitespace.
export function normalizeHeader(s: string): string {
  return s
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

// Find the index of the first header matching any of the accepted aliases (in alias
// priority order), or -1 when none is present.
export function pickColumn(headers: string[], names: string[]): number {
  return names.reduce((found, name) => (found >= 0 ? found : headers.indexOf(name)), -1);
}
