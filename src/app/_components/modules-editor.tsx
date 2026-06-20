"use client";

import { useState } from "react";
import { Field } from "@/app/[locale]/rubrics/_components/field";
import { XIcon } from "@/app/_components/icons";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";

// The shared Modules editor (#119): repeatable { name, seed } rows + the request-body
// template + the live declared↔referenced cross-validation between them. Modules are a
// property of the Connection, so the same editor backs every surface where an agent
// Connection's Modules are created or edited — the optimization wizard's inline form,
// the schedules wizard's agent branch, and the connection edit dialog.

// One editable Module row (UI shape — both fields plain strings, cleaned at submit).
export interface ModuleRow {
  name: string;
  seed: string;
}

// Mirrors OptimizablePromptSchema's name charset.
export const MODULE_NAME_RE = /^[A-Za-z0-9_-]+$/;

// Live declared↔referenced cross-check: which declared Modules are missing a
// {{prompt:name}} reference in the template, and which references have no declared
// Module. Drives both the inline hint panel and the per-surface validation, so a
// mismatch can never reach the server.
export function crossValidateModules(
  modules: ModuleRow[],
  requestTemplate: string
): { missingRefs: string[]; undeclaredRefs: string[] } {
  const declared = modules.map((m) => m.name.trim()).filter(Boolean);
  const referenced = extractPromptRefs(requestTemplate);
  return {
    missingRefs: declared.filter((n) => !referenced.includes(n)),
    undeclaredRefs: referenced.filter((n) => !declared.includes(n)),
  };
}

// The Modules half of a surface's validation: row-level rules (names, seeds,
// uniqueness) plus the declared↔referenced cross-check. `requireModules` is true where
// Modules are mandatory (the optimization wizard — a run needs something to tune) and
// false where they're optional (a schedules agent connection may be {{user_input}}-only).
// Template JSON validity stays a per-surface concern — this works on the raw string.
export function modulesEditorError(
  modules: ModuleRow[],
  requestTemplate: string,
  { requireModules }: { requireModules: boolean }
): string | null {
  // A row with a seed but no name would be silently dropped at submit — flag it instead.
  if (modules.some((m) => !m.name.trim() && m.seed.trim())) {
    return "Give every Module a name (or clear the empty row).";
  }
  const named = modules.filter((m) => m.name.trim());
  if (named.length === 0 && requireModules) return "Declare at least one Module.";
  for (const m of named) {
    if (!MODULE_NAME_RE.test(m.name.trim())) {
      return `Module name "${m.name.trim()}" — use letters, digits, hyphens, or underscores.`;
    }
    if (!m.seed.trim()) return `Give Module "${m.name.trim()}" a seed prompt.`;
  }
  if (new Set(named.map((m) => m.name.trim())).size !== named.length) {
    return "Module names must be unique.";
  }
  const { missingRefs, undeclaredRefs } = crossValidateModules(modules, requestTemplate);
  if (missingRefs.length > 0) {
    return `Declared Module "${missingRefs[0]}" must be referenced as {{prompt:${missingRefs[0]}}} in the request template.`;
  }
  if (undeclaredRefs.length > 0) {
    return `Request template references {{prompt:${undeclaredRefs[0]}}} but no Module "${undeclaredRefs[0]}" is declared.`;
  }
  return null;
}

// Editor rows → the optimizablePrompts payload shape (named rows only, trimmed).
export function cleanModules(modules: ModuleRow[]): { name: string; seed: string }[] {
  return modules
    .filter((m) => m.name.trim())
    .map((m) => ({ name: m.name.trim(), seed: m.seed.trim() }));
}

// Inject "<name>": "{{prompt:<name>}}" into a JSON-object request template so a newly added
// Module is referenced out of the box (keeps declared↔referenced in sync). A hand-edited or
// non-object template is left untouched — the live cross-validation hint then guides the user.
export function withModuleRef(template: string, name: string): string {
  try {
    const obj = JSON.parse(template);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      (obj as Record<string, unknown>)[name] = `{{prompt:${name}}}`;
      return JSON.stringify(obj, null, 2);
    }
  } catch {
    /* leave a hand-edited template as-is */
  }
  return template;
}

// A fresh, unused Module name for the "+ Add Module" action — so the auto-injected placeholder
// is unique and immediately valid.
export function nextModuleName(existing: ModuleRow[]): string {
  const used = new Set(existing.map((m) => m.name.trim()).filter(Boolean));
  for (const candidate of ["system", "style", "tone", "format", "persona", "context"]) {
    if (!used.has(candidate)) return candidate;
  }
  let i = existing.length + 1;
  while (used.has(`module${i}`)) i++;
  return `module${i}`;
}

interface ModulesEditorProps {
  modules: ModuleRow[];
  onModulesChange: React.Dispatch<React.SetStateAction<ModuleRow[]>>;
  requestTemplate: string;
  onRequestTemplateChange: (v: string) => void;
  // Unique per surface so label htmlFor ids never collide across dialogs.
  idPrefix: string;
  // Optional Modules (schedules / edit surface): the list may be emptied, and an empty
  // state explains what declaring a Module unlocks. Required (optimization wizard): the
  // last row can't be removed.
  optional?: boolean;
  templateLabel?: string;
}

export function ModulesEditor({
  modules,
  onModulesChange,
  requestTemplate,
  onRequestTemplateChange,
  idPrefix,
  optional = false,
  templateLabel = "Request body template (JSON)",
}: ModulesEditorProps) {
  const { missingRefs, undeclaredRefs } = crossValidateModules(modules, requestTemplate);

  // Stable row keys: with key={index}, removing a middle row re-associates the remaining
  // DOM (and focus) with the wrong row. Keys are parallel state kept in lockstep by this
  // component's own add/remove handlers; a length mismatch means the parent replaced the
  // list wholesale (e.g. a wizard type switch), so regenerate via React's render-phase
  // adjust-state pattern.
  const [rowKeys, setRowKeys] = useState<number[]>(() => modules.map((_, i) => i));
  const [nextRowKey, setNextRowKey] = useState(modules.length);
  let keys = rowKeys;
  if (rowKeys.length !== modules.length) {
    keys = modules.map((_, i) => nextRowKey + i);
    setRowKeys(keys);
    setNextRowKey(nextRowKey + modules.length);
  }

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-ink">
            Modules
            {optional && <span className="ml-1.5 text-xs font-normal text-fg-3">· optional</span>}
          </span>
          <button
            type="button"
            onClick={() => {
              // Add the Module AND reference it in the request template, so it's valid out of
              // the box instead of immediately tripping the declared↔referenced check.
              const name = nextModuleName(modules);
              setRowKeys((prev) => [...prev, nextRowKey]);
              setNextRowKey((k) => k + 1);
              onModulesChange((prev) => [...prev, { name, seed: "" }]);
              onRequestTemplateChange(withModuleRef(requestTemplate, name));
            }}
            className="rounded-full border border-hairline-cool bg-card px-3 py-1 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
          >
            + Add Module
          </button>
        </div>
        {modules.length === 0 && optional && (
          <p className="text-xs text-fg-3">
            No Modules declared. A Module is a named prompt (referenced as{" "}
            <code className="font-mono">{"{{prompt:<name>}}"}</code> in the request template)
            that an optimization run can tune — without one this agent can&apos;t be optimized.
          </p>
        )}
        {modules.map((mod, i) => (
          <div
            key={keys[i]}
            className="flex flex-col gap-2 rounded-lg border border-hairline bg-card-warm p-3"
          >
            <div className="flex items-center justify-between">
              {/* fg-2, not fg-3: at 12px the uppercase label on bg-card-warm must clear the
                  4.5:1 AA contrast floor (fg-3 lands at 4.38:1). */}
              <span className="text-xs font-semibold uppercase tracking-wide text-fg-2">
                Module {i + 1}
              </span>
              <button
                type="button"
                disabled={!optional && modules.length === 1}
                onClick={() => {
                  setRowKeys((prev) => prev.filter((_, j) => j !== i));
                  onModulesChange((prev) => prev.filter((_, j) => j !== i));
                }}
                aria-label={`Remove Module ${i + 1}`}
                className="flex h-8 w-8 items-center justify-center rounded-full text-fg-4 transition-colors hover:bg-paper-warm hover:text-danger disabled:pointer-events-none disabled:opacity-0"
              >
                <XIcon size={14} />
              </button>
            </div>
            {/* Visible labels (a11y sweep standard) — the aria-labels stay, keeping each
                row's accessible name unique across rows. */}
            <Field label="Name" htmlFor={`${idPrefix}-mod-${i}-name`}>
              <input
                id={`${idPrefix}-mod-${i}-name`}
                aria-label={`Module ${i + 1} name`}
                type="text"
                value={mod.name}
                onChange={(e) =>
                  onModulesChange((prev) =>
                    prev.map((m, j) => (j === i ? { ...m, name: e.target.value } : m))
                  )
                }
                placeholder="module name (e.g. system)"
                className={`${inputCls} font-mono text-xs`}
              />
            </Field>
            <Field label="Seed prompt" htmlFor={`${idPrefix}-mod-${i}-seed`}>
              <textarea
                id={`${idPrefix}-mod-${i}-seed`}
                aria-label={`Module ${i + 1} seed prompt`}
                rows={2}
                value={mod.seed}
                onChange={(e) =>
                  onModulesChange((prev) =>
                    prev.map((m, j) => (j === i ? { ...m, seed: e.target.value } : m))
                  )
                }
                placeholder="The starting instruction text for this Module"
                className={`${inputCls} resize-none`}
              />
            </Field>
          </div>
        ))}
      </div>

      <Field label={templateLabel} htmlFor={`${idPrefix}-template`}>
        <textarea
          id={`${idPrefix}-template`}
          rows={5}
          value={requestTemplate}
          onChange={(e) => onRequestTemplateChange(e.target.value)}
          className={`${inputCls} resize-none font-mono text-xs`}
        />
      </Field>

      {/* role="status": the warning appears/changes live as the user types, so announce it
          politely to assistive tech (a11y-sweep standard for live validation). */}
      {(missingRefs.length > 0 || undeclaredRefs.length > 0) && (
        <div
          role="status"
          className="rounded-lg border border-warning bg-warning-bg px-3 py-2 text-xs text-warning-fg"
        >
          {missingRefs.map((n) => (
            <p key={`m-${n}`}>
              Module <code className="font-mono">{n}</code> isn&apos;t referenced — add{" "}
              <code className="font-mono">{`{{prompt:${n}}}`}</code> to the template.
            </p>
          ))}
          {undeclaredRefs.map((n) => (
            <p key={`u-${n}`}>
              Template references <code className="font-mono">{`{{prompt:${n}}}`}</code> but no
              Module <code className="font-mono">{n}</code> is declared.
            </p>
          ))}
        </div>
      )}
    </>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50";
