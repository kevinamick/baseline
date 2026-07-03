// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../messages/en.json";
import { ConnectionFields } from "./connection-fields";
import { useConnectionDraft } from "./use-connection-draft";
import type { ConnectionDraft } from "./draft";
import { CONN_TYPE } from "@/lib/connections/wizard-constants";

// ConnectionFields reads next-intl's "Connections.fields" catalog (plus "ManagedAgent"/
// "Modules"/"Common" via the child components it composes), so renders need a provider.
// onError rethrows on a missing message, matching connections-list.dom.test.tsx's pattern,
// so a key this shared component calls that's absent from the catalog fails the render
// instead of silently rendering the raw key path.
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

// A tiny harness wiring the real useConnectionDraft hook to ConnectionFields — the same
// shape every host (schedule wizard, Add Connection dialog, optimization wizard) drives it
// with. Exposes onClearError as a spy and the live draft via a ref-less getter so tests can
// assert on the propagated state, not just the rendered DOM.
function Harness({
  init,
  managedAllowed = true,
  showTypePicker = true,
  requireModules = false,
  onClearError,
  onDraft,
}: {
  init?: Partial<ConnectionDraft>;
  managedAllowed?: boolean;
  showTypePicker?: boolean;
  requireModules?: boolean;
  onClearError?: () => void;
  onDraft?: (draft: ConnectionDraft) => void;
}) {
  const hook = useConnectionDraft(init);
  onDraft?.(hook.draft);
  return (
    <ConnectionFields
      hook={hook}
      managedAllowed={managedAllowed}
      idPrefix="test"
      showTypePicker={showTypePicker}
      requireModules={requireModules}
      onClearError={onClearError}
    />
  );
}

describe("ConnectionFields — type picker", () => {
  it("defaults to the live-agent fields with all four pills rendered", () => {
    render(<Harness />);

    const group = screen.getByRole("group", { name: "Connection type" });
    expect(group).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Managed agent" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Live agent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "PostHog data source" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Custom data source" }),
    ).toBeInTheDocument();

    // Live-agent field set.
    expect(screen.getByLabelText("Connection name")).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Auth header/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Auth value/)).toBeInTheDocument();
    expect(screen.getByLabelText("Response path")).toBeInTheDocument();
  });

  it("hides the picker and renders only the seeded type's fields when showTypePicker is false", () => {
    render(
      <Harness
        showTypePicker={false}
        init={{ connType: CONN_TYPE.managedAgent }}
      />,
    );

    expect(
      screen.queryByRole("group", { name: "Connection type" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
  });

  it("clicking a pill switches the rendered field set and calls onClearError", async () => {
    const user = userEvent.setup();
    const onClearError = vi.fn();
    render(<Harness onClearError={onClearError} />);

    await user.click(screen.getByRole("button", { name: "PostHog data source" }));

    expect(onClearError).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("PostHog host")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Connection name"),
    ).toBeInTheDocument(); // PostHog dataset still names the connection
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
  });

  it("disables the managed pill and shows the upgrade note when managedAllowed is false", () => {
    render(<Harness managedAllowed={false} />);

    const managedPill = screen.getByRole("button", { name: "Managed agent" });
    expect(managedPill).toBeDisabled();
    expect(managedPill).toHaveAttribute(
      "title",
      "Managed agents are a paid-plan feature",
    );
    expect(screen.getByText(/Upgrade your plan/i)).toBeInTheDocument();
  });

  it("does not show the upgrade note when managed is allowed", () => {
    render(<Harness managedAllowed />);
    expect(screen.queryByText(/Upgrade your plan/i)).not.toBeInTheDocument();
  });
});

describe("ConnectionFields — managed agent fields", () => {
  it("renders prompt + target model and omits the connection-name field", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Managed agent" }));

    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Prompt")).toBeInTheDocument();
    expect(screen.getByLabelText("Target model")).toBeInTheDocument();
    // No auth/endpoint chrome for a managed agent.
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Auth header/)).not.toBeInTheDocument();
  });

  it("propagates typed prompt text back into the draft", async () => {
    const user = userEvent.setup();
    let latest: ConnectionDraft | undefined;
    render(
      <Harness
        init={{ connType: CONN_TYPE.managedAgent }}
        showTypePicker={false}
        onDraft={(d) => {
          latest = d;
        }}
      />,
    );

    const promptBox = screen.getByLabelText("Prompt");
    await user.type(promptBox, "Classify refunds.");

    expect(promptBox).toHaveValue("Classify refunds.");
    expect(latest?.managedPrompt).toBe("Classify refunds.");
  });

  it("propagates the selected target model back into the draft", async () => {
    const user = userEvent.setup();
    let latest: ConnectionDraft | undefined;
    render(
      <Harness
        init={{ connType: CONN_TYPE.managedAgent }}
        showTypePicker={false}
        onDraft={(d) => {
          latest = d;
        }}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Target model"), "claude-opus-4-8");

    expect(latest?.managedTargetModel).toBe("claude-opus-4-8");
  });
});

describe("ConnectionFields — PostHog dataset fields", () => {
  function renderPosthog(overrides: Partial<ConnectionDraft> = {}) {
    return render(
      <Harness
        showTypePicker={false}
        init={{ connType: CONN_TYPE.posthogDataset, ...overrides }}
      />,
    );
  }

  it("renders the host/project/key/HogQL fields with the API key masked", () => {
    renderPosthog();

    expect(screen.getByLabelText("PostHog host")).toBeInTheDocument();
    expect(screen.getByLabelText("Project id")).toBeInTheDocument();
    const apiKey = screen.getByLabelText("Personal API key");
    expect(apiKey).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("HogQL query")).toBeInTheDocument();
  });

  it("propagates changes to each PostHog field into the draft", async () => {
    const user = userEvent.setup();
    let latest: ConnectionDraft | undefined;
    render(
      <Harness
        showTypePicker={false}
        init={{ connType: CONN_TYPE.posthogDataset }}
        onDraft={(d) => {
          latest = d;
        }}
      />,
    );

    const hostInput = screen.getByLabelText("PostHog host");
    await user.clear(hostInput);
    await user.type(hostInput, "https://eu.posthog.com");
    await user.type(screen.getByLabelText("Project id"), "12345");
    await user.type(screen.getByLabelText("Personal API key"), "phx_secret");
    await user.type(screen.getByLabelText("HogQL query"), "SELECT 1");

    expect(latest?.phHost).toBe("https://eu.posthog.com");
    expect(latest?.phProjectId).toBe("12345");
    expect(latest?.phApiKey).toBe("phx_secret");
    expect(latest?.phHogql).toBe("SELECT 1");
  });
});

describe("ConnectionFields — custom dataset fields", () => {
  it("renders endpoint, auth, query template, rows path, and field-map inputs", () => {
    render(
      <Harness
        showTypePicker={false}
        init={{ connType: CONN_TYPE.customDataset }}
      />,
    );

    expect(screen.getByLabelText("Connection name")).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Auth header/)).toBeInTheDocument();
    const authValue = screen.getByLabelText(/^Auth value/);
    expect(authValue).toHaveAttribute("type", "password");
    expect(
      screen.getByLabelText("Query params template (JSON)"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Rows path")).toBeInTheDocument();
    expect(screen.getByLabelText("user_input path")).toBeInTheDocument();
    expect(screen.getByLabelText("agent_output path")).toBeInTheDocument();
    // No Modules editor or managed prompt for a dataset connection.
    expect(screen.queryByText("Modules")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Prompt")).not.toBeInTheDocument();
  });

  it("propagates a typed endpoint and field-map values into the draft", async () => {
    const user = userEvent.setup();
    let latest: ConnectionDraft | undefined;
    render(
      <Harness
        showTypePicker={false}
        init={{ connType: CONN_TYPE.customDataset }}
        onDraft={(d) => {
          latest = d;
        }}
      />,
    );

    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://api.example.com/logs",
    );
    await user.clear(screen.getByLabelText(/^Auth header/));
    await user.type(screen.getByLabelText(/^Auth header/), "X-Api-Key");
    await user.type(screen.getByLabelText(/^Auth value/), "secret-value");
    await user.type(
      screen.getByLabelText("Query params template (JSON)"),
      "x",
    );
    await user.clear(screen.getByLabelText("Rows path"));
    await user.type(screen.getByLabelText("Rows path"), "data.items");
    await user.clear(screen.getByLabelText("user_input path"));
    await user.type(screen.getByLabelText("user_input path"), "prompt");
    await user.clear(screen.getByLabelText("agent_output path"));
    await user.type(screen.getByLabelText("agent_output path"), "completion");

    expect(latest?.endpoint).toBe("https://api.example.com/logs");
    expect(latest?.authHeader).toBe("X-Api-Key");
    expect(latest?.authValue).toBe("secret-value");
    expect(latest?.requestTemplate).toContain("x");
    expect(latest?.responsePath).toBe("data.items");
    expect(latest?.mapUserInput).toBe("prompt");
    expect(latest?.mapAgentOutput).toBe("completion");
  });
});

describe("ConnectionFields — live agent fields", () => {
  it("renders the endpoint/auth/Modules-editor/response-path field set", () => {
    render(<Harness />);

    expect(screen.getByLabelText("Connection name")).toBeInTheDocument();
    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    const authValue = screen.getByLabelText(/^Auth value/);
    expect(authValue).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Response path")).toBeInTheDocument();
    // The shared Modules editor renders its own "Modules" section for agents only.
    expect(screen.getByText("Modules")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ Add Module" }),
    ).toBeInTheDocument();
  });

  it("propagates typed name/endpoint/auth values into the draft", async () => {
    const user = userEvent.setup();
    let latest: ConnectionDraft | undefined;
    render(
      <Harness
        onDraft={(d) => {
          latest = d;
        }}
      />,
    );

    await user.type(screen.getByLabelText("Connection name"), "Support agent");
    await user.type(
      screen.getByLabelText("Endpoint URL"),
      "https://api.example.com/agent",
    );
    await user.clear(screen.getByLabelText(/^Auth header/));
    await user.type(screen.getByLabelText(/^Auth header/), "X-Api-Key");
    await user.type(screen.getByLabelText(/^Auth value/), "Bearer sk-test");
    await user.clear(screen.getByLabelText("Response path"));
    await user.type(screen.getByLabelText("Response path"), "choices.0.text");

    expect(latest?.connName).toBe("Support agent");
    expect(latest?.endpoint).toBe("https://api.example.com/agent");
    expect(latest?.authHeader).toBe("X-Api-Key");
    expect(latest?.authValue).toBe("Bearer sk-test");
    expect(latest?.responsePath).toBe("choices.0.text");
  });

  it("adding a Module updates the request template through the shared editor", async () => {
    const user = userEvent.setup();
    let latest: ConnectionDraft | undefined;
    render(
      <Harness
        onDraft={(d) => {
          latest = d;
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "+ Add Module" }));

    expect(latest?.modules).toHaveLength(1);
    expect(latest?.requestTemplate).toContain("{{prompt:system}}");
  });
});
