// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../../messages/en.json";
import userEvent from "@testing-library/user-event";
import { ConnectionsList, type EditableConnection } from "./connections-list";
import {
  UpdateConnectionModulesSchema,
  NewConnectionSchema,
} from "@/lib/validation/schemas";

// ConnectionsList itself plus its Edit-Modules dialog (shared <ModulesEditor>/
// <Field>) read the next-intl catalog, so renders need a provider. Use RTL's
// `wrapper` so the returned `rerender` re-applies the provider too.
//
// `onError` rethrows on a missing message so a key the component calls that
// isn't in the catalog fails the render instead of silently rendering the key
// path as fallback text. This is the regression #363 fixes: the Add/Edit/Delete
// dialogs called Settings.connections(.create) keys absent from the catalogs.
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      timeZone="UTC"
      onError={(error) => {
        if (error.code === "MISSING_MESSAGE") throw error;
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
}
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: Wrapper });
}

const mockUpdate = vi.fn();
const mockUpdateManaged = vi.fn();
const mockCreate = vi.fn();
const mockGetDeletionImpact = vi.fn();
const mockDeleteConnection = vi.fn();
vi.mock("@/app/actions/connections", () => ({
  updateConnectionModules: (input: unknown) => mockUpdate(input),
  updateManagedConnection: (input: unknown) => mockUpdateManaged(input),
  createConnection: (input: unknown) => mockCreate(input),
  getConnectionDeletionImpact: (id: unknown) => mockGetDeletionImpact(id),
  deleteConnection: (id: unknown) => mockDeleteConnection(id),
}));

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function agentConnection(
  overrides: Partial<EditableConnection> = {},
): EditableConnection {
  return {
    id: AGENT_ID,
    name: "Support agent",
    kind: "agent",
    agentKind: "external",
    provider: "custom",
    endpoint: "https://api.example.com/agent",
    targetModel: null,
    requestTemplate: '{\n  "input": "{{user_input}}"\n}',
    modules: [],
    ...overrides,
  };
}

// A managed ("Paste a prompt") Connection: agent kind, no endpoint/template, one "prompt" Module.
function managedConnection(
  overrides: Partial<EditableConnection> = {},
): EditableConnection {
  return agentConnection({
    name: "Refund classifier",
    agentKind: "managed",
    provider: "anthropic",
    endpoint: "",
    targetModel: "claude-haiku-4-5-20251001",
    requestTemplate: "{}",
    modules: [{ name: "prompt", seed: "You classify refund requests." }],
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({ ok: true });
  mockUpdateManaged.mockResolvedValue({ ok: true });
  mockCreate.mockResolvedValue({ connectionId: "new-conn-id" });
  mockGetDeletionImpact.mockResolvedValue({
    name: "Support agent",
    schedules: 0,
    optimizationRuns: 0,
    blockReason: null,
  });
  mockDeleteConnection.mockResolvedValue({ ok: true });
});

describe("ConnectionsList — Edit Modules (#119)", () => {
  it("adds Modules to a connection that had none and saves the cleaned payload", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    // The list flags the unoptimizable agent.
    expect(
      screen.getByText("No Modules — not optimizable yet"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    // Shared editor: adding a Module injects {{prompt:system}} into the template.
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(
      screen.getByLabelText("Module 1 seed prompt"),
      "Answer helpfully.",
    );
    await user.click(screen.getByRole("button", { name: "Save Modules" }));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const payload = mockUpdate.mock.calls[0][0];
    expect(payload).toMatchObject({
      connectionId: AGENT_ID,
      modules: [{ name: "system", seed: "Answer helpfully." }],
    });
    expect(payload.requestTemplate).toContain("{{prompt:system}}");
    // Integration guard: the dialog's payload must satisfy the server action's contract.
    expect(UpdateConnectionModulesSchema.safeParse(payload).success).toBe(true);
    // On success the dialog closes and the page refreshes.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prefills existing Modules and blocks saving a declared↔referenced mismatch", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[
          agentConnection({
            requestTemplate:
              '{"input": "{{user_input}}", "system": "{{prompt:system}}"}',
            modules: [{ name: "system", seed: "Answer helpfully." }],
          }),
        ]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    expect(screen.getByLabelText("Module 1 name")).toHaveValue("system");
    expect(screen.getByLabelText("Module 1 seed prompt")).toHaveValue(
      "Answer helpfully.",
    );

    // Rename the Module away from the template's {{prompt:system}} reference.
    await user.clear(screen.getByLabelText("Module 1 name"));
    await user.type(screen.getByLabelText("Module 1 name"), "tone");
    await user.click(screen.getByRole("button", { name: "Save Modules" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      'Declared Module "tone"',
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("hides the edit affordance for dataset connections and read-only members", () => {
    const dataset: EditableConnection = {
      ...agentConnection({
        id: "33333333-3333-4333-8333-333333333333",
        name: "PostHog source",
      }),
      kind: "dataset",
      provider: "posthog",
    };
    const { rerender } = render(
      <ConnectionsList connections={[dataset]} canWrite managedAllowed />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit Modules" }),
    ).not.toBeInTheDocument();

    rerender(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite={false}
        managedAllowed
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit Modules" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a server error without closing the dialog", async () => {
    mockUpdate.mockResolvedValue({ error: "Connection not found" });
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Seed.");
    await user.click(screen.getByRole("button", { name: "Save Modules" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Connection not found");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("ConnectionsList — Edit prompt for a Managed Agent (#294)", () => {
  it("edits the prompt + target model and saves without the {{prompt:*}} cross-check", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[managedConnection()]}
        canWrite
        managedAllowed
      />,
    );

    // Managed rows get an "Edit prompt" button (not "Edit Modules"), and the row reads as managed.
    expect(screen.getByText("Managed agent")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Modules" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit prompt" }));

    // The dialog edits a prompt + target model — no request template / Modules editor.
    const promptBox = screen.getByLabelText("Prompt");
    expect(promptBox).toHaveValue("You classify refund requests.");
    expect(
      screen.queryByLabelText(/request template/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't referenced/)).not.toBeInTheDocument();

    await user.clear(promptBox);
    await user.type(promptBox, "You triage refund requests by urgency.");
    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    expect(mockUpdateManaged).toHaveBeenCalledTimes(1);
    expect(mockUpdateManaged.mock.calls[0][0]).toEqual({
      connectionId: AGENT_ID,
      prompt: "You triage refund requests by urgency.",
      targetModel: "claude-haiku-4-5-20251001",
    });
    expect(mockUpdate).not.toHaveBeenCalled(); // never routes through the Modules path
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("blocks saving an empty prompt", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[
          managedConnection({ modules: [{ name: "prompt", seed: "" }] }),
        ]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit prompt" }));
    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a prompt.");
    expect(mockUpdateManaged).not.toHaveBeenCalled();
  });
});

describe("ConnectionsList — Add Connection (#353)", () => {
  it("renders an Add connection button that opens the create dialog", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    const btn = screen.getByRole("button", { name: /Add connection/i });
    expect(btn).toBeInTheDocument();

    await user.click(btn);
    // The dialog is open with the connection-type picker and the managed-agent fields
    // (managedAllowed → managed is the default type).
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Connection type")).toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    // The dialog chrome resolves real labels, not raw key paths (#363): the footer
    // Cancel button and the header Close-dialog control both came from create-scope
    // keys that were missing from every catalog.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close dialog" }),
    ).toBeInTheDocument();
  });

  it("hides the Add connection button for read-only members", () => {
    render(
      <ConnectionsList connections={[]} canWrite={false} managedAllowed />,
    );
    expect(
      screen.queryByRole("button", { name: /Add connection/i }),
    ).not.toBeInTheDocument();
  });

  it("creates a managed agent connection and refreshes on success", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    const promptBox = screen.getByLabelText("Prompt");
    await user.type(promptBox, "You classify refund requests.");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][0];
    expect(payload).toMatchObject({
      type: "managed_agent",
      prompt: "You classify refund requests.",
    });
    // Integration guard: the payload must satisfy the server action's contract.
    expect(NewConnectionSchema.safeParse(payload).success).toBe(true);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("switches to the live-agent type and creates an external agent connection", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    await user.click(screen.getByRole("button", { name: "Live agent" }));

    await user.type(screen.getByLabelText("Connection name"), "Support agent");
    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://api.example.com/agent",
    );
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][0];
    expect(payload).toMatchObject({
      type: "agent",
      name: "Support agent",
      endpoint: "https://api.example.com/agent",
    });
    expect(NewConnectionSchema.safeParse(payload).success).toBe(true);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("blocks submission with a validation error and keeps the dialog open", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    // Managed is the default — submit with an empty prompt.
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a prompt to run.",
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("surfaces a server error without closing the dialog", async () => {
    mockCreate.mockResolvedValue({ error: "Failed to save connection" });
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    await user.type(screen.getByLabelText("Prompt"), "A valid prompt.");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to save connection",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("renders the PostHog data-source branch labels (#363 key coverage)", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    await user.click(
      screen.getByRole("button", { name: "PostHog data source" }),
    );

    expect(screen.getByText("HogQL query")).toBeInTheDocument();
    expect(screen.getByText("Project id")).toBeInTheDocument();
    expect(screen.getByText("PostHog host")).toBeInTheDocument();
  });

  it("renders the custom data-source branch labels (#363 key coverage)", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    await user.click(
      screen.getByRole("button", { name: "Custom data source" }),
    );

    expect(screen.getByText("Rows path")).toBeInTheDocument();
    expect(
      screen.getByText("Query params template (JSON)"),
    ).toBeInTheDocument();
    expect(screen.getByText("user_input path")).toBeInTheDocument();
    expect(screen.getByText("agent_output path")).toBeInTheDocument();
  });

  it("disables the managed-agent type on Free plans with an upgrade note", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionsList connections={[]} canWrite managedAllowed={false} />,
    );

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    // Free plan: managed pill is disabled, and the upgrade CTA is shown.
    const managedPill = screen.getByRole("button", { name: "Managed agent" });
    expect(managedPill).toBeDisabled();
    expect(screen.getByText(/Upgrade your plan/i)).toBeInTheDocument();
    // The default type falls back to "Live agent" on Free.
    expect(screen.getByLabelText("Connection name")).toBeInTheDocument();
  });

  it("closes the create dialog via Cancel without creating (empty list)", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("opens, closes, and successfully creates from a list that already has connections", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    // Open then dismiss via the header close control — exercises the non-empty-list branch's
    // onClose wiring (distinct from the empty-list branch already covered above).
    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();

    // Reopen and create successfully — exercises the non-empty-list branch's onCreated wiring.
    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    await user.type(screen.getByLabelText("Prompt"), "A brand new prompt.");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("surfaces a thrown error from the create call without closing the dialog", async () => {
    mockCreate.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(<ConnectionsList connections={[]} canWrite managedAllowed />);

    await user.click(screen.getByRole("button", { name: /Add connection/i }));
    await user.type(screen.getByLabelText("Prompt"), "A valid prompt.");
    await user.click(screen.getByRole("button", { name: "Create connection" }));

    expect(
      await screen.findByText("Couldn't create the connection. Please try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("ConnectionsList — Edit Modules error paths", () => {
  it("blocks saving an invalid JSON request template", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    const template = screen.getByLabelText("Request body template (JSON)");
    await user.clear(template);
    // userEvent.type treats "{" as a special-key escape, so double it for a literal brace.
    await user.type(template, "{{ not valid json");
    await user.click(screen.getByRole("button", { name: "Save Modules" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Request template must be valid JSON.",
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("surfaces a thrown error from the save call without closing the dialog", async () => {
    mockUpdate.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Seed.");
    await user.click(screen.getByRole("button", { name: "Save Modules" }));

    expect(
      await screen.findByText("Couldn't save the connection. Please try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("ConnectionsList — Edit prompt error paths (#294)", () => {
  it("surfaces a thrown error from the save call without closing the dialog", async () => {
    mockUpdateManaged.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[managedConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit prompt" }));
    await user.click(screen.getByRole("button", { name: "Save prompt" }));

    expect(
      await screen.findByText("Couldn't save the connection. Please try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("ConnectionsList — Delete Connection (#225)", () => {
  it("loads impact, warns about cascading deletes, and deletes on a two-press confirm", async () => {
    // Hold the impact check open so the "Checking…" state is observable before it resolves.
    let resolveImpact!: (value: {
      name: string;
      schedules: number;
      optimizationRuns: number;
      blockReason: string | null;
    }) => void;
    mockGetDeletionImpact.mockReturnValue(
      new Promise((resolve) => {
        resolveImpact = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Support agent" }),
    );
    expect(
      screen.getByText("Checking what depends on this connection…"),
    ).toBeInTheDocument();

    resolveImpact({
      name: "Support agent",
      schedules: 2,
      optimizationRuns: 1,
      blockReason: null,
    });

    // Cascading-dependents phrasing joins both counted kinds once the impact check resolves.
    expect(
      await screen.findByText(
        /This also deletes 2 schedules and 1 past optimization run\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This action cannot be undone."),
    ).toBeInTheDocument();

    // First press escalates the button copy; the delete call only fires on the second press.
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    await user.click(deleteBtn);
    expect(
      screen.getByRole("button", { name: "Delete forever?" }),
    ).toBeInTheDocument();
    expect(mockDeleteConnection).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete forever?" }));

    expect(mockDeleteConnection).toHaveBeenCalledWith(AGENT_ID);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Delete connection")).not.toBeInTheDocument();
  });

  it("phrases a schedules-only dependency count", async () => {
    mockGetDeletionImpact.mockResolvedValue({
      name: "Support agent",
      schedules: 1,
      optimizationRuns: 0,
      blockReason: null,
    });
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Support agent" }),
    );
    expect(
      await screen.findByText("This also deletes 1 schedule."),
    ).toBeInTheDocument();
  });

  it("blocks deletion when something depends on it live", async () => {
    mockGetDeletionImpact.mockResolvedValue({
      name: "Support agent",
      schedules: 0,
      optimizationRuns: 1,
      blockReason:
        "An optimization run is currently using this connection — wait for it to finish before deleting.",
    });
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Support agent" }),
    );
    expect(
      await screen.findByText(
        "An optimization run is currently using this connection — wait for it to finish before deleting.",
      ),
    ).toBeInTheDocument();
    // Blocked state offers only a way out, never a delete affordance. (Exact match: the row's
    // own trash-icon button has the longer aria-label "Delete Support agent".)
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete forever?" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Delete connection")).not.toBeInTheDocument();
    expect(mockDeleteConnection).not.toHaveBeenCalled();
  });

  it("surfaces a failure checking dependencies and still allows closing", async () => {
    mockGetDeletionImpact.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Support agent" }),
    );
    expect(
      await screen.findByText(
        "Couldn't check connection dependencies. Please try again.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete connection")).not.toBeInTheDocument();
  });

  it("surfaces the impact check's own reported error", async () => {
    mockGetDeletionImpact.mockResolvedValue({ error: "Connection not found" });
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Support agent" }),
    );
    expect(
      await screen.findByText("Connection not found"),
    ).toBeInTheDocument();
  });

  it("resets to a single press and surfaces the error when the delete call resolves an error", async () => {
    mockDeleteConnection.mockResolvedValue({
      error: "Something else is using it now",
    });
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Support agent" }),
    );
    await screen.findByText("This action cannot be undone.");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete forever?" }));

    expect(
      await screen.findByText("Something else is using it now"),
    ).toBeInTheDocument();
    // The escalation resets — a stale server error shouldn't leave the button armed.
    expect(
      screen.getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Delete connection")).toBeInTheDocument();
  });

  it("surfaces a generic failure message when the delete call throws", async () => {
    mockDeleteConnection.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(
      <ConnectionsList
        connections={[agentConnection()]}
        canWrite
        managedAllowed
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Support agent" }),
    );
    await screen.findByText("This action cannot be undone.");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete forever?" }));

    expect(
      await screen.findByText("Couldn't delete the connection. Please try again."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
  });
});
