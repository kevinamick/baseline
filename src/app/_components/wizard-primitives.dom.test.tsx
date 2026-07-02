// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { toCount, ReviewRow } from "./wizard-primitives";

describe("toCount", () => {
  it("floors a positive decimal to an integer", () => {
    expect(toCount("5.7")).toBe(5);
  });

  it("passes through a whole positive integer", () => {
    expect(toCount("5")).toBe(5);
  });

  it("maps zero to 0", () => {
    expect(toCount("0")).toBe(0);
  });

  it("maps a negative number to 0", () => {
    expect(toCount("-3")).toBe(0);
  });

  it("maps a non-numeric string to 0", () => {
    expect(toCount("abc")).toBe(0);
  });

  it("maps an empty string to 0", () => {
    expect(toCount("")).toBe(0);
  });

  it("maps Infinity to 0 (non-finite guard)", () => {
    expect(toCount("Infinity")).toBe(0);
  });
});

describe("ReviewRow", () => {
  it("renders the label and value", () => {
    render(<ReviewRow label="Model" value="claude-opus" />);
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("claude-opus")).toBeInTheDocument();
  });

  it("applies the default labelWidth class when none is passed", () => {
    render(<ReviewRow label="Model" value="claude-opus" />);
    expect(screen.getByText("Model")).toHaveClass("w-28");
  });

  it("applies a custom labelWidth class when passed", () => {
    render(<ReviewRow label="Model" value="claude-opus" labelWidth="w-32" />);
    const label = screen.getByText("Model");
    expect(label).toHaveClass("w-32");
    expect(label).not.toHaveClass("w-28");
  });
});
