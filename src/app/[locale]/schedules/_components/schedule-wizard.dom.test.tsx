// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../messages/en.json";
import userEvent from "@testing-library/user-event";
import { ScheduleWizard } from "./schedule-wizard";
import { CreateScheduleSchema } from "@/lib/validation/schemas";
import type { RubricSummary } from "@/types/rubric";
import type { ConnectionSummary } from "@/types/schedule";

function conn(over: Partial<ConnectionSummary> & Pick<ConnectionSummary, "id" | "name">): ConnectionSummary {
  return {
    kind: "agent",
    provider: "custom",
    agent_kind: "external",
    endpoint: "https://api.example.com/agent",
    response_path: "output",
    created_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

// ScheduleWizard renders the shared <Field>/<ModulesEditor>, which read the
// next-intl catalog, so renders need a provider (real English catalog).
function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

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
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
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
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
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
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
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
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent('Give Module "system" a seed prompt.');
  });
});

describe("ScheduleWizard — Managed Agent (#294)", () => {
  it("paid Team: creates a managed connection inline from the Paste-a-prompt mode", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.type(screen.getByLabelText("Name"), "Nightly managed eval");
    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System

    // Switch to the managed "Paste a prompt" type — it collects a prompt + target model, no
    // endpoint / connection name / Modules.
    await user.click(screen.getByRole("button", { name: "Managed agent" }));
    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Target model")).toHaveValue("claude-haiku-4-5-20251001");
    await user.type(screen.getByLabelText("Prompt"), "You are a helpful support agent.");

    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.type(screen.getByPlaceholderText("User input…"), "How do I reset my password?");
    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    // Review summarizes the managed System as "Prompt (managed, <model>)".
    expect(screen.getByText("Prompt (managed, Haiku 4.5)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.newConnection).toEqual({
      type: "managed_agent",
      targetModel: "claude-haiku-4-5-20251001",
      prompt: "You are a helpful support agent.",
    });
    // The managed inline payload must satisfy the server action's contract.
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("Free Team: the managed type is disabled with an upgrade CTA", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={false} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.type(screen.getByLabelText("Name"), "Nightly eval");
    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System

    expect(screen.getByRole("button", { name: "Managed agent" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Upgrade your plan" })).toHaveAttribute("href", "/pricing");
  });

  it("Free Team: an existing managed connection is listed but disabled in the picker", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard
        rubrics={RUBRICS}
        connections={[
          conn({ id: "c-ext", name: "External agent" }),
          conn({ id: "c-managed", name: "Managed prompt", provider: "anthropic", agent_kind: "managed", endpoint: "" }),
        ]}
        managedAllowed={false}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText("Name"), "Nightly eval");
    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System

    // The managed Connection is listed but unselectable; the external agent stays selectable, and
    // the upgrade CTA explains the gate.
    expect(screen.getByRole("option", { name: "Managed prompt — managed agent" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "External agent — live agent" })).not.toBeDisabled();
    expect(screen.getByRole("link", { name: "Upgrade your plan" })).toBeInTheDocument();
  });

  it("Free Team whose only connection is managed: skips the dead 'Use existing' tab", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard
        rubrics={RUBRICS}
        connections={[conn({ id: "c-managed", name: "Managed prompt", provider: "anthropic", agent_kind: "managed", endpoint: "" })]}
        managedAllowed={false}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText("Name"), "Nightly eval");
    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System

    // No selectable existing Connection → the existing/new toggle is hidden and the wizard opens
    // straight onto the create flow (with the managed type disabled).
    expect(screen.queryByRole("button", { name: "Use existing" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Managed agent" })).toBeDisabled();
  });
});
