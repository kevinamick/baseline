// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderKeysList } from "./provider-keys-list";
import type { ProviderKeyRow } from "@/lib/llm/keys";

const mockSave = vi.fn();
vi.mock("@/app/actions/provider-keys", () => ({
  saveProviderKey: (input: { provider: string; key: string }) => mockSave(input),
  deleteProviderKey: vi.fn(),
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
