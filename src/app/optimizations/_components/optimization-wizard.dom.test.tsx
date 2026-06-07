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

  it("shows a pointer when no agent connection declares a Module", async () => {
    const user = userEvent.setup();
    render(<OptimizationWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    expect(screen.getByText(/No agent connection declares an optimizable Module yet/)).toBeInTheDocument();
    // Cannot advance past System without a connection.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No agent connection declares a Module yet.");
  });
});
