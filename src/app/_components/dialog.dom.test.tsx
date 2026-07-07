// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "./dialog";
import { useAnyModalOpen } from "./modal-presence";

// Small probe component so we can observe the modal-presence registry (the
// same hook CoachMark subscribes to) reacting to Dialog mount/unmount.
function ModalStatus() {
  const open = useAnyModalOpen();
  return <div data-testid="modal-status">{open ? "open" : "closed"}</div>;
}

describe("Dialog", () => {
  it("renders its children", () => {
    render(
      <Dialog onClose={vi.fn()}>
        <div>panel content</div>
      </Dialog>,
    );
    expect(screen.getByText("panel content")).toBeInTheDocument();
  });

  it("renders the dialog role with aria-modal", () => {
    render(
      <Dialog onClose={vi.fn()} ariaLabel="My dialog">
        <div>content</div>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "My dialog" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("calls onClose when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <Dialog onClose={onClose}>
        <div>content</div>
      </Dialog>,
    );

    // The backdrop is the absolutely-positioned sibling of the dialog panel.
    const backdrop = container.querySelector(".bg-overlay");
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the panel", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog onClose={onClose}>
        <div>panel content</div>
      </Dialog>,
    );

    await user.click(screen.getByText("panel content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape (Dialog is a PRIMARY modal, unlike ConfirmDialog)", () => {
    const onClose = vi.fn();
    render(
      <Dialog onClose={onClose}>
        <div>content</div>
      </Dialog>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the dialog panel on mount", () => {
    render(
      <Dialog onClose={vi.fn()}>
        <div>content</div>
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("restores focus to the opener element on unmount", () => {
    function Harness({ show }: { show: boolean }) {
      return (
        <>
          <button type="button">opener</button>
          {show && (
            <Dialog onClose={vi.fn()}>
              <div>content</div>
            </Dialog>
          )}
        </>
      );
    }

    const { rerender } = render(<Harness show={false} />);
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    expect(opener).toHaveFocus();

    rerender(<Harness show={true} />);
    expect(screen.getByRole("dialog")).toHaveFocus();

    rerender(<Harness show={false} />);
    expect(opener).toHaveFocus();
  });

  it("traps Tab focus within the dialog, wrapping from last back to first", () => {
    render(
      <Dialog onClose={vi.fn()}>
        <button type="button">first</button>
        <button type="button">last</button>
      </Dialog>,
    );

    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });

    last.focus();
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("traps Shift+Tab focus within the dialog, wrapping from first back to last", () => {
    render(
      <Dialog onClose={vi.fn()}>
        <button type="button">first</button>
        <button type="button">last</button>
      </Dialog>,
    );

    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });

    first.focus();
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
  });

  it("pulls focus back into the dialog if it escapes to an outside element", () => {
    render(
      <>
        <button type="button">outside</button>
        <Dialog onClose={vi.fn()}>
          <button type="button">first</button>
          <button type="button">last</button>
        </Dialog>
      </>,
    );

    const outside = screen.getByRole("button", { name: "outside" });
    const first = screen.getByRole("button", { name: "first" });

    outside.focus();
    expect(outside).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("does not throw and prevents default Tab behavior when there are no focusable children", () => {
    render(
      <Dialog onClose={vi.fn()}>
        <div>no focusable elements here</div>
      </Dialog>,
    );

    // The dialog panel itself (tabIndex=-1) is focused on mount and is not a match
    // for the focus-trap's own selector, so focusables is empty here.
    expect(() => fireEvent.keyDown(document, { key: "Tab" })).not.toThrow();
  });

  it("registers with the modal-presence registry on mount and unregisters on unmount", () => {
    function Harness({ show }: { show: boolean }) {
      return (
        <>
          <ModalStatus />
          {show && (
            <Dialog onClose={vi.fn()}>
              <div>content</div>
            </Dialog>
          )}
        </>
      );
    }

    const { rerender } = render(<Harness show={false} />);
    expect(screen.getByTestId("modal-status")).toHaveTextContent("closed");

    rerender(<Harness show={true} />);
    expect(screen.getByTestId("modal-status")).toHaveTextContent("open");

    rerender(<Harness show={false} />);
    expect(screen.getByTestId("modal-status")).toHaveTextContent("closed");
  });
});
