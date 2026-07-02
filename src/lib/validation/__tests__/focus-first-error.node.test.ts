import { describe, it, expect } from "vitest";
import { focusFirstError } from "../focus-first-error";

// Default (node) environment: no `document` global, so this exercises the
// SSR/no-op guard that the jsdom-environment test can't reach.
describe("focusFirstError outside the browser", () => {
  it("no-ops when document is undefined", () => {
    expect(typeof document).toBe("undefined");
    expect(() => focusFirstError(["field-a"])).not.toThrow();
  });
});
