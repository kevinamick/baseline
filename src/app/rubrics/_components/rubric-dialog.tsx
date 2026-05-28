"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  createRubric,
  deleteRubric,
  getRubric,
  updateRubric,
  type RubricActionState,
} from "@/app/actions/rubrics";
import { Dialog } from "@/app/_components/dialog";
import type { Criterion } from "@/types/rubric";

type Props =
  | { mode: "create"; onClose: () => void }
  | { mode: "edit"; rubricId: string; onClose: () => void };

const initialState: RubricActionState = {};

export function RubricDialog(props: Props) {
  const isEdit = props.mode === "edit";
  const rubricId = isEdit ? props.rubricId : undefined;

  const [state, formAction, isPending] = useActionState(
    isEdit ? updateRubric : createRubric,
    initialState
  );
  const [criteria, setCriteria] = useState<Criterion[]>([
    { name: "", weight: 1, steps: [""] },
  ]);
  const [loading, setLoading] = useState(isEdit);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [defaults, setDefaults] = useState<{
    name: string;
    evaluation_mode: string;
    scenario_description: string;
    expected_outcome: string;
    grounding_context: string;
  } | null>(null);

  const criteriaInputRef = useRef<HTMLInputElement>(null);

  const onClose = props.onClose;
  useEffect(() => {
    if (state.success) onClose();
  }, [state.success, onClose]);

  useEffect(() => {
    if (!isEdit || !rubricId) return;
    getRubric(rubricId).then((rubric) => {
      if (rubric) {
        setDefaults({
          name: rubric.name,
          evaluation_mode: rubric.evaluation_mode,
          scenario_description: rubric.scenario_description,
          expected_outcome: rubric.expected_outcome,
          grounding_context: rubric.grounding_context ?? "",
        });
        setCriteria(rubric.criteria as Criterion[]);
      }
      setLoading(false);
    });
  }, [isEdit, rubricId]);

  const totalWeight = criteria.reduce(
    (sum, c) => sum + (Number(c.weight) || 0),
    0
  );
  const weightOk = Math.abs(totalWeight - 1.0) < 0.001;

  function handleSubmit() {
    if (criteriaInputRef.current) {
      criteriaInputRef.current.value = JSON.stringify(criteria);
    }
  }

  function updateCriterion(index: number, patch: Partial<Criterion>) {
    setCriteria((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c))
    );
  }

  function addCriterion() {
    setCriteria((prev) => [...prev, { name: "", weight: 0, steps: [""] }]);
  }

  function removeCriterion(index: number) {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  }

  function addStep(ci: number) {
    setCriteria((prev) =>
      prev.map((c, i) => (i === ci ? { ...c, steps: [...c.steps, ""] } : c))
    );
  }

  function updateStep(ci: number, si: number, value: string) {
    setCriteria((prev) =>
      prev.map((c, i) =>
        i === ci
          ? { ...c, steps: c.steps.map((s, j) => (j === si ? value : s)) }
          : c
      )
    );
  }

  function removeStep(ci: number, si: number) {
    setCriteria((prev) =>
      prev.map((c, i) =>
        i === ci ? { ...c, steps: c.steps.filter((_, j) => j !== si) } : c
      )
    );
  }

  return (
    <Dialog
      onClose={props.onClose}
      ariaLabelledBy="rubric-dialog-title"
      className="max-w-2xl h-[90vh]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <h2 id="rubric-dialog-title" className="text-base font-semibold">
          {isEdit ? "Edit rubric" : "New rubric"}
        </h2>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close dialog"
          className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-lg leading-none transition-colors"
        >
          ×
        </button>
      </div>

      {/* Body */}
      {loading ? (
        <div className="overflow-y-auto flex-1 px-6 py-6 flex flex-col gap-6">
          <SkeletonField delay="0s" />
          <SkeletonField delay="0.08s" />
          <SkeletonField inputHeight="h-[72px]" delay="0.16s" />
          <SkeletonField inputHeight="h-[72px]" delay="0.24s" />
          <SkeletonField inputHeight="h-[48px]" delay="0.32s" />
          <div className="flex flex-col gap-3">
            <div className="h-4 w-16 rounded skeleton-shimmer" style={{ "--shimmer-delay": "0.40s" } as React.CSSProperties} />
            <div className="h-24 rounded-lg skeleton-shimmer" style={{ "--shimmer-delay": "0.44s" } as React.CSSProperties} />
          </div>
        </div>
      ) : (
        <div className="overflow-y-auto flex-1 px-6 py-6 form-reveal">
          <form
            action={formAction}
            onSubmit={handleSubmit}
            id="rubric-form"
            className="flex flex-col gap-6"
          >
            {isEdit && (
              <input type="hidden" name="id" value={props.rubricId} />
            )}
            <input ref={criteriaInputRef} type="hidden" name="criteria" />

            {state.message && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {state.message}
              </p>
            )}

            <Field label="Name" error={state.errors?.name}>
              <input
                name="name"
                type="text"
                required
                defaultValue={defaults?.name ?? ""}
                placeholder="e.g. Customer support quality"
                className={inputCls}
              />
            </Field>

            <Field
              label="Evaluation mode"
              error={state.errors?.evaluation_mode}
            >
              <select
                name="evaluation_mode"
                required
                defaultValue={defaults?.evaluation_mode ?? "prompt_response"}
                className={inputCls}
              >
                <option value="prompt_response">Prompt / Response</option>
                <option value="conversational">Conversational</option>
              </select>
            </Field>

            <Field
              label="Scenario description"
              error={state.errors?.scenario_description}
            >
              <textarea
                name="scenario_description"
                required
                rows={3}
                defaultValue={defaults?.scenario_description ?? ""}
                placeholder="Describe the scenario being evaluated…"
                className={inputCls}
              />
            </Field>

            <Field
              label="Expected outcome"
              error={state.errors?.expected_outcome}
            >
              <textarea
                name="expected_outcome"
                required
                rows={3}
                defaultValue={defaults?.expected_outcome ?? ""}
                placeholder="What does a good response look like?"
                className={inputCls}
              />
            </Field>

            <Field
              label="Grounding context (optional)"
              error={state.errors?.grounding_context}
            >
              <textarea
                name="grounding_context"
                rows={2}
                defaultValue={defaults?.grounding_context ?? ""}
                placeholder="Reference material for the LLM evaluator…"
                className={inputCls}
              />
            </Field>

            {/* Criteria */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">Criteria</span>
                  <span
                    className={`text-xs ${weightOk ? "text-emerald-600" : "text-amber-600"}`}
                  >
                    {totalWeight.toFixed(2)} / 1.00{" "}
                    {weightOk ? "✓" : "(must equal 1.00)"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={addCriterion}
                  className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  + Add criterion
                </button>
              </div>

              {state.errors?.criteria && (
                <p className="text-xs text-red-600 mb-3">
                  {state.errors.criteria[0]}
                </p>
              )}

              <div className="flex flex-col gap-3">
                {criteria.map((criterion, ci) => (
                  <div
                    key={ci}
                    className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 flex flex-col gap-3 bg-zinc-50 dark:bg-zinc-800/50"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <label className="text-xs text-zinc-500 mb-1 block">
                          Name
                        </label>
                        <input
                          type="text"
                          value={criterion.name}
                          onChange={(e) =>
                            updateCriterion(ci, { name: e.target.value })
                          }
                          placeholder="e.g. Accuracy"
                          className={inputCls}
                        />
                      </div>
                      <div className="w-24 shrink-0">
                        <label className="text-xs text-zinc-500 mb-1 block">
                          Weight
                        </label>
                        <input
                          type="number"
                          min="0"
                          max="1"
                          step="0.01"
                          value={criterion.weight}
                          onChange={(e) =>
                            updateCriterion(ci, {
                              weight: parseFloat(e.target.value) || 0,
                            })
                          }
                          className={inputCls}
                        />
                      </div>
                      {criteria.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeCriterion(ci)}
                          className="mt-5 text-xs text-red-500 hover:text-red-700 transition-colors shrink-0"
                        >
                          Remove
                        </button>
                      )}
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs text-zinc-500">
                          Evaluation steps
                        </label>
                        <button
                          type="button"
                          onClick={() => addStep(ci)}
                          className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
                        >
                          + Add step
                        </button>
                      </div>
                      <div className="flex flex-col gap-2">
                        {criterion.steps.map((step, si) => (
                          <div key={si} className="flex items-center gap-2">
                            <span className="text-xs text-zinc-400 w-4 shrink-0 text-right">
                              {si + 1}.
                            </span>
                            <input
                              type="text"
                              value={step}
                              onChange={(e) =>
                                updateStep(ci, si, e.target.value)
                              }
                              placeholder="Instruction for the LLM evaluator…"
                              className={`${inputCls} flex-1`}
                            />
                            {criterion.steps.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeStep(ci, si)}
                                aria-label={`Remove step ${si + 1}`}
                                className="text-zinc-400 hover:text-red-500 transition-colors text-base leading-none shrink-0"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
        {/* Delete — edit mode only */}
        {isEdit ? (
          <button
            type="button"
            disabled={isDeleting}
            onClick={() => {
              if (confirmingDelete) {
                startDelete(async () => {
                  await deleteRubric(props.rubricId);
                });
              } else {
                setConfirmingDelete(true);
              }
            }}
            className={
              confirmingDelete
                ? "px-4 py-2 text-sm font-medium rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                : "px-4 py-2 text-sm text-red-500 hover:text-red-700 transition-colors"
            }
          >
            {isDeleting
              ? "Deleting…"
              : confirmingDelete
                ? "Delete forever?"
                : "Delete"}
          </button>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(false);
              props.onClose();
            }}
            className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="rubric-form"
            disabled={isPending || loading}
            className="px-5 py-2 text-sm font-medium rounded-full bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 transition-colors disabled:opacity-50"
          >
            {isPending ? "Saving…" : isEdit ? "Save changes" : "Create rubric"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 transition-shadow";

function SkeletonField({
  inputHeight = "h-9",
  delay = "0s",
}: {
  inputHeight?: string;
  delay?: string;
}) {
  const style = { "--shimmer-delay": delay } as React.CSSProperties;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-4 w-24 rounded skeleton-shimmer" style={style} />
      <div className={`${inputHeight} rounded-lg skeleton-shimmer`} style={style} />
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error[0]}</p>
      )}
    </div>
  );
}
