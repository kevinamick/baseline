// @vitest-environment jsdom
import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import enMessages from "../../../../../../messages/en.json";
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

// The System step's dataset "Test query" preview (DatasetQueryPreview) imports this action,
// which pulls in server-only modules; stub it so the wizard renders in jsdom. Resolves to an
// empty result set (not undefined) so a test that actually clicks "Test query" doesn't crash
// DatasetQueryPreview's `"error" in result` check on an unresolved mock.
vi.mock("@/app/actions/connections", () => ({
  previewDatasetConnection: vi.fn().mockResolvedValue({ rows: [] }),
}));

const RUBRIC_ID = "11111111-1111-4111-8111-111111111111";
const RUBRICS: RubricSummary[] = [
  { id: RUBRIC_ID, name: "Helpfulness", evaluation_mode: "prompt_response", created_at: "2026-06-01T00:00:00Z" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ scheduleId: "sched-x" });
});

// Fill Basics and the new-agent-connection System step. With no existing connections the wizard
// opens on the create flow, where the managed "Paste a prompt" type is the default (#294) — so we
// switch to the live-agent type before filling its endpoint/name fields.
async function fillBasicsAndAgentSystem(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "Nightly eval");
  await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
  await user.click(screen.getByRole("button", { name: "Live agent" }));
  await user.type(screen.getByLabelText("Connection name"), "Support agent");
  await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/agent");
}

// Fill just the Basics step (name + the already-selected default rubric) and advance.
async function fillBasics(user: ReturnType<typeof userEvent.setup>, name = "Nightly eval") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
}

// Fill Basics + Agent System + one manual Inputs row, landing on Cadence.
async function advanceToCadence(user: ReturnType<typeof userEvent.setup>) {
  await fillBasicsAndAgentSystem(user);
  await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
  await user.type(screen.getByPlaceholderText("User input…"), "Hello?");
  await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
}

describe("ScheduleWizard — Basics validation (#390)", () => {
  it("requires a name before advancing past Basics", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the schedule a name.");
    // Still on Basics — the System step's connection-type picker isn't rendered.
    expect(screen.queryByLabelText("Connection name")).not.toBeInTheDocument();
  });

  it("requires a rubric to be selected when the Team has none", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={[]} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.type(screen.getByLabelText("Name"), "Nightly eval");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Select a rubric.");
  });

  // Long user-event flow; needs headroom when the full suite runs in parallel.
  it("fills the optional description and lets a different rubric be picked", { timeout: 15_000 }, async () => {
    const secondRubricId = "22222222-2222-4222-8222-222222222222";
    const rubrics: RubricSummary[] = [
      ...RUBRICS,
      { id: secondRubricId, name: "Accuracy", evaluation_mode: "prompt_response", created_at: "2026-06-01T00:00:00Z" },
    ];
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={rubrics} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await user.type(screen.getByLabelText("Name"), "Nightly eval");
    await user.type(screen.getByLabelText("Description", { exact: false }), "Checks the support agent nightly.");
    await user.selectOptions(screen.getByLabelText("Rubric"), secondRubricId);
    await user.click(screen.getByRole("button", { name: "Next" })); // Basics → System
    await user.click(screen.getByRole("button", { name: "Live agent" }));
    await user.type(screen.getByLabelText("Connection name"), "Support agent");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/agent");
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.type(screen.getByPlaceholderText("User input…"), "Hi");
    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    expect(screen.getByText("Checks the support agent nightly.")).toBeInTheDocument();
    expect(screen.getByText("Accuracy")).toBeInTheDocument();
  });
});

describe("ScheduleWizard — Inputs step tri-source (#390)", () => {
  it("requires at least one manual input row", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.click(screen.getByRole("button", { name: "Next" })); // blank manual row
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one input row.");
  });

  it("requires a CSV upload before advancing on the file source", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.click(screen.getByRole("button", { name: "CSV file" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Upload a CSV with a user_input column.");
  });

  it("loads a CSV and advances using the parsed rows", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.click(screen.getByRole("button", { name: "CSV file" }));

    const file = new File(["user_input\nHi there"], "instances.csv", { type: "text/csv" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => expect(screen.getByText("instances.csv")).toBeInTheDocument());
    expect(screen.getByText((_, el) => el?.textContent === "instances.csv — 1 input loaded")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("requires JSON text before advancing on the JSON source", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.click(screen.getByRole("button", { name: "JSON" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Paste a JSON array of instances.");
  });

  it("rejects invalid JSON text", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.click(screen.getByRole("button", { name: "JSON" }));
    await user.click(screen.getByLabelText("Instances JSON"));
    await user.paste("{not valid json");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Instances must be a valid JSON array of objects.");
  });

  it("rejects a JSON array with no usable instances", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.click(screen.getByRole("button", { name: "JSON" }));
    await user.click(screen.getByLabelText("Instances JSON"));
    await user.paste("[]");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No instances with a user_input were found.");
  });

  it("accepts a valid JSON array and reflects the parsed count on Review", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.click(screen.getByRole("button", { name: "JSON" }));
    await user.click(screen.getByLabelText("Instances JSON"));
    await user.paste('[{"user_input":"hi"},{"user_input":"there"}]');
    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    expect(screen.getByText("2 rows")).toBeInTheDocument();
  });

  it("re-validates Inputs at submit time if a breadcrumb jump reaches Review with a since-cleared row", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasicsAndAgentSystem(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.type(screen.getByPlaceholderText("User input…"), "Hi");
    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    // Breadcrumbs (unlike Next) don't re-run per-step validation, so a user can jump back to a
    // now-reachable step, invalidate it, then jump straight back to Review.
    await user.click(screen.getByRole("button", { name: "Go to Inputs step" }));
    await user.clear(screen.getByPlaceholderText("User input…"));
    await user.click(screen.getByRole("button", { name: "Go to Review step" }));

    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one input row.");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("ScheduleWizard — Cadence step (#390)", () => {
  it("weekly: requires at least one day and summarizes the selected days", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    await user.selectOptions(screen.getByLabelText("Frequency"), "weekly");

    // Default days are Mon–Fri (all pressed); untoggle them all to trigger the validation error.
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      await user.click(screen.getByRole("button", { name: day }));
    }
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick at least one day.");

    // Re-pick Wednesday only and advance to Review to check the cadence summary.
    await user.click(screen.getByRole("button", { name: "Wed" }));
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review
    expect(screen.getByText(/Weekly · Wed at 09:00/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.cadence).toMatchObject({ frequency: "weekly", daysOfWeek: [3], localHour: 9 });
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("monthly: lets the user pick a day of month and summarizes it", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    await user.selectOptions(screen.getByLabelText("Frequency"), "monthly");
    await user.selectOptions(screen.getByLabelText("Day of month"), "15");
    await user.selectOptions(screen.getByLabelText("Run at (local time)"), "14");
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review
    expect(screen.getByText(/Monthly · day 15 at 14:00/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.cadence).toMatchObject({ frequency: "monthly", dayOfMonth: 15, localHour: 14 });
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("hourly: hides the run-at-hour field and summarizes as 'Every hour'", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    await user.selectOptions(screen.getByLabelText("Frequency"), "hourly");
    expect(screen.queryByLabelText("Run at (local time)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review
    expect(screen.getByText("Every hour")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.cadence).toMatchObject({ frequency: "hourly", localHour: null });
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("lets the user change the timezone", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    const tzSelect = screen.getByLabelText("Timezone") as HTMLSelectElement;
    // "Europe/London" is always present in the IANA list Intl.supportedValuesOf returns,
    // regardless of the host machine's detected default zone (unlike "UTC", which some ICU
    // builds omit as a distinct zone id).
    await user.selectOptions(tzSelect, "Europe/London");
    expect(tzSelect).toHaveValue("Europe/London");
  });
});

describe("ScheduleWizard — dataset connections (#39, #390)", () => {
  it("PostHog data source: gates the Test-query preview on required fields and validates cadence sampling", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "PostHog data source" }));
    // Test-query is disabled until project id / api key / hogql are filled.
    expect(screen.getByRole("button", { name: "Test query" })).toBeDisabled();

    await user.type(screen.getByLabelText("Connection name"), "Web analytics");
    await user.type(screen.getByLabelText("Project id"), "12345");
    await user.type(screen.getByLabelText("Personal API key"), "phx_secret");
    await user.type(screen.getByLabelText("HogQL query"), "SELECT 1");

    const testQueryButton = screen.getByRole("button", { name: "Test query" });
    expect(testQueryButton).not.toBeDisabled();
    // Exercises the preview's buildSpec closure with the live PostHog fields.
    await user.click(testQueryButton);
    await screen.findByText(/matched no rows/);

    await user.click(screen.getByRole("button", { name: "Next" })); // System → Cadence (dataset skips Inputs)
    expect(screen.getByLabelText("Lookback window (minutes)")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Lookback window (minutes)"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Set a lookback window (minutes).");

    await user.type(screen.getByLabelText("Lookback window (minutes)"), "60");
    await user.clear(screen.getByLabelText("Max rows per run"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Set a maximum row count.");

    await user.type(screen.getByLabelText("Max rows per run"), "50");
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    expect(screen.getByText("Web analytics (PostHog · project 12345)")).toBeInTheDocument();
    expect(screen.getByText("Last 60 min · up to 50 rows")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.inputs).toEqual([]);
    expect(payload.windowMinutes).toBe(60);
    expect(payload.maxRows).toBe(50);
    expect(payload.newConnection).toMatchObject({ type: "posthog_dataset", name: "Web analytics" });
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("Custom data source: enables the Test-query preview once the endpoint is filled and submits", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Custom data source" }));
    expect(screen.getByRole("button", { name: "Test query" })).toBeDisabled();

    await user.type(screen.getByLabelText("Connection name"), "Logs API");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://api.example.com/logs");

    const testQueryButton = screen.getByRole("button", { name: "Test query" });
    expect(testQueryButton).not.toBeDisabled();
    // Exercises the preview's buildSpec closure with the live custom-endpoint fields.
    await user.click(testQueryButton);
    await screen.findByText(/matched no rows/);

    await user.click(screen.getByRole("button", { name: "Next" })); // System → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    expect(screen.getByText("Logs API (Custom data source)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.newConnection).toMatchObject({ type: "custom_dataset", name: "Logs API" });
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });
});

describe("ScheduleWizard — existing connection mode (#390)", () => {
  it("submits with an existing agent connection selected (no newConnection payload)", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard
        rubrics={RUBRICS}
        connections={[conn({ id: "33333333-3333-4333-8333-333333333333", name: "External agent" })]}
        managedAllowed={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await fillBasics(user);
    // Paid Teams default to "new"; switch to the existing tab.
    await user.click(screen.getByRole("button", { name: "Use existing" }));
    await user.selectOptions(
      screen.getByLabelText("System connection"),
      "33333333-3333-4333-8333-333333333333"
    );
    await user.click(screen.getByRole("button", { name: "Next" })); // System → Inputs
    await user.type(screen.getByPlaceholderText("User input…"), "Hi");
    await user.click(screen.getByRole("button", { name: "Next" })); // Inputs → Cadence
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    expect(screen.getByText("External agent")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create schedule" }));
    const payload = mockCreate.mock.calls[0][0];
    expect(payload.connectionId).toBe("33333333-3333-4333-8333-333333333333");
    expect(payload.newConnection).toBeNull();
    expect(CreateScheduleSchema.safeParse(payload).success).toBe(true);
  });

  it("an existing dataset connection skips the Inputs step and shows the sample-size Review row", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard
        rubrics={RUBRICS}
        connections={[conn({ id: "c-ds", name: "Web events", kind: "dataset", provider: "posthog" })]}
        managedAllowed={true}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    );

    await fillBasics(user);
    await user.click(screen.getByRole("button", { name: "Use existing" }));
    expect(screen.getByRole("option", { name: "Web events — data source (posthog)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" })); // System → Cadence (no Inputs step)
    expect(screen.getByLabelText("Lookback window (minutes)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    expect(screen.getByText("Web events")).toBeInTheDocument();
    expect(screen.getByText(/Last \d+ min · up to \d+ rows/)).toBeInTheDocument();
  });

  it("blocks selecting a disabled managed connection past a UI bypass, surfacing the paid-plan gate", async () => {
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

    await fillBasics(user);
    // A Free Team with a selectable Connection defaults straight to "existing".
    const select = screen.getByLabelText("System connection");
    // Programmatically select the disabled managed option — a real user can't via a native
    // select, but this exercises the belt-and-suspenders server-side-mirroring check.
    fireEvent.change(select, { target: { value: "c-managed" } });
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Managed agents are a paid-plan feature."
    );
  });
});

describe("ScheduleWizard — Notify step & submit outcomes (#390)", () => {
  it("adds a recipient tag and reflects it on Review; toggling Enabled off reflects on Review", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify

    // The "Recipients" label carries a trailing "· optional" suffix (rendered by the shared
    // <Field optional> wrapper), so match loosely rather than on the exact accessible name.
    await user.type(
      screen.getByLabelText("Notification recipients", { exact: false }),
      "alice@example.com{Enter}"
    );
    await user.click(screen.getByRole("switch", { name: "Enabled" }));

    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("shows '—' for recipients on Review when none were entered", async () => {
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review

    // Both the Rubric-not-selected "—" and the Recipients "—" would collide, so scope to the row.
    const recipientsRow = screen.getByText("Recipients").closest("div");
    expect(recipientsRow).toHaveTextContent("—");
  });

  it("surfaces a server-returned error on the Review step without closing the wizard", async () => {
    mockCreate.mockResolvedValue({ error: "That name is already taken." });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={onClose} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That name is already taken.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a generic error when the create action throws", async () => {
    mockCreate.mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(
      <ScheduleWizard rubrics={RUBRICS} connections={[]} managedAllowed={true} onClose={vi.fn()} onCreated={vi.fn()} />
    );

    await advanceToCadence(user);
    await user.click(screen.getByRole("button", { name: "Next" })); // Cadence → Notify
    await user.click(screen.getByRole("button", { name: "Next" })); // Notify → Review
    await user.click(screen.getByRole("button", { name: "Create schedule" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't create the schedule. Please try again.");
  });
});

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

    // Managed "Paste a prompt" is the default type for a paid Team (#294) — no click needed. It
    // collects a prompt + target model, no endpoint / connection name / Modules.
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
