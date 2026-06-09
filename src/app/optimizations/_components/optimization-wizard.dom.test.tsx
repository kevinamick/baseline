// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptimizationWizard } from "./optimization-wizard";
import { CreateOptimizationRunSchema } from "@/lib/validation/schemas";
import type { RubricSummary } from "@/types/rubric";
import type { OptimizableConnection } from "@/types/optimization";

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

// Walk Basics → System → Instances (one manual row) → Tuning, leaving the wizard on Review.
async function advanceToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
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
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Instances
    // No row typed — Next should surface a validation error and not reach Tuning.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one input row.");
    expect(screen.queryByText("Rollout budget")).not.toBeInTheDocument();
  });

  it("parses a JSON-paste instance set into the payload", async () => {
    const user = userEvent.setup();
    render(
      <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
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
    // With no existing connections the System step defaults to the inline new-connection form.
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
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
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
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
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
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

  describe("breadcrumb step navigation", () => {
    it("step bubbles are non-interactive spans on initial render (no steps reached yet)", () => {
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
      );
      // No breadcrumb buttons — only the Next/Back/Close buttons exist.
      const stepButtons = ["Basics", "System", "Instances", "Tuning", "Review"].flatMap(
        (label) => screen.queryAllByRole("button", { name: `Go to ${label} step` })
      );
      expect(stepButtons).toHaveLength(0);
    });

    it("the current step bubble carries aria-current=step", () => {
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
      );
      expect(screen.getByText("Basics").closest("[aria-current='step']")).toBeInTheDocument();
    });

    it("advancing to System makes the Basics breadcrumb a clickable button", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      expect(screen.getByRole("button", { name: "Go to Basics step" })).toBeInTheDocument();
      // System is current — not a breadcrumb button.
      expect(screen.queryByRole("button", { name: "Go to System step" })).not.toBeInTheDocument();
    });

    it("clicking a completed breadcrumb navigates back to that step and clears errors", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
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
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
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
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
      );

      await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
      // Only Basics has been reached before, so Tuning and Review buttons should not exist.
      expect(screen.queryByRole("button", { name: "Go to Tuning step" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Go to Review step" })).not.toBeInTheDocument();
    });

    it("all five steps become reachable after completing the full wizard flow", async () => {
      const user = userEvent.setup();
      render(
        <OptimizationWizard rubrics={RUBRICS} connections={CONNECTIONS} onClose={vi.fn()} onCreated={vi.fn()} />
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
