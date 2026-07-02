// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./confirm-dialog";

describe("ConfirmDialog", () => {
  it("renders the title, message, and confirm/cancel buttons", () => {
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("alertdialog", { name: "Delete rubric?" })).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("renders custom confirm/cancel labels", () => {
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeInTheDocument();
  });

  it("calls onConfirm when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // Guardrail regression test (#352-adjacent convention, see AGENTS.md / confirm-dialog.tsx
  // comments): a reflexive Esc must NOT dismiss a destructive confirmation — dismissing on
  // Esc would be ambiguous with either Cancel or Confirm, so the user must click an explicit
  // button. Unlike the primary Dialog (which closes on Esc), ConfirmDialog deliberately does
  // not wire an Escape handler at all.
  it("does NOT call onCancel or onConfirm on Escape (destructive-action guardrail)", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    // The dialog itself is still in the document — Escape did not dismiss it.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("does NOT call onCancel when the backdrop is clicked (backdrop is inert)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    const backdrop = container.querySelector(".bg-overlay");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);

    expect(onCancel).not.toHaveBeenCalled();
  });

  it("focuses the Cancel button (the safe default) on mount", () => {
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("disables both buttons and shows the busy label while busy", () => {
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy
        busyLabel="Deleting…"
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  });

  it("traps Tab focus within the dialog, wrapping from last (Confirm) back to first (Cancel)", () => {
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm" });

    confirm.focus();
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });

  it("traps Shift+Tab focus within the dialog, wrapping from first (Cancel) back to last (Confirm)", () => {
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm" });

    // Cancel is already focused on mount; Shift+Tab from it should wrap to Confirm.
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(document, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it("pulls focus back into the dialog if it escapes to an outside element", () => {
    render(
      <>
        <button type="button">outside</button>
        <ConfirmDialog
          title="Delete rubric?"
          message="This cannot be undone."
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </>,
    );

    const outside = screen.getByRole("button", { name: "outside" });
    const cancel = screen.getByRole("button", { name: "Cancel" });

    outside.focus();
    expect(outside).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });

  it("does not throw on Tab when busy disables both buttons (no focusable children)", () => {
    render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy
      />,
    );

    // Both buttons are disabled while busy, so the focus-trap's focusable-elements
    // query comes back empty.
    expect(() => fireEvent.keyDown(document, { key: "Tab" })).not.toThrow();
  });

  it("uses the destructive (danger) styling by default and can opt out", () => {
    const { rerender } = render(
      <ConfirmDialog
        title="Delete rubric?"
        message="This cannot be undone."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Confirm" }).className).toContain("bg-danger");

    rerender(
      <ConfirmDialog
        title="Archive rubric?"
        message="You can restore it later."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        destructive={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Confirm" }).className).not.toContain("bg-danger");
  });
});
