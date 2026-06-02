// Shared Vitest setup. Registers jest-dom matchers (toBeInTheDocument, toHaveFocus,
// etc.) and tears down any React Testing Library trees between tests so each jsdom
// document starts clean. Node-environment tests are unaffected: with no mounted
// trees, cleanup() is a no-op.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
