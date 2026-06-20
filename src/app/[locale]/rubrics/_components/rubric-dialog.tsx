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
import { PlusIcon, TrashIcon, XIcon } from "@/app/_components/icons";
import { InfoTooltip } from "@/app/_components/info-tooltip";
import { Field } from "./field";
import { RubricSchema } from "@/lib/validation/schemas";
import { focusFirstError } from "@/lib/validation/focus-first-error";
import type { Criterion } from "@/types/rubric";
import { RUBRIC_TEMPLATES, type RubricTemplate } from "./rubric-templates";

type Props =
  | { mode: "create"; onClose: () => void }
  | { mode: "edit"; rubricId: string; onClose: () => void };

const initialState: RubricActionState = {};

export function RubricDialog(props: Props) {
  const isEdit = props.mode === "edit";
  const rubricId = isEdit ? props.rubricId : undefined;

  // In create mode, start on the template picker step; edit mode goes straight to form.
  const [step, setStep] = useState<"pick" | "form">(isEdit ? "form" : "pick");

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

  const [name, setName] = useState("");
  const [evaluationMode, setEvaluationMode] = useState("prompt_response");
  const [scenarioDescription, setScenarioDescription] = useState("");
  const [expectedOutcome, setExpectedOutcome] = useState("");
  const [groundingContext, setGroundingContext] = useState("");
  const [clientErrors, setClientErrors] = useState<Record<string, string[]>>({});

  function applyTemplate(template: RubricTemplate) {
    setName(template.name);
    setEvaluationMode(template.evaluation_mode);
    setScenarioDescription(template.scenario_description);
    setExpectedOutcome(template.expected_outcome);
    setCriteria(template.criteria);
    setClientErrors({});
    setStep("form");
  }

  const criteriaInputRef = useRef<HTMLInputElement>(null);

  // Errors come from two sources: client-side Zod (clientErrors) and the
  // server action backstop (state.errors). Client takes precedence.
  const fieldError = (key: string): string[] | undefined =>
    clientErrors[key] ?? state.errors?.[key];

  function clearClientError(key: string) {
    setClientErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // Criteria mutations clear the criteria error so it disappears as the user fixes it.
  function mutateCriteria(updater: (prev: Criterion[]) => Criterion[]) {
    setCriteria(updater);
    clearClientError("criteria");
  }

  const onClose = props.onClose;
  useEffect(() => {
    if (state.success) onClose();
  }, [state.success, onClose]);

  useEffect(() => {
    if (!isEdit || !rubricId) return;
    let cancelled = false;
    getRubric(rubricId)
      .then((rubric) => {
        if (cancelled) return;
        if (rubric) {
          setName(rubric.name);
          setEvaluationMode(rubric.evaluation_mode);
          setScenarioDescription(rubric.scenario_description);
          setExpectedOutcome(rubric.expected_outcome);
          setGroundingContext(rubric.grounding_context ?? "");
          // `criteria` is a Json column in the schema; the app stores Criterion[] in it.
          setCriteria(rubric.criteria as unknown as Criterion[]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isEdit, rubricId]);

  const totalWeight = criteria.reduce(
    (sum, c) => sum + (Number(c.weight) || 0),
    0
  );
  const weightOk = Math.abs(totalWeight - 1.0) < 0.001;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (criteriaInputRef.current) {
      criteriaInputRef.current.value = JSON.stringify(criteria);
    }

    const result = RubricSchema.safeParse({
      name,
      scenario_description: scenarioDescription,
      expected_outcome: expectedOutcome,
      evaluation_mode: evaluationMode,
      grounding_context: groundingContext || null,
      criteria,
    });

    if (!result.success) {
      e.preventDefault();
      const fieldErrors = result.error.flatten().fieldErrors as Record<string, string[]>;
      setClientErrors(fieldErrors);

      const idByKey: Record<string, string> = {
        name: "rubric-name",
        evaluation_mode: "rubric-eval-mode",
        scenario_description: "rubric-scenario",
        expected_outcome: "rubric-expected-outcome",
        grounding_context: "rubric-grounding",
        criteria: "rubric-criteria-section",
      };
      const ids = ["name", "evaluation_mode", "scenario_description", "expected_outcome", "grounding_context", "criteria"]
        .filter((k) => fieldErrors[k]?.length)
        .map((k) => idByKey[k]);
      focusFirstError(ids);
      return;
    }

    setClientErrors({});
  }

  function updateCriterion(index: number, patch: Partial<Criterion>) {
    mutateCriteria((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c))
    );
  }

  function addCriterion() {
    mutateCriteria((prev) => [...prev, { name: "", weight: 0, steps: [""] }]);
  }

  function removeCriterion(index: number) {
    mutateCriteria((prev) => prev.filter((_, i) => i !== index));
  }

  function addStep(ci: number) {
    mutateCriteria((prev) =>
      prev.map((c, i) => (i === ci ? { ...c, steps: [...c.steps, ""] } : c))
    );
  }

  function updateStep(ci: number, si: number, value: string) {
    mutateCriteria((prev) =>
      prev.map((c, i) =>
        i === ci
          ? { ...c, steps: c.steps.map((s, j) => (j === si ? value : s)) }
          : c
      )
    );
  }

  function removeStep(ci: number, si: number) {
    mutateCriteria((prev) =>
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
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-6 py-4">
        <h2
          id="rubric-dialog-title"
          className="text-lg font-semibold tracking-[-0.015em]"
        >
          {isEdit ? "Edit rubric" : "New rubric"}
        </h2>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close dialog"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-warm text-fg-2 transition-colors hover:bg-paper hover:text-ink"
        >
          <XIcon size={14} />
        </button>
      </div>

      {/* Template picker — create mode only, shown before the form */}
      {step === "pick" && (
        <div className="overflow-y-auto flex-1 px-6 py-6 flex flex-col gap-5">
          <div>
            <p className="text-sm text-fg-2">
              Start with a template or build your own from scratch.
            </p>
          </div>
          <ul className="grid grid-cols-2 gap-3" role="list">
            {RUBRIC_TEMPLATES.map((template) => (
              <li key={template.id} className="list-none">
                <button
                  type="button"
                  data-testid={`template-card-${template.id}`}
                  onClick={() => applyTemplate(template)}
                  className="group w-full rounded-xl border border-hairline-cool bg-card-warm p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <p className="text-sm font-semibold text-ink group-hover:text-accent-ink">
                    {template.name}
                  </p>
                  <p className="mt-1 text-xs text-fg-3 leading-relaxed">
                    {template.description}
                  </p>
                  <p className="mt-2.5 text-[11px] font-medium text-fg-4 uppercase tracking-wide">
                    {template.evaluation_mode === "prompt_response" ? "Prompt / Response" : "Conversational"}
                    {" · "}{template.criteria.length} criteria
                  </p>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-center">
            <button
              type="button"
              data-testid="start-from-scratch"
              onClick={() => setStep("form")}
              className="text-sm text-fg-3 transition-colors hover:text-ink"
            >
              Start from scratch →
            </button>
          </div>
        </div>
      )}

      {/* Body — form step (edit mode always; create mode after template selection) */}
      {step === "form" && (loading ? (
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
              <p className="text-sm text-danger-fg">
                {state.message}
              </p>
            )}

            <Field htmlFor="rubric-name" label="Name" error={fieldError("name")}>
              <input
                id="rubric-name"
                name="name"
                type="text"
                aria-invalid={!!fieldError("name")}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearClientError("name");
                }}
                placeholder="e.g. Customer support quality"
                className={fieldError("name") ? inputErrorCls : inputCls}
              />
            </Field>

            <Field
              htmlFor="rubric-eval-mode"
              label="Evaluation mode"
              tooltip="Prompt / Response: evaluates single-turn interactions between one user prompt and one AI response. Conversational: evaluates multi-turn dialogue where context from prior messages matters."
              error={fieldError("evaluation_mode")}
            >
              <select
                id="rubric-eval-mode"
                name="evaluation_mode"
                aria-invalid={!!fieldError("evaluation_mode")}
                value={evaluationMode}
                onChange={(e) => {
                  setEvaluationMode(e.target.value);
                  clearClientError("evaluation_mode");
                }}
                className={fieldError("evaluation_mode") ? inputErrorCls : inputCls}
              >
                <option value="prompt_response">Prompt / Response</option>
                <option value="conversational">Conversational</option>
              </select>
            </Field>

            <Field
              htmlFor="rubric-scenario"
              label="Scenario description"
              tooltip="Describe the context in which the AI is being evaluated — e.g. 'Customer support chat for an e-commerce platform.' This helps the LLM evaluator understand the purpose of the interaction."
              error={fieldError("scenario_description")}
            >
              <textarea
                id="rubric-scenario"
                name="scenario_description"
                rows={3}
                aria-invalid={!!fieldError("scenario_description")}
                value={scenarioDescription}
                onChange={(e) => {
                  setScenarioDescription(e.target.value);
                  clearClientError("scenario_description");
                }}
                placeholder="Describe the scenario being evaluated…"
                className={fieldError("scenario_description") ? inputErrorCls : inputCls}
              />
            </Field>

            <Field
              htmlFor="rubric-expected-outcome"
              label="Expected outcome"
              tooltip="Describe what a high-quality AI response looks like in this scenario. The LLM evaluator uses this as its benchmark when scoring outputs."
              error={fieldError("expected_outcome")}
            >
              <textarea
                id="rubric-expected-outcome"
                name="expected_outcome"
                rows={3}
                aria-invalid={!!fieldError("expected_outcome")}
                value={expectedOutcome}
                onChange={(e) => {
                  setExpectedOutcome(e.target.value);
                  clearClientError("expected_outcome");
                }}
                placeholder="What does a good response look like?"
                className={fieldError("expected_outcome") ? inputErrorCls : inputCls}
              />
            </Field>

            <Field
              htmlFor="rubric-grounding"
              label="Grounding context"
              optional
              tooltip="Reference material the LLM evaluator can consult when scoring responses — e.g. product documentation, policies, or domain knowledge. Providing this improves scoring accuracy when correct answers depend on specific facts."
              error={fieldError("grounding_context")}
            >
              <textarea
                id="rubric-grounding"
                name="grounding_context"
                rows={2}
                aria-invalid={!!fieldError("grounding_context")}
                value={groundingContext}
                onChange={(e) => {
                  setGroundingContext(e.target.value);
                  clearClientError("grounding_context");
                }}
                placeholder="Reference material for the LLM evaluator…"
                className={fieldError("grounding_context") ? inputErrorCls : inputCls}
              />
            </Field>

            {/* Criteria */}
            <div id="rubric-criteria-section">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Criteria</h3>
                  <p className="mt-0.5 text-xs text-fg-3">
                    Weights must sum to 1.00.
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 font-mono text-xs font-semibold tabular-nums ${
                    weightOk
                      ? "bg-success-bg text-success-fg"
                      : "bg-danger-bg text-danger-fg"
                  }`}
                >
                  Total {totalWeight.toFixed(2)} {weightOk ? "✓" : ""}
                </span>
              </div>

              {fieldError("criteria") && (
                <p className="mb-3 text-xs text-danger-fg">
                  {fieldError("criteria")![0]}
                </p>
              )}

              <div className="flex flex-col gap-3">
                {criteria.map((criterion, ci) => (
                  <div
                    key={ci}
                    className="flex flex-col gap-2.5 rounded-lg border border-hairline bg-card-warm p-3.5"
                  >
                    <div className="flex items-end gap-2.5">
                      <div className="flex-1">
                        <label
                          htmlFor={`criterion-name-${ci}`}
                          className="mb-1.5 block text-xs font-medium text-fg-2"
                        >
                          Name
                        </label>
                        <input
                          id={`criterion-name-${ci}`}
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
                        <div className="mb-1.5 flex items-center gap-1">
                          <label
                            htmlFor={`criterion-weight-${ci}`}
                            className="text-xs font-medium text-fg-2"
                          >
                            Weight
                          </label>
                          <InfoTooltip content="A decimal from 0 to 1 representing this criterion's importance. All weights must sum to exactly 1.00 — e.g. two equal criteria each get 0.50." />
                        </div>
                        <input
                          id={`criterion-weight-${ci}`}
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          value={criterion.weight}
                          onChange={(e) =>
                            updateCriterion(ci, {
                              weight: parseFloat(e.target.value) || 0,
                            })
                          }
                          className={`${inputCls} font-mono tabular-nums`}
                        />
                      </div>
                      {criteria.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeCriterion(ci)}
                          aria-label="Remove criterion"
                          className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-paper-warm hover:text-danger"
                        >
                          <TrashIcon size={15} />
                        </button>
                      )}
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          <label className="text-xs font-medium text-ink">
                            Scoring steps
                          </label>
                          <InfoTooltip content="Step-by-step instructions the LLM evaluator follows when scoring this criterion. More detailed steps produce more consistent, repeatable scores." />
                        </div>
                        <button
                          type="button"
                          onClick={() => addStep(ci)}
                          className="text-xs font-medium text-fg-3 transition-colors hover:text-ink"
                        >
                          + Add step
                        </button>
                      </div>
                      <div className="flex flex-col gap-2">
                        {criterion.steps.map((stepText, si) => (
                          <div key={si} className="flex items-center gap-2">
                            <span className="w-4 shrink-0 text-right font-mono text-xs text-fg-4">
                              {si + 1}.
                            </span>
                            <input
                              type="text"
                              value={stepText}
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
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-4 transition-colors hover:bg-paper-warm hover:text-danger"
                              >
                                <XIcon size={13} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addCriterion}
                className="mt-3 inline-flex items-center gap-1 self-start rounded-full border border-hairline-cool bg-card px-3.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-card-warm"
              >
                <PlusIcon size={12} /> Add criterion
              </button>
            </div>
          </form>
        </div>
      ))}

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between border-t border-hairline bg-paper-warm px-6 py-3.5">
        {/* Left side: delete (edit) | back (create/form step) | empty (pick step) */}
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
                ? "rounded-full bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-hover disabled:opacity-50"
                : "px-2 py-2 text-sm text-danger transition-colors hover:text-danger-fg"
            }
          >
            {isDeleting
              ? "Deleting…"
              : confirmingDelete
                ? "Delete forever?"
                : "Delete"}
          </button>
        ) : step === "form" ? (
          <button
            type="button"
            onClick={() => setStep("pick")}
            className="px-2 py-2 text-sm text-fg-3 transition-colors hover:text-ink"
          >
            ← Back
          </button>
        ) : (
          <span />
        )}

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(false);
              props.onClose();
            }}
            className="rounded-full border border-hairline-cool bg-card px-4 py-2 text-sm text-ink transition-colors hover:bg-card-warm"
          >
            Cancel
          </button>
          {step === "form" && (
            <button
              type="submit"
              form="rubric-form"
              disabled={isPending || loading}
              className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-fg-on-ink transition-colors hover:bg-ink-hover disabled:opacity-50"
            >
              {isPending ? "Saving…" : isEdit ? "Save changes" : "Create rubric"}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const inputCls =
  "w-full rounded-md border border-hairline-field bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-[3px] focus:ring-accent/50";

const inputErrorCls =
  "w-full rounded-md border border-danger bg-card px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-danger focus:ring-[3px] focus:ring-red-400/50";

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

