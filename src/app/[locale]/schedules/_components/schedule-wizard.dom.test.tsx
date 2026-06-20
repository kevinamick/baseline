// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScheduleWizard } from "./schedule-wizard";
import { CreateScheduleSchema } from "@/lib/validation/schemas";
import type { RubricSummary } from "@/types/rubric";

const mockCreate = vi.fn();
vi.mock("@/app/actions/schedules", () => ({
  createSchedule: (input: unknown) => mockCreate(input),
}));

const RUBRIC_ID = "11111111-1111-4111-8111-111111111111";
const RUBRICS: RubricSummary[] = [
  { id: RUBRIC_ID, name: "Helpfulness", evaluation_mode: "prompt_response", created_at: "2026-06-01T00:00:00Z" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ scheduleId: "sched-x" });
});

// Fill Basics and the new-agent-connection System step (no existing connections, so the
// wizard opens straight onto the inline form with the agent type preselected).
async function fillBasicsAndAgentSystem(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "Nightly eval");
  await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
  await user.type(screen.getByLabelText("Connection name"), "Support agent");
  await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/agent");
}

describe("ScheduleWizard — agent Modules (#119)", () => {
  it("declares optional Modules on a new agent connection and ships them in the payload", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);

    // Declare one Module — the shared editor injects {{prompt:system}} into the template.
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Answer helpfully.");
    expect(screen.queryByText(/isn't referenced/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    // Review surfaces the declared Modules.
    expect(screen.getByText("Modules")).toBeInTheDocument();
    expect(screen.getByText("system")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.newConnection).toMatchObject({
      type: "agent",
      name: "Support agent",
      optimizablePrompts: [{ name: "system", seed: "Answer helpfully." }],
    });
    // Integration guard: the wizard's payload must satisfy the server action's contract.
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("creates a plain agent connection (no Modules) exactly as before", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.type(screen.getByPlaceholderText("User input…"), "Hello?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    const payload = mockCreate.mock.calls[0][0];
    expect(payload.newConnection.optimizablePrompts).toEqual([]);
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("blocks advancing past System when a declared Module isn't referenced in the template", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);

    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Be warm.");
    // Rename the Module so it no longer matches the injected {{prompt:system}} reference.
    await user.clear(screen.getByLabelText("Module 1 name"));
    await user.type(screen.getByLabelText("Module 1 name"), "tone");

    // The live hint shows the mismatch, and Next refuses to advance.
    expect(screen.getByText(/isn't referenced/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent('Declared Module "tone"');
    // Still on the System step — the Inputs step's helper text isn't rendered.
    expect(screen.queryByPlaceholderText("User input…")).not.toBeInTheDocument();
  });

  it("requires a seed prompt for a declared Module", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent('Give Module "system" a seed prompt.');
  });
});
