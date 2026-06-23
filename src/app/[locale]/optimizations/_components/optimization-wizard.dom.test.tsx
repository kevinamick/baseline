// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../messages/en.json";
import userEvent from "@testing-library/user-event";
import { OptimizationWizard } from "./optimization-wizard";
import { CreateOptimizationRunSchema } from "@/lib/validation/schemas";
import type { RubricSummary } from "@/types/rubric";
import type { OptimizableConnection } from "@/types/optimization";

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
      instances: [
        { userInput: "How do I reset my password?", expectedOutput: null, retrievalContext: null },
      ],
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
        instances: [
          { userInput: "Q1", expectedOutput: "A1", retrievalContext: null },
          { userInput: "Q2", expectedOutput: null, retrievalContext: null },
        ],
      })
    );
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
});
