// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Isolate the placeholder from the nav bar (covered by its own test).
vi.mock("./nav-bar", () => ({
  NavBar: () => <nav data-testid="navbar" />,
}));

import { NoTeamPlaceholder } from "./no-team-placeholder";

describe("NoTeamPlaceholder", () => {
  it("renders the no-team interim state alongside the nav bar", () => {
    render(<NoTeamPlaceholder />);

    expect(
      screen.getByRole("heading", { name: "No team yet" })
    ).toBeInTheDocument();
    expect(screen.getByText(/Team creation arrives/)).toBeInTheDocument();
    expect(screen.getByTestId("navbar")).toBeInTheDocument();
  });
});
