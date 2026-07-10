// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../messages/en.json";
import userEvent from "@testing-library/user-event";
import { OptimizationWizard } from "./optimization-wizard";
import { CreateOptimizationRunSchema } from "@/lib/validation/schemas";
import type { RubricSummary } from "@/types/rubric";
import type { OptimizableConnection, DatasetConnectionOption, EvalRunInstanceOption } from "@/types/optimization";

// OptimizationWizard renders the shared <Field>/<ModulesEditor>, which read the
// next-intl catalog, so renders need a provider (real English catalog).
function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

const mockStart = vi.fn();
vi.mock("@/app/actions/optimizations", () => ({
  startOptimizationRun: (input: unknown) => mockStart(input),
}));

const RUBRIC_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const RUBRICS: RubricSummary[] = [
  { id: RUBRIC_ID, name: "Helpfulness", evaluation_mode: "prompt_response", created_at: "2026-06-01T00:00:00Z" },
];
const CONNECTIONS: OptimizableConnection[] = [
  { id: CONNECTION_ID, name: "Support Agent", modules: ["system", "style"] },
];
const DATASET_CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
const DATASET_CONNECTIONS: DatasetConnectionOption[] = [
  { id: DATASET_CONNECTION_ID, name: "Prod traffic logs" },
];
const EVAL_RUN_ID = "66666666-6666-4666-8666-666666666666";
const EVAL_RUN_OPTIONS: EvalRunInstanceOption[] = [
  { id: EVAL_RUN_ID, description: "Prod smoke test", createdAt: "2026-06-01T00:00:00Z", rowCount: 8 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockStart.mockResolvedValue({ optRunId: "run-x" });
});

// Select one of the System step's three mode cards by its (regex) accessible name.
async function selectSystemMode(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole("radio", { name }));
}

// Walk Basics → System (existing Connection) → Instances (one manual row) → Tuning, leaving the
// wizard on Review. The System step now defaults to the managed "Paste a prompt" mode, so tests
// of the existing-Connection path select it explicitly.
async function advanceToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
  await selectSystemMode(user, /Use an existing System/);
  await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
  await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
  await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
  await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
}

describe("OptimizationWizard", () => {
  it("shapes the startOptimizationRun payload from the wizard state on confirm", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <OptimizationWizard
        rubrics={RUBRICS}
        connections={CONNECTIONS}
        maxBudgetRollouts={200}
        onClose={onClose}
        onCreated={onCreated}
      />
    );

    await advanceToReview(user);
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      rubricId: RUBRIC_ID,
      evalType: "tabular",
      instancesSource: {
        type: "inline",
        instances: [
          { userInput: "How do I reset my password?", expectedOutput: null, retrievalContext: null },
        ],
      },
      budgetRollouts: 30,
      maxIters: 20,
      plateauPatience: 5,
      mode: "reflective",
      reflectModel: "claude-sonnet-4-6",
    });
    // On success the wizard refreshes the list and closes.
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Integration guard: the shape the wizard emits must satisfy the server action's contract.
    const payload = mockStart.mock.calls[0][0];
    expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
  });

  // --- Budget floor (#468, prod incident opt-4afa3642) ---

  it("shows the minimum-viable-budget hint next to the rollout budget field for a known instance count", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning

    // One inline instance, Reflective mode (the default for an existing Connection): minimum is
    // 1 + 2*min(5, 1) = 3.
    expect(
      screen.getByText(
        "Minimum viable budget for 1 instance: 3 rollouts — one full pass to score the seed, plus enough left over for one iteration."
      )
    ).toBeInTheDocument();
  });

  it("blocks advancing past Tuning when the budget is below the mode-aware minimum", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning

    const budgetInput = screen.getByLabelText("Rollout budget");
    await user.clear(budgetInput);
    await user.type(budgetInput, "2"); // one below the minimum of 3 for 1 instance, Reflective mode
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "With 1 instance, the rollout budget must be at least 3 (one full pass to score the seed, plus one iteration)."
    );
    // Still on Tuning, not advanced to Review.
    expect(screen.queryByRole("button", { name: "Start run" })).not.toBeInTheDocument();
  });

  it("renders the server's budget-floor refusal inline on Review, not as a lost toast", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mockStart.mockResolvedValue({
      error:
        "45 instances need a rollout budget of at least 55 (one full pass to score the seed, plus one iteration) — increase the budget or use fewer instances.",
    });
    render(
      <OptimizationWizard
        rubrics={RUBRICS}
        connections={CONNECTIONS}
        maxBudgetRollouts={200}
        onClose={onClose}
        onCreated={onCreated}
      />
    );

    await advanceToReview(user);
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "45 instances need a rollout budget of at least 55 (one full pass to score the seed, plus one iteration) — increase the budget or use fewer instances."
    );
    // The form is untouched — no toast that discards the wizard's state.
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start run" })).toBeInTheDocument();
  });

  it("blocks advancing past Instances when no input row has a user_input", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    // No row typed — Next should surface a validation error and not reach Tuning.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one input row.");
    expect(screen.queryByText("Rollout budget")).not.toBeInTheDocument();
  });

  it("parses a JSON-paste instance set into the payload", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.click(screen.getByRole("button", { name: "JSON" }));
    await user.click(screen.getByLabelText("Instances JSON"));
    await user.paste('[{"user_input":"Q1","expected_output":"A1"},{"user_input":"Q2"}]');
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        instancesSource: {
          type: "inline",
          instances: [
            { userInput: "Q1", expectedOutput: "A1", retrievalContext: null },
            { userInput: "Q2", expectedOutput: null, retrievalContext: null },
          ],
        },
      })
    );
  });

  // --- Instances source: dataset-Connection snapshot (#82) ---

  it("hides the dataset-snapshot tab when the Team has no dataset Connections", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    expect(screen.queryByRole("button", { name: "Dataset connection" })).not.toBeInTheDocument();
  });

  it("shapes a dataset-snapshot instancesSource payload when that tab is picked", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard
        rubrics={RUBRICS}
        connections={CONNECTIONS}
        datasetConnections={DATASET_CONNECTIONS}
        maxBudgetRollouts={200}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.click(screen.getByRole("button", { name: "Dataset connection" }));
    await user.selectOptions(screen.getByLabelText("Connection"), DATASET_CONNECTION_ID);
    await user.selectOptions(screen.getByLabelText("Lookback window"), "10080");
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        instancesSource: {
          type: "dataset_snapshot",
          connectionId: DATASET_CONNECTION_ID,
          windowMinutes: 10080,
        },
      })
    );
    // Integration guard: the shape the wizard emits must satisfy the server action's contract.
    const payload = mockStart.mock.calls[0][0];
    expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
  });

  it("validates against the DISPLAYED default Connection when the list arrives after mount", async () => {
    // Regression: the wizard mounts once; a router.refresh can deliver the first dataset
    // Connection through props AFTER the selection state initialized to "". The controlled
    // <select> then displays the first option while the stored id stays empty — validation
    // must follow what the user sees, not the stale state, or the submit fails with
    // "Select a dataset connection" despite a visibly selected Connection.
    const user = userEvent.setup();
    const { rerender } = render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );
    // rerender replaces the full tree, so the intl provider must be reapplied.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <OptimizationWizard
          rubrics={RUBRICS}
          connections={CONNECTIONS}
          datasetConnections={DATASET_CONNECTIONS}
          maxBudgetRollouts={200}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </NextIntlClientProvider>
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.click(screen.getByRole("button", { name: "Dataset connection" }));
    // No explicit selection: the select displays the first (only) Connection by default.
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        instancesSource: expect.objectContaining({
          type: "dataset_snapshot",
          connectionId: DATASET_CONNECTION_ID,
        }),
      })
    );
  });

  // --- Instances source: seed from an existing Eval Run (#83) ---

  it("hides the eval-run tab when the Team has no Eval Runs", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    expect(screen.queryByRole("button", { name: "From an Eval Run" })).not.toBeInTheDocument();
  });

  it("shapes an eval_run instancesSource payload when that tab is picked", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard
        rubrics={RUBRICS}
        connections={CONNECTIONS}
        evalRunOptions={EVAL_RUN_OPTIONS}
        maxBudgetRollouts={200}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.click(screen.getByRole("button", { name: "From an Eval Run" }));
    await user.selectOptions(screen.getByLabelText("Eval run"), EVAL_RUN_ID);
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        instancesSource: { type: "eval_run", evalRunId: EVAL_RUN_ID },
      })
    );
    // Integration guard: the shape the wizard emits must satisfy the server action's contract.
    const payload = mockStart.mock.calls[0][0];
    expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
  });

  it("Review step shows the picked Eval Run's row count and label", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard
        rubrics={RUBRICS}
        connections={CONNECTIONS}
        evalRunOptions={EVAL_RUN_OPTIONS}
        maxBudgetRollouts={200}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Use an existing System/);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.click(screen.getByRole("button", { name: "From an Eval Run" }));
    await user.selectOptions(screen.getByLabelText("Eval run"), EVAL_RUN_ID);
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review

    // 8 rows (under the cap) shown as the Instances count, and the Source row names the run.
    expect(screen.getByText("8 rows")).toBeInTheDocument();
    expect(screen.getByText(/From eval run: Prod smoke test/)).toBeInTheDocument();
  });

  it("creates an inline agent connection in new mode and shapes the newConnection payload", async () => {
    const user = userEvent.setup();
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Connect your agent/);
    await user.type(screen.getByLabelText("Connection name"), "Inline agent");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/agent");
    // Default Module "system" matches the default template's {{prompt:system}}; just add a seed.
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Answer helpfully.");
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(mockStart).toHaveBeenCalledTimes(1);
    const payload = mockStart.mock.calls[0][0];
    expect(payload.connectionId).toBeUndefined();
    expect(payload.newConnection).toMatchObject({
      type: "agent",
      name: "Inline agent",
      endpoint: "https://api.example.com/agent",
      responsePath: "output",
      optimizablePrompts: [{ name: "system", seed: "Answer helpfully." }],
    });
    // The inline payload must also satisfy the server action's contract.
    expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
  });

  it("auto-references a newly added Module in the request template", async () => {
    const user = userEvent.setup();
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Connect your agent/);
    await user.type(screen.getByLabelText("Connection name"), "Inline agent");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/agent");
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Answer helpfully.");

    // Add a second Module — the template should gain its {{prompt:...}} reference automatically,
    // so no declared↔referenced mismatch hint appears and the step advances.
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(screen.getByLabelText("Module 2 seed prompt"), "Be concise.");
    expect(screen.queryByText(/isn't referenced/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
    await user.click(screen.getByRole("button", { name: "Start run" }));

    const payload = mockStart.mock.calls[0][0];
    expect(payload.newConnection.optimizablePrompts).toHaveLength(2);
    // The auto-injected reference keeps the inline payload schema-valid (declared↔referenced).
    expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
  });

  it("blocks advancing when a declared Module isn't referenced in the template", async () => {
    const user = userEvent.setup();
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await selectSystemMode(user, /Connect your agent/);
    await user.type(screen.getByLabelText("Connection name"), "Inline agent");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/agent");
    // Rename the Module so it no longer matches the default template's {{prompt:system}}.
    await user.clear(screen.getByLabelText("Module 1 name"));
    await user.type(screen.getByLabelText("Module 1 name"), "tone");
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Be warm.");

    // Live cross-validation hint surfaces the mismatch.
    expect(screen.getByText(/isn't referenced/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent('Declared Module "tone"');
    // Still on the System step (no Instances source toggle visible).
    expect(screen.queryByRole("button", { name: "JSON" })).not.toBeInTheDocument();
  });

  it("defaults to the managed Paste-a-prompt mode and shapes a managed_agent newConnection", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    // "Paste a prompt" is the default-selected mode — no mode click needed.
    expect(screen.getByRole("radio", { name: /Paste a prompt/ })).toBeChecked();

    // Managed mode collects exactly a prompt + target model — no endpoint / template / Modules.
    await user.type(screen.getByLabelText("Prompt"), "You are a helpful support agent.");
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Target model")).toHaveValue("claude-haiku-4-5-20251001");

    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review

    // Review summarizes the System as "Prompt (managed, <model>)".
    expect(screen.getByText("Prompt (managed, Haiku 4.5)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start run" }));

    expect(mockStart).toHaveBeenCalledTimes(1);
    const payload = mockStart.mock.calls[0][0];
    expect(payload.connectionId).toBeUndefined();
    expect(payload.newConnection).toEqual({
      type: "managed_agent",
      targetModel: "claude-haiku-4-5-20251001",
      prompt: "You are a helpful support agent.",
    });
    // Managed agent defaults to Simple mode with Haiku as the generation model.
    expect(payload.mode).toBe("simple");
    expect(payload.reflectModel).toBe("claude-haiku-4-5-20251001");
    // The managed inline payload must satisfy the server action's contract.
    expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
  });

  it("blocks advancing past System in managed mode with an empty prompt", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await user.click(screen.getByRole("button", { name: "Next" })); // try System → Instances
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a prompt to optimize.");
    // Still on System — the Instances source toggle isn't rendered.
    expect(screen.queryByRole("button", { name: "JSON" })).not.toBeInTheDocument();
  });

  it("disables the existing-System mode when the Team has no optimizable Connections", async () => {
    const user = userEvent.setup();
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    expect(screen.getByRole("radio", { name: /Use an existing System/ })).toBeDisabled();
    // The managed default stays reachable and selected.
    expect(screen.getByRole("radio", { name: /Paste a prompt/ })).toBeChecked();
  });

  describe("Managed Agent path is paid-only (#204)", () => {
    it("hides the Paste-a-prompt option for a Free Team and defaults to an external agent", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard
          rubrics={RUBRICS}
          connections={CONNECTIONS}
          isPaid={false}
          maxBudgetRollouts={200}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      // The managed "Paste a prompt" option (and therefore Simple mode) is gone for a Free Team.
      expect(screen.queryByRole("radio", { name: /Paste a prompt/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: /^Simple$/ })).not.toBeInTheDocument();
      // It defaults to an existing Connection (CONNECTIONS is non-empty), an external-agent path.
      expect(screen.getByRole("radio", { name: /Use an existing System/ })).toBeChecked();
    });

    it("with no existing Connections a Free Team defaults to the inline external-agent path", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard
          rubrics={RUBRICS}
          connections={[]}
          isPaid={false}
          maxBudgetRollouts={200}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      expect(screen.queryByRole("radio", { name: /Paste a prompt/ })).not.toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /Connect your agent/ })).toBeChecked();
    });
  });

  describe("Optimization Mode selector", () => {
    it("shows Mode selector only for paste-a-prompt managed agents, not for external or existing", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      // Managed (default): Mode selector appears.
      expect(screen.getByRole("radio", { name: /Simple/ })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /Reflective/ })).toBeInTheDocument();
      // Simple is the default.
      expect(screen.getByRole("radio", { name: /Simple/ })).toBeChecked();

      // Switch to existing Connection: Mode selector disappears.
      await selectSystemMode(user, /Use an existing System/);
      expect(screen.queryByRole("radio", { name: /^Simple$/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: /^Reflective$/ })).not.toBeInTheDocument();

      // Switch to new external Connection: Mode selector also absent.
      await selectSystemMode(user, /Connect your agent/);
      expect(screen.queryByRole("radio", { name: /^Simple$/ })).not.toBeInTheDocument();
    });

    it("switching to Reflective mode sends mode:reflective in the payload", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      // Switch to Reflective.
      await user.click(screen.getByRole("radio", { name: /Reflective/ }));
      await user.type(screen.getByLabelText("Prompt"), "You are a helpful agent.");
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
      await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
      await user.click(screen.getByRole("button", { name: "Start run" }));

      const payload = mockStart.mock.calls[0][0];
      expect(payload.mode).toBe("reflective");
      expect(payload.reflectModel).toBe("claude-sonnet-4-6");
      expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
    });

    it("Simple mode Tuning shows generation-model picker and relabeled backstops, not reflection model", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      await user.type(screen.getByLabelText("Prompt"), "You are a helpful agent.");
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning

      // Simple mode: generation model picker is visible at top level.
      expect(screen.getByLabelText("Generation model")).toBeInTheDocument();
      expect(screen.getByLabelText("Generation model")).toHaveValue("claude-haiku-4-5-20251001");
      // Reflection model (Reflective-only) is hidden.
      expect(screen.queryByLabelText("Reflection model")).not.toBeInTheDocument();

      // Open Advanced: shows relabeled backstops.
      await user.click(screen.getByRole("button", { name: "Advanced settings" }));
      expect(screen.getByLabelText("Max rounds")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop after N rounds with no improvement")).toBeInTheDocument();
      // Original "Max iterations" label is not shown.
      expect(screen.queryByLabelText("Max iterations")).not.toBeInTheDocument();
    });

    it("Reflective mode Tuning is unchanged: shows reflection model in Advanced, no generation model picker", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      await user.click(screen.getByRole("radio", { name: /Reflective/ }));
      await user.type(screen.getByLabelText("Prompt"), "You are a helpful agent.");
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning

      // No generation model picker at top level.
      expect(screen.queryByLabelText("Generation model")).not.toBeInTheDocument();

      // Open Advanced: reflection model and original labels are present.
      await user.click(screen.getByRole("button", { name: "Advanced settings" }));
      expect(screen.getByLabelText("Max iterations")).toBeInTheDocument();
      expect(screen.getByLabelText("Plateau patience")).toBeInTheDocument();
      expect(screen.getByLabelText("Reflection model")).toBeInTheDocument();
    });

    it("Review step shows Mode row for managed agents only", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      await user.type(screen.getByLabelText("Prompt"), "You are a helpful agent.");
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
      await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review

      // Simple is the default mode — review shows it.
      expect(screen.getByText("Simple")).toBeInTheDocument();
    });

    it("Review step shows Reflective when that mode is chosen for a managed agent", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      await user.click(screen.getByRole("radio", { name: /Reflective/ }));
      await user.type(screen.getByLabelText("Prompt"), "You are a helpful agent.");
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
      await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review

      expect(screen.getByText("Reflective")).toBeInTheDocument();
      expect(screen.queryByText("Simple")).not.toBeInTheDocument();
    });

    it("Review step does not show Mode row for existing Connections", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await advanceToReview(user);

      // "Mode" label should not appear since existing connections don't show the mode selector.
      expect(screen.queryByText("Mode")).not.toBeInTheDocument();
    });

    it("Simple → Reflective → Simple round-trip sends mode:simple with Haiku in payload", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      // Switch to Reflective, then back to Simple.
      await user.click(screen.getByRole("radio", { name: /Reflective/ }));
      await user.click(screen.getByRole("radio", { name: /Simple/ }));
      await user.type(screen.getByLabelText("Prompt"), "You are a helpful agent.");
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
      await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
      await user.click(screen.getByRole("button", { name: "Start run" }));

      const payload = mockStart.mock.calls[0][0];
      expect(payload.mode).toBe("simple");
      expect(payload.reflectModel).toBe("claude-haiku-4-5-20251001");
      expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
    });

    it("switching connMode to existing overrides Simple optimMode and sends mode:reflective", async () => {
      const user = userEvent.setup();
      render(<OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      // Managed default has Simple selected — now switch connMode to existing.
      expect(screen.getByRole("radio", { name: /Simple/ })).toBeChecked();
      await selectSystemMode(user, /Use an existing System/);
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
      await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
      await user.click(screen.getByRole("button", { name: "Start run" }));

      const payload = mockStart.mock.calls[0][0];
      // connMode=existing forces reflective regardless of the optimMode state.
      expect(payload.mode).toBe("reflective");
      expect(payload.connectionId).toBe(CONNECTION_ID);
      expect(CreateOptimizationRunSchema.safeParse(payload).success).toBe(true);
    });
  });

  describe("breadcrumb step navigation", () => {
    it("step bubbles are non-interactive spans on initial render (no steps reached yet)", () => {
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
      );
      // No breadcrumb buttons — only the Next/Back/Close buttons exist.
      const stepButtons = ["Basics", "System", "Instances", "Tuning", "Review"].flatMap(
        (label) => screen.queryAllByRole("button", { name: `Go to ${label} step` })
      );
      expect(stepButtons).toHaveLength(0);
    });

    it("the current step bubble carries aria-current=step", () => {
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
      );
      expect(screen.getByText("Basics").closest("[aria-current='step']")).toBeInTheDocument();
    });

    it("advancing to System makes the Basics breadcrumb a clickable button", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      expect(screen.getByRole("button", { name: "Go to Basics step" })).toBeInTheDocument();
      // System is current — not a breadcrumb button.
      expect(screen.queryByRole("button", { name: "Go to System step" })).not.toBeInTheDocument();
    });

    it("clicking a completed breadcrumb navigates back to that step and clears errors", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      await selectSystemMode(user, /Use an existing System/);
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances

      // Trigger a validation error on Instances, then click back via breadcrumb.
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("alert")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Go to Basics step" }));
      // Should be on Basics now (rubric select is visible) and error is gone.
      expect(screen.getByLabelText("Rubric")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("breadcrumb navigates forward to a previously reached step after going back", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      await selectSystemMode(user, /Use an existing System/);
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances

      // Go back to Basics via breadcrumb.
      await user.click(screen.getByRole("button", { name: "Go to Basics step" }));
      expect(screen.getByLabelText("Rubric")).toBeInTheDocument();

      // Instances (i=2) was previously reached (maxReachedStep=2) — its breadcrumb should be active.
      expect(screen.getByRole("button", { name: "Go to Instances step" })).toBeInTheDocument();

      // Clicking it should jump forward to Instances.
      await user.click(screen.getByRole("button", { name: "Go to Instances step" }));
      expect(screen.getByPlaceholderText("User input…")).toBeInTheDocument();
    });

    it("future (unreached) steps remain non-interactive even after going back", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      // Only Basics has been reached before, so Tuning and Review buttons should not exist.
      expect(screen.queryByRole("button", { name: "Go to Tuning step" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Go to Review step" })).not.toBeInTheDocument();
    });

    it("all five steps become reachable after completing the full wizard flow", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} maxBudgetRollouts={200} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await advanceToReview(user);

      // All steps except the current one (Review) should be breadcrumb buttons.
      expect(screen.getByRole("button", { name: "Go to Basics step" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Go to System step" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Go to Instances step" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Go to Tuning step" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Go to Review step" })).not.toBeInTheDocument();
    });
  });

  // Multi-provider model selection (#204): the model dropdown groups by provider, shows only
  // providers the Team can use, and names which key a run will use.
  describe("provider-grouped model selection (#204)", () => {
    async function toSimpleTuning(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      await user.type(screen.getByLabelText("Prompt"), "You are a helpful agent.");
      await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
      await user.type(screen.getByPlaceholderText("User input…"), "Test input");
      await user.click(screen.getByRole("button", { name: "Next" })); // Instances → Tuning
    }

    it("groups the generation model by usable provider and names the BYO key in use", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard
          rubrics={RUBRICS}
          connections={CONNECTIONS}
          usableProviders={[
            { provider: "anthropic", keySource: "byo" },
            { provider: "openai", keySource: "managed" },
          ]}
          maxBudgetRollouts={200}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />,
      );
      await toSimpleTuning(user);

      const select = screen.getByLabelText("Generation model");
      // Anthropic is usable, so the default (Haiku) stays selected and its BYO key is named.
      expect(select).toHaveValue("claude-haiku-4-5-20251001");
      expect(screen.getByText("Runs on your Anthropic key")).toBeInTheDocument();
      // Both providers' optgroups render; OpenAI's models are offered.
      expect(within(select as HTMLSelectElement).getByRole("group", { name: "Anthropic" })).toBeInTheDocument();
      expect(within(select as HTMLSelectElement).getByRole("group", { name: "OpenAI" })).toBeInTheDocument();
      expect(within(select as HTMLSelectElement).getByRole("option", { name: /GPT-5 mini/ })).toBeInTheDocument();
    });

    it("falls back to the first usable provider's default and names the managed key", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard
          rubrics={RUBRICS}
          connections={CONNECTIONS}
          usableProviders={[{ provider: "openai", keySource: "managed" }]}
          maxBudgetRollouts={200}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />,
      );
      await toSimpleTuning(user);

      const select = screen.getByLabelText("Generation model");
      // Anthropic isn't usable, so the generation model defaults to OpenAI's fast model.
      expect(select).toHaveValue("gpt-5-mini");
      expect(screen.getByText("Runs on Baseline’s managed OpenAI key")).toBeInTheDocument();
      // Only the OpenAI optgroup renders.
      expect(within(select as HTMLSelectElement).queryByRole("group", { name: "Anthropic" })).not.toBeInTheDocument();
    });

    it("submits the chosen non-Anthropic model as reflectModel", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard
          rubrics={RUBRICS}
          connections={CONNECTIONS}
          usableProviders={[{ provider: "google", keySource: "byo" }]}
          maxBudgetRollouts={200}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />,
      );
      await toSimpleTuning(user);
      expect(screen.getByLabelText("Generation model")).toHaveValue("gemini-2.5-flash");
      await user.click(screen.getByRole("button", { name: "Next" })); // Tuning → Review
      await user.click(screen.getByRole("button", { name: "Start run" }));

      expect(mockStart).toHaveBeenCalledTimes(1);
      const payload = mockStart.mock.calls[0][0];
      expect(payload.mode).toBe("simple");
      expect(payload.reflectModel).toBe("gemini-2.5-flash");
    });
  });

  // ADR-0016: the Review step projects the run's Eval Point cost. A rubric with a
  // known criterion count drives `evalRunPointsPerRow` = 10 + 5×|criteria|; the
  // worst-case reservation is budget_rollouts × that. `remainingRuns` selects the
  // copy: ≥1 → an included (zero-point) run, ≤0 → a paid Team's points-metered run.
  describe("ADR-0016 Eval Point projection on Review", () => {
    const POINTS_RUBRIC: RubricSummary[] = [
      { ...RUBRICS[0], criteriaCount: 3 }, // perRollout = 10 + 5×3 = 25
    ];

    function writeEvidence(file: string, label: string, row: HTMLElement) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      const dir = "/tmp/no-mistakes-evidence/01KW4RSGZN76ZXM9BDXHJ8XT85";
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        `${dir}/${file}`,
        `<!-- ${label} -->\n<!doctype html><meta charset="utf-8">\n` +
          `<body style="font-family:ui-sans-serif,system-ui;padding:24px;background:#fff">\n` +
          `<h3 style="font:600 13px ui-sans-serif">${label}</h3>\n` +
          `<dl style="display:flex;gap:12px;font-size:14px">${row.innerHTML}</dl>\n</body>\n`,
      );
    }

    it("shows the worst-case points line for a paid overage run (remainingRuns ≤ 0)", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard
          rubrics={POINTS_RUBRIC}
          connections={CONNECTIONS}
          maxBudgetRollouts={200}
          remainingRuns={0}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />,
      );
      await advanceToReview(user);

      // budget_rollouts default 30 × 25 pts = 750, rendered as "{rollouts} × {perRollout} pts".
      const label = screen.getByText("Eval Point cost");
      const row = label.closest("div")!;
      expect(within(row).getByText("Up to 750 Eval Points (30 rollouts × 25 pts)")).toBeInTheDocument();
      writeEvidence("wizard-review-overage.html", "Review step — paid overage run (ADR-0016)", row);
    });

    it("shows the included-run line when allowance remains (remainingRuns ≥ 1)", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard
          rubrics={POINTS_RUBRIC}
          connections={CONNECTIONS}
          maxBudgetRollouts={200}
          remainingRuns={3}
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />,
      );
      await advanceToReview(user);

      const label = screen.getByText("Eval Point cost");
      const row = label.closest("div")!;
      expect(within(row).getByText("Included run (3 left) — no Eval Points used")).toBeInTheDocument();
      writeEvidence("wizard-review-included.html", "Review step — included run (ADR-0016)", row);
    });
  });
});
