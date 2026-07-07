import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Temporal payload codec is duplicated across two separate npm packages (the Next app
// and the worker) because they have no shared workspace to import from — see the header of
// codec.ts. Until that duplication is removed (tracked as tech debt), this guard fails CI
// the moment the two copies drift, since they MUST encrypt/decrypt identically.
//
// We compare from the first `import` line onward so the file-specific header comment (which
// points at the respective twin) is excluded from the comparison.

function codecBody(relPath: string): string {
  const text = readFileSync(join(process.cwd(), relPath), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("import "));
  expect(start, `no import found in ${relPath}`).toBeGreaterThanOrEqual(0);
  return lines.slice(start).join("\n");
}

describe("Temporal codec copies stay in sync", () => {
  it("src/lib/temporal/codec.ts is identical to worker/src/temporal/codec.ts below the header", () => {
    const app = codecBody("src/lib/temporal/codec.ts");
    const worker = codecBody("worker/src/temporal/codec.ts");
    expect(app).toBe(worker);
  });
});
