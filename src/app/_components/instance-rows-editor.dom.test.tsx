// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InstanceRow } from "@/types/instances";
import {
  InstanceRowsEditor,
  InstanceSourcePicker,
  emptyInstanceRow,
  type InstanceSource,
} from "./instance-rows-editor";

// Both components here are pure UI shells driven by parent state (rows/source/file/json
// all live outside), so exercise them through small stateful harnesses — the same
// pattern the wizards use.
function RowsHarness({ children }: { children?: React.ReactNode }) {
  const [rows, setRows] = useState<InstanceRow[]>([emptyInstanceRow()]);
  return (
    <InstanceRowsEditor rows={rows} setRows={setRows}>
      {children}
    </InstanceRowsEditor>
  );
}

describe("InstanceRowsEditor", () => {
  it("renders a single row by default with the three textareas", () => {
    render(<RowsHarness />);

    expect(screen.getByText("Input 1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("User input…")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Expected output (optional)")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Retrieval context (optional)")).toBeInTheDocument();
  });

  it("renders optional children above the rows", () => {
    render(<RowsHarness>{<p>Intro copy</p>}</RowsHarness>);
    expect(screen.getByText("Intro copy")).toBeInTheDocument();
  });

  it("disables the remove button when only one row exists", () => {
    render(<RowsHarness />);
    expect(screen.getByRole("button", { name: "Remove input 1" })).toBeDisabled();
  });

  it("adds a new row via the Add input button, enabling remove on both", async () => {
    const user = userEvent.setup();
    render(<RowsHarness />);

    await user.click(screen.getByRole("button", { name: "+ Add input" }));

    expect(screen.getByText("Input 1")).toBeInTheDocument();
    expect(screen.getByText("Input 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove input 1" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove input 2" })).not.toBeDisabled();
  });

  it("removes a row and renumbers the remaining ones", async () => {
    const user = userEvent.setup();
    render(<RowsHarness />);

    await user.click(screen.getByRole("button", { name: "+ Add input" }));
    await user.click(screen.getByRole("button", { name: "+ Add input" }));
    expect(screen.getByText("Input 3")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove input 1" }));

    // The old rows 2 and 3 shift down to 1 and 2.
    expect(screen.queryByText("Input 3")).not.toBeInTheDocument();
    expect(screen.getByText("Input 1")).toBeInTheDocument();
    expect(screen.getByText("Input 2")).toBeInTheDocument();
    // Only one row remains removable-disabled once we're back down to... still 2 rows here,
    // so both remain enabled.
    expect(screen.getByRole("button", { name: "Remove input 1" })).not.toBeDisabled();
  });

  it("propagates edits to the userInput field", async () => {
    const user = userEvent.setup();
    render(<RowsHarness />);

    const input = screen.getByPlaceholderText("User input…");
    await user.type(input, "How do I reset my password?");
    expect(input).toHaveValue("How do I reset my password?");
  });

  it("propagates edits to the expectedOutput field", async () => {
    const user = userEvent.setup();
    render(<RowsHarness />);

    const input = screen.getByPlaceholderText("Expected output (optional)");
    await user.type(input, "Click Forgot password");
    expect(input).toHaveValue("Click Forgot password");
  });

  it("propagates edits to the retrievalContext field", async () => {
    const user = userEvent.setup();
    render(<RowsHarness />);

    const input = screen.getByPlaceholderText("Retrieval context (optional)");
    await user.type(input, "Docs: password reset flow");
    expect(input).toHaveValue("Docs: password reset flow");
  });

  it("edits each row's fields independently", async () => {
    const user = userEvent.setup();
    render(<RowsHarness />);

    await user.click(screen.getByRole("button", { name: "+ Add input" }));

    const inputs = screen.getAllByPlaceholderText("User input…");
    expect(inputs).toHaveLength(2);

    await user.type(inputs[0], "first row");
    await user.type(inputs[1], "second row");

    expect(inputs[0]).toHaveValue("first row");
    expect(inputs[1]).toHaveValue("second row");
  });
});

function SourcePickerHarness({ intro }: { intro?: React.ReactNode }) {
  const [source, setSource] = useState<InstanceSource>("manual");
  const [manualRows, setManualRows] = useState<InstanceRow[]>([emptyInstanceRow()]);
  const [fileName, setFileName] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState("");
  const onFile = vi.fn((file: File) => {
    setFileName(file.name);
    setFileNote(`${file.size} bytes`);
  });

  return (
    <InstanceSourcePicker
      source={source}
      setSource={setSource}
      intro={intro}
      manualRows={manualRows}
      setManualRows={setManualRows}
      fileName={fileName}
      fileNote={fileNote}
      onFile={onFile}
      jsonText={jsonText}
      setJsonText={setJsonText}
    />
  );
}

describe("InstanceSourcePicker", () => {
  it("defaults to the manual source, rendering the rows editor", () => {
    render(<SourcePickerHarness />);
    expect(screen.getByPlaceholderText("User input…")).toBeInTheDocument();
  });

  it("renders intro copy when provided", () => {
    render(<SourcePickerHarness intro="Provide a few sample inputs." />);
    expect(screen.getByText("Provide a few sample inputs.")).toBeInTheDocument();
  });

  it("switches to the CSV file source and shows the file picker + column hint", async () => {
    const user = userEvent.setup();
    render(<SourcePickerHarness />);

    await user.click(screen.getByRole("button", { name: "CSV file" }));

    expect(screen.getByText("Choose CSV…")).toBeInTheDocument();
    expect(screen.getByText("user_input")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("User input…")).not.toBeInTheDocument();
  });

  it("calls onFile with the selected CSV and then renders the file name + note", async () => {
    const user = userEvent.setup();
    render(<SourcePickerHarness />);

    await user.click(screen.getByRole("button", { name: "CSV file" }));

    const file = new File(["user_input\nhi"], "instances.csv", { type: "text/csv" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    expect(screen.getByText("instances.csv")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "instances.csv — 13 bytes")).toBeInTheDocument();
  });

  it("switches to the JSON source and propagates textarea edits", async () => {
    const user = userEvent.setup();
    render(<SourcePickerHarness />);

    await user.click(screen.getByRole("button", { name: "JSON" }));

    const textarea = screen.getByLabelText("Instances JSON");
    // Curly braces are special key syntax for user-event's `type`, so paste the
    // literal JSON in directly rather than typing it character by character.
    await user.click(textarea);
    await user.paste('[{"user_input":"hi"}]');
    expect(textarea).toHaveValue('[{"user_input":"hi"}]');
    expect(screen.getByText("expected_output", { exact: false })).toBeInTheDocument();
  });

  it("highlights the active source tab", async () => {
    const user = userEvent.setup();
    render(<SourcePickerHarness />);

    const manualTab = screen.getByRole("button", { name: "Manual" });
    const csvTab = screen.getByRole("button", { name: "CSV file" });
    expect(manualTab.className).toContain("bg-card");

    await user.click(csvTab);
    expect(csvTab.className).toContain("bg-card");
    expect(manualTab.className).not.toContain("bg-card text-ink");
  });
});
