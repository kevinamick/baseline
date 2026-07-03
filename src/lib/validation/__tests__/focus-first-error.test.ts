// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import { focusFirstError, issuesToInvalidKeys } from "../focus-first-error";

describe("focusFirstError", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses and scrolls to the first id that exists in the DOM", () => {
    document.body.innerHTML = `<input id="field-b" />`;
    const el = document.getElementById("field-b") as HTMLElement;
    const scrollSpy = vi.fn();
    el.scrollIntoView = scrollSpy;
    const focusSpy = vi.spyOn(el, "focus");

    focusFirstError(["field-a", "field-b", "field-c"]);

    expect(scrollSpy).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("stops at the first matching id and does not touch a later match", () => {
    document.body.innerHTML = `<input id="field-a" /><input id="field-b" />`;
    const a = document.getElementById("field-a") as HTMLElement;
    const b = document.getElementById("field-b") as HTMLElement;
    a.scrollIntoView = vi.fn();
    b.scrollIntoView = vi.fn();
    const focusA = vi.spyOn(a, "focus");
    const focusB = vi.spyOn(b, "focus");

    focusFirstError(["field-a", "field-b"]);

    expect(focusA).toHaveBeenCalled();
    expect(focusB).not.toHaveBeenCalled();
  });

  it("is a no-op when none of the ids exist", () => {
    expect(() => focusFirstError(["missing-1", "missing-2"])).not.toThrow();
  });

  it("is a no-op when the id list is empty", () => {
    expect(() => focusFirstError([])).not.toThrow();
  });
});

describe("issuesToInvalidKeys", () => {
  it("builds a set of dotted path keys from a ZodError's issues", () => {
    const error = new ZodError([
      { code: "custom", path: ["rows", 0, "userInput"], message: "bad" },
      { code: "custom", path: ["name"], message: "required" },
    ]);
    expect(issuesToInvalidKeys(error)).toEqual(
      new Set(["rows.0.userInput", "name"])
    );
  });

  it("returns an empty set for an error with no issues", () => {
    const error = new ZodError([]);
    expect(issuesToInvalidKeys(error)).toEqual(new Set());
  });
});
