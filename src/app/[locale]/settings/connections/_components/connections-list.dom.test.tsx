// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../messages/en.json";
import userEvent from "@testing-library/user-event";
import { ConnectionsList, type EditableConnection } from "./connections-list";
import { UpdateConnectionModulesSchema } from "@/lib/validation/schemas";

// ConnectionsList's Edit-Modules dialog renders the shared <ModulesEditor>/<Field>,
// which read the next-intl catalog, so renders need a provider.
function render(ui: ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
}

const mockUpdate = vi.fn();
vi.mock("@/app/actions/connections", () => ({
  updateConnectionModules: (input: unknown) => mockUpdate(input),
}));

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function agentConnection(overrides: Partial<EditableConnection> = {}): EditableConnection {
  return {
    id: AGENT_ID,
    name: "Support agent",
    kind: "agent",
    provider: "custom",
    endpoint: "https://api.example.com/agent",
    requestTemplate: '{\n  "input": "{{user_input}}"\n}',
    modules: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockResolvedValue({ ok: true });
});

describe("ConnectionsList — Edit Modules (#119)", () => {
  it("adds Modules to a connection that had none and saves the cleaned payload", async () => {
    const user = userEvent.setup();
    render(<ConnectionsList connections={[agentConnection()]} canWrite />);

    // The list flags the unoptimizable agent.
    expect(screen.getByText("No Modules — not optimizable yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    // Shared editor: adding a Module injects {{prompt:system}} into the template.
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Answer helpfully.");
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
            requestTemplate: '{"input": "{{user_input}}", "system": "{{prompt:system}}"}',
            modules: [{ name: "system", seed: "Answer helpfully." }],
          }),
        ]}
        canWrite
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    expect(screen.getByLabelText("Module 1 name")).toHaveValue("system");
    expect(screen.getByLabelText("Module 1 seed prompt")).toHaveValue("Answer helpfully.");

    // Rename the Module away from the template's {{prompt:system}} reference.
    await user.clear(screen.getByLabelText("Module 1 name"));
    await user.type(screen.getByLabelText("Module 1 name"), "tone");
    await user.click(screen.getByRole("button", { name: "Save Modules" }));

    expect(screen.getByRole("alert")).toHaveTextContent('Declared Module "tone"');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("hides the edit affordance for dataset connections and read-only members", () => {
    const dataset: EditableConnection = {
      ...agentConnection({ id: "33333333-3333-4333-8333-333333333333", name: "PostHog source" }),
      kind: "dataset",
      provider: "posthog",
    };
    const { rerender } = render(<ConnectionsList connections={[dataset]} canWrite />);
    expect(screen.queryByRole("button", { name: "Edit Modules" })).not.toBeInTheDocument();

    rerender(<ConnectionsList connections={[agentConnection()]} canWrite={false} />);
    expect(screen.queryByRole("button", { name: "Edit Modules" })).not.toBeInTheDocument();
  });

  it("surfaces a server error without closing the dialog", async () => {
    mockUpdate.mockResolvedValue({ error: "Connection not found" });
    const user = userEvent.setup();
    render(<ConnectionsList connections={[agentConnection()]} canWrite />);

    await user.click(screen.getByRole("button", { name: "Edit Modules" }));
    await user.click(screen.getByRole("button", { name: "+ Add Module" }));
    await user.type(screen.getByLabelText("Module 1 seed prompt"), "Seed.");
    await user.click(screen.getByRole("button", { name: "Save Modules" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Connection not found");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
