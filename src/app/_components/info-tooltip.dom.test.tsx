// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InfoTooltip } from "./info-tooltip";

describe("InfoTooltip", () => {
  it("renders the info button", () => {
    render(<InfoTooltip content="Helpful hint" />);
    expect(screen.getByRole("button", { name: "More information" })).toBeInTheDocument();
  });

  it("does not show tooltip content by default", () => {
    render(<InfoTooltip content="Helpful hint" />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows tooltip on mouse enter and hides on mouse leave", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Hover content" />);

    const btn = screen.getByRole("button", { name: "More information" });
    await user.hover(btn);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hover content");

    await user.unhover(btn);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows tooltip on focus and hides on blur", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Focus content" />);

    const btn = screen.getByRole("button", { name: "More information" });
    await user.tab(); // focus the button
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Focus content");

    await user.tab(); // blur
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("flips below the trigger when there is no room above", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Near the top" />);

    const btn = screen.getByRole("button", { name: "More information" });
    // Simulate the trigger sitting at the very top of a scroll container.
    btn.getBoundingClientRect = () =>
      ({ top: 4, bottom: 17, left: 0, right: 13, width: 13, height: 13, x: 0, y: 4 }) as DOMRect;

    await user.hover(btn);
    expect(screen.getByRole("tooltip")).toHaveClass("top-full");
  });

  it("opens above the trigger when there is room", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Plenty of room" />);

    const btn = screen.getByRole("button", { name: "More information" });
    btn.getBoundingClientRect = () =>
      ({ top: 400, bottom: 413, left: 0, right: 13, width: 13, height: 13, x: 0, y: 400 }) as DOMRect;

    await user.hover(btn);
    expect(screen.getByRole("tooltip")).toHaveClass("bottom-full");
  });

  it("clamps inside the scroll container's content box, excluding classic scrollbars", async () => {
    // Simulate a Windows-style scroll container: border-box 670px wide, but a
    // classic vertical scrollbar takes 17px, so the content box ends at 653.
    // A trigger near the right edge must shift its 224px tooltip left of the
    // content edge — clamping to the border box would leave ~9px of overflow.
    const user = userEvent.setup();
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("role") === "tooltip" ? 224 : 13;
      },
    });

    try {
      const { container } = render(
        <div data-testid="scroller" style={{ overflowY: "auto" }}>
          <InfoTooltip content="Right edge" />
        </div>,
      );
      const scroller = container.firstElementChild as HTMLElement;
      scroller.getBoundingClientRect = () =>
        ({ top: 0, bottom: 600, left: 0, right: 670, width: 670, height: 600, x: 0, y: 0 }) as DOMRect;
      Object.defineProperty(scroller, "clientWidth", { value: 653 });
      Object.defineProperty(scroller, "clientLeft", { value: 0 });

      const btn = screen.getByRole("button", { name: "More information" });
      btn.getBoundingClientRect = () =>
        ({ top: 300, bottom: 313, left: 600, right: 613, width: 13, height: 13, x: 600, y: 300 }) as DOMRect;

      await user.hover(btn);
      const tooltip = screen.getByRole("tooltip");
      // Centered, the tooltip would span 494.5..718.5; the content edge minus
      // the 8px margin is 645, so it must shift left by 73.5px.
      expect(tooltip.style.transform).toBe("translateX(calc(-50% + -73.5px))");
    } finally {
      if (originalOffsetWidth) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
      }
    }
  });

  it("sets aria-describedby on button when tooltip is open", async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Aria check" />);

    const btn = screen.getByRole("button", { name: "More information" });
    expect(btn).not.toHaveAttribute("aria-describedby");

    await user.hover(btn);
    expect(btn).toHaveAttribute("aria-describedby");
    const tooltipId = btn.getAttribute("aria-describedby")!;
    expect(document.getElementById(tooltipId)).toBeInTheDocument();
  });
});
