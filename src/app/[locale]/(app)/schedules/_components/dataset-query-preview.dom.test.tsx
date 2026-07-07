// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PreviewResult } from "@/lib/connections/preview-types";
import type { DatasetPreviewInput } from "@/lib/validation/schemas";

// The component calls the server action; mock it so the DOM test stays client-side.
const previewDatasetConnection = vi.fn<(i: DatasetPreviewInput) => Promise<PreviewResult>>();
vi.mock("@/app/actions/connections", () => ({
  previewDatasetConnection: (i: DatasetPreviewInput) => previewDatasetConnection(i),
}));

// Minimal next-intl stub: return a readable label per key + interpolated values, so assertions
// read against stable text without loading the real catalog.
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key;
    return t;
  },
}));

import { DatasetQueryPreview } from "./dataset-query-preview";

const SPEC: DatasetPreviewInput = {
  type: "posthog_dataset",
  host: "https://us.posthog.com",
  projectId: "12345",
  apiKey: "phx_secret",
  hogql: "SELECT 1",
};

beforeEach(() => {
  previewDatasetConnection.mockReset();
});

describe("DatasetQueryPreview", () => {
  it("disables the button when required fields are missing", () => {
    render(<DatasetQueryPreview buildSpec={() => SPEC} disabled />);
    expect(screen.getByRole("button", { name: "button" })).toBeDisabled();
  });

  it("renders the mapped sample rows on a successful preview", async () => {
    previewDatasetConnection.mockResolvedValue({
      rows: [
        {
          user_input: "what is the capital of France?",
          agent_output: "Paris",
          expected_output: null,
          retrieval_context: null,
        },
      ],
    });
    const user = userEvent.setup();
    render(<DatasetQueryPreview buildSpec={() => SPEC} disabled={false} />);

    await user.click(screen.getByRole("button", { name: "button" }));

    // The four field columns Baseline maps into are shown as headers.
    expect(screen.getByText("user_input")).toBeInTheDocument();
    expect(screen.getByText("agent_output")).toBeInTheDocument();
    expect(screen.getByText("expected_output")).toBeInTheDocument();
    expect(screen.getByText("retrieval_context")).toBeInTheDocument();
    // The mapped values render.
    expect(screen.getByText("what is the capital of France?")).toBeInTheDocument();
    expect(screen.getByText("Paris")).toBeInTheDocument();
    expect(previewDatasetConnection).toHaveBeenCalledWith(SPEC);
  });

  it("surfaces a categorized auth error with the raw detail", async () => {
    previewDatasetConnection.mockResolvedValue({
      error: "auth",
      detail: "PostHog query returned HTTP 401",
    });
    const user = userEvent.setup();
    render(<DatasetQueryPreview buildSpec={() => SPEC} disabled={false} />);

    await user.click(screen.getByRole("button", { name: "button" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("error.auth");
    expect(screen.getByText("PostHog query returned HTTP 401")).toBeInTheDocument();
  });

  it("warns when rows return but nothing maps into the required fields", async () => {
    previewDatasetConnection.mockResolvedValue({
      rows: [
        { user_input: "", agent_output: "", expected_output: null, retrieval_context: null },
      ],
      warning: "no_columns_mapped",
    });
    const user = userEvent.setup();
    render(<DatasetQueryPreview buildSpec={() => SPEC} disabled={false} />);

    await user.click(screen.getByRole("button", { name: "button" }));

    expect(await screen.findByText("warning.no_columns_mapped")).toBeInTheDocument();
  });
});
