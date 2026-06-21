#!/usr/bin/env node
// Catalog completeness check (ADR-0011). `en.json` is the source of truth; every
// other locale must define the same keys with non-empty values. Reports — and
// fails CI on — keys that are missing, empty, or orphaned in a non-source
// catalog. Missing keys still fall back to English at *runtime*; this gate keeps
// the gap visible rather than silent. Run `npm run i18n:fill` to MT-draft gaps.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "messages");
const SOURCE = "en";

function flatten(obj, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

async function loadCatalog(locale) {
  return JSON.parse(await readFile(join(messagesDir, `${locale}.json`), "utf8"));
}

const files = (await readdir(messagesDir)).filter((f) => f.endsWith(".json"));
const locales = files.map((f) => f.replace(/\.json$/, ""));
const source = flatten(await loadCatalog(SOURCE));
const sourceKeys = Object.keys(source);

let failed = false;
for (const locale of locales) {
  if (locale === SOURCE) continue;
  const target = flatten(await loadCatalog(locale));
  const missing = sourceKeys.filter((k) => !(k in target));
  const empty = sourceKeys.filter(
    (k) => k in target && String(target[k]).trim() === ""
  );
  const orphaned = Object.keys(target).filter((k) => !(k in source));

  if (missing.length || empty.length || orphaned.length) {
    failed = true;
    console.error(`\n✗ ${locale}.json`);
    for (const k of missing) console.error(`  missing:  ${k}`);
    for (const k of empty) console.error(`  empty:    ${k}`);
    for (const k of orphaned) console.error(`  orphaned: ${k}`);
  } else {
    console.log(`✓ ${locale}.json — ${sourceKeys.length} keys`);
  }
}

if (failed) {
  console.error("\ni18n:check failed — catalogs are out of sync with en.json.");
  process.exit(1);
}
console.log("\ni18n:check passed.");
