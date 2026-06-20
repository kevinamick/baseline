#!/usr/bin/env node
// Catalog scaffolder (ADR-0011, issue #242). Brings one or more target locale
// catalogs into structural sync with the source (`en.json`): every key present
// in en is created in the target, ordered and nested exactly like en. Existing
// translations are preserved verbatim; only *missing* keys are filled — with the
// English value as a draft placeholder — and keys no longer in en are dropped.
//
// This is the bootstrap step for adding a locale (e.g. `npm run i18n:fill -- fr`
// creates messages/fr.json mirroring en, ready to translate). It is NOT machine
// translation: the drafts are English and must be translated. `i18n:check` stays
// the source of truth for completeness; run it after translating.
//
// Usage:
//   node scripts/i18n-fill.mjs            # sync every existing non-source catalog
//   node scripts/i18n-fill.mjs fr         # create/sync messages/fr.json
//   node scripts/i18n-fill.mjs fr de      # several at once
import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const messagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "messages");
const SOURCE = "en";

// Rebuild `target` to mirror `source`'s shape and key order: reuse the target's
// existing value where it has a non-empty one for that path, otherwise fall back
// to the source value (an English draft). Recurses into nested namespaces.
// Returns { merged, filled } where `filled` counts the keys taken from source.
function mergeFromSource(source, target) {
  const out = {};
  let filled = 0;
  for (const [key, srcVal] of Object.entries(source)) {
    const tgtVal = target?.[key];
    if (srcVal && typeof srcVal === "object" && !Array.isArray(srcVal)) {
      const child = mergeFromSource(
        srcVal,
        tgtVal && typeof tgtVal === "object" ? tgtVal : {}
      );
      out[key] = child.merged;
      filled += child.filled;
    } else if (typeof tgtVal === "string" && tgtVal.trim() !== "") {
      out[key] = tgtVal;
    } else {
      out[key] = srcVal;
      filled += 1;
    }
  }
  return { merged: out, filled };
}

async function loadCatalog(locale) {
  try {
    return JSON.parse(await readFile(join(messagesDir, `${locale}.json`), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

const source = await loadCatalog(SOURCE);
if (!source) {
  console.error(`No source catalog messages/${SOURCE}.json`);
  process.exit(1);
}

let targets = process.argv.slice(2);
if (targets.length === 0) {
  const files = (await readdir(messagesDir)).filter((f) => f.endsWith(".json"));
  targets = files.map((f) => f.replace(/\.json$/, "")).filter((l) => l !== SOURCE);
}

for (const locale of targets) {
  if (locale === SOURCE) continue;
  const existing = await loadCatalog(locale);
  const { merged, filled } = mergeFromSource(source, existing ?? {});
  await writeFile(
    join(messagesDir, `${locale}.json`),
    JSON.stringify(merged, null, 2) + "\n",
    "utf8"
  );
  const verb = existing ? "synced" : "created";
  console.log(
    `${verb} messages/${locale}.json — ${filled} key(s) filled from ${SOURCE} (draft, translate these)`
  );
}
