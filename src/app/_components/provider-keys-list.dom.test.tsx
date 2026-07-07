// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderKeysList } from "./provider-keys-list";
import type { ProviderKeyRow } from "@/lib/llm/keys";

const mockSave = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/app/actions/provider-keys", () => ({
  saveProviderKey: (input: { provider: string; key: string }) => mockSave(input),
  deleteProviderKey: (input: { provider: string }) => mockDelete(input),
}));

const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

function anthropicRow(overrides: Partial<ProviderKeyRow> = {}): ProviderKeyRow {
  return {
    provider: "anthropic",
    label: "Anthropic",
    runtimeReady: true,
    last4: null,
    hasKey: false,
    updatedAt: null,
    ...overrides,
  };
}

describe("ProviderKeysList — SetKeyDialog (#343 Enter to submit, #342 validation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits the key when Enter is pressed in the input (#343)", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue({ last4: "1234" });
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    const input = screen.getByPlaceholderText(/Paste your Anthropic API key/i);
    await user.type(input, "sk-ant-api03-test1234567890test1234567890{Enter}");

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith({
      provider: "anthropic",
      key: "sk-ant-api03-test1234567890test1234567890",
    });
  });

  it("surfaces a validation error returned by the server action (#342)", async () => {
    const user = userEvent.setup();
    // The real saveProviderKey delegates to upsertProviderKey, which validates the
    // key format. Simulate that rejection here — the dialog must surface it inline.
    mockSave.mockResolvedValue({
      error: "That doesn't look like a valid Anthropic API key — Anthropic keys start with \"sk-ant-\". Check that you copied the right key.",
    });
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    const input = screen.getByPlaceholderText(/Paste your Anthropic API key/i);
    await user.type(input, "fake-key-that-is-long-enough-to-pass-length-check{Enter}");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Anthropic");
    expect(alert).toHaveTextContent("sk-ant-");
  });

  it("saves on button click (regression)", async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue({ last4: "1234" });
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    const input = screen.getByPlaceholderText(/Paste your Anthropic API key/i);
    await user.type(input, "sk-ant-api03-test1234567890test1234567890");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(mockSave).toHaveBeenCalledTimes(1);
  });
});

describe("ProviderKeysList — row rendering variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a 'Coming soon' badge and the masked key for a not-yet-wired provider with a stored key", () => {
    const row = anthropicRow({
      provider: "mistral",
      label: "Mistral",
      runtimeReady: false,
      hasKey: true,
      last4: "9abc",
    });
    const { container } = render(<ProviderKeysList rows={[row]} canWrite={true} />);

    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(container.textContent).toContain("Key set");
    expect(container.textContent).toContain("9abc");
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("hides Add/Replace/Remove controls entirely for a read-only member (canWrite=false)", () => {
    render(
      <ProviderKeysList rows={[anthropicRow({ hasKey: true, last4: "1234" })]} canWrite={false} />
    );

    expect(screen.queryByRole("button", { name: "Add key" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("shows 'No key set' with an 'Add key' button and no Remove control when there's no stored key", () => {
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    expect(screen.getByText("No key set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});

describe("ProviderKeysList — remove key flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens a confirm dialog on Remove, and Cancel dismisses it without deleting", async () => {
    const user = userEvent.setup();
    render(
      <ProviderKeysList rows={[anthropicRow({ hasKey: true, last4: "1234" })]} canWrite={true} />
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Remove Anthropic key?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes the key and refreshes the route on confirm (success)", async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValue({});
    render(
      <ProviderKeysList rows={[anthropicRow({ hasKey: true, last4: "1234" })]} canWrite={true} />
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(mockDelete).toHaveBeenCalledWith({ provider: "anthropic" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("surfaces a server-returned error inline and keeps the dialog open", async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValue({ error: "Failed to remove the provider key" });
    render(
      <ProviderKeysList rows={[anthropicRow({ hasKey: true, last4: "1234" })]} canWrite={true} />
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(await screen.findByText("Failed to remove the provider key")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("falls back to a generic error message when the delete action throws", async () => {
    const user = userEvent.setup();
    mockDelete.mockRejectedValue(new Error("network down"));
    render(
      <ProviderKeysList rows={[anthropicRow({ hasKey: true, last4: "1234" })]} canWrite={true} />
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    expect(
      await screen.findByText("Couldn't remove the key. Please try again.")
    ).toBeInTheDocument();
  });

  it("shows the busy label and disables both buttons while the delete is in flight", async () => {
    const user = userEvent.setup();
    let resolveDelete: (value: { error?: string }) => void = () => {};
    mockDelete.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      })
    );
    render(
      <ProviderKeysList rows={[anthropicRow({ hasKey: true, last4: "1234" })]} canWrite={true} />
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove key" }));

    const busyButton = await screen.findByRole("button", { name: "Removing…" });
    expect(busyButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveDelete({});
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});

describe("SetKeyDialog — additional coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an inline error and does not call the server action when the key is empty", async () => {
    const user = userEvent.setup();
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a provider key.");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("falls back to a generic error message when saveProviderKey throws", async () => {
    const user = userEvent.setup();
    mockSave.mockRejectedValue(new Error("network down"));
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    await user.type(
      screen.getByPlaceholderText(/Paste your Anthropic API key/i),
      "sk-ant-api03-test1234567890test1234567890"
    );
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(
      await screen.findByRole("alert")
    ).toHaveTextContent("Couldn't save the key. Please try again.");
  });

  it("disables the Save button and shows 'Saving…' while the save is in flight", async () => {
    const user = userEvent.setup();
    let resolveSave: (value: { last4: string }) => void = () => {};
    mockSave.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    await user.type(
      screen.getByPlaceholderText(/Paste your Anthropic API key/i),
      "sk-ant-api03-test1234567890test1234567890"
    );
    await user.click(screen.getByRole("button", { name: "Save key" }));

    const savingButton = await screen.findByRole("button", { name: "Saving…" });
    expect(savingButton).toBeDisabled();

    resolveSave({ last4: "7890" });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it("closes without saving when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("closes via the X (close dialog) button", async () => {
    const user = userEvent.setup();
    render(<ProviderKeysList rows={[anthropicRow()]} canWrite={true} />);

    await user.click(screen.getByRole("button", { name: "Add key" }));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("titles the dialog 'Replace' when the provider already has a key", async () => {
    const user = userEvent.setup();
    render(
      <ProviderKeysList rows={[anthropicRow({ hasKey: true, last4: "1234" })]} canWrite={true} />
    );

    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByRole("heading", { name: "Replace Anthropic key" })).toBeInTheDocument();
  });
});
