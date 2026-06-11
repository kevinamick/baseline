// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ModulesEditor,
  modulesEditorError,
  cleanModules,
  crossValidateModules,
  withModuleRef,
  nextModuleName,
  type ModuleRow,
} from "./modules-editor";

// Controlled harness — the editor is state-agnostic, so tests drive it the way the
// wizards and the edit dialog do (useState owned by the surface).
function Harness({
  initialModules = [],
  initialTemplate = '{\n  "input": "{{user_input}}"\n}',
  optional = false,
}: {
  initialModules?: ModuleRow[];
  initialTemplate?: string;
  optional?: boolean;
}) {
  const [modules, setModules] = useState<ModuleRow[]>(initialModules);
  const [template, setTemplate] = useState(initialTemplate);
  return (
    <ModulesEditor
      modules={modules}
      onModulesChange={setModules}
      requestTemplate={template}
      onRequestTemplateChange={setTemplate}
      idPrefix="test"
      optional={optional}
    />
  );
}

describe("ModulesEditor", () => {
  it("auto-references a newly added Module in the request template (no mismatch hint)", async () => {
    const user = userEvent.setup();
    render(<Harness optional />);

    await user.click(screen.getByRole("button", { name: "+ Add Module" }));

    // The new Module row appears and the template gained its {{prompt:system}} reference.
    expect(screen.getByLabelText("Module 1 name")).toHaveValue("system");
    const template = screen.getByLabelText<HTMLTextAreaElement>("Request body template (JSON)");
    expect(template.value).toContain("{{prompt:system}}");
    expect(screen.queryByText(/isn't referenced/)).not.toBeInTheDocument();
  });

  it("shows the live hint when a declared Module isn't referenced in the template", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initialModules={[{ name: "system", seed: "Answer helpfully." }]}
        initialTemplate='{"input": "{{user_input}}", "system": "{{prompt:system}}"}'
      />
    );

    // Rename the Module so it no longer matches the template's {{prompt:system}} — both
    // sides of the mismatch surface live.
    await user.clear(screen.getByLabelText("Module 1 name"));
    await user.type(screen.getByLabelText("Module 1 name"), "tone");

    expect(screen.getByText(/isn't referenced/)).toBeInTheDocument();
    expect(screen.getByText(/but no/)).toBeInTheDocument();
  });

  it("shows the undeclared-reference hint when the template references a missing Module", () => {
    render(<Harness optional initialTemplate='{"system": "{{prompt:system}}"}' />);
    expect(screen.getByText(/but no/)).toBeInTheDocument();
  });

  it("explains the empty state in optional mode and allows removing the last row", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        optional
        initialModules={[{ name: "system", seed: "Seed." }]}
        initialTemplate='{"system": "{{prompt:system}}"}'
      />
    );

    await user.click(screen.getByRole("button", { name: "Remove Module 1" }));
    expect(screen.queryByLabelText("Module 1 name")).not.toBeInTheDocument();
    expect(screen.getByText(/No Modules declared/)).toBeInTheDocument();
  });

  it("keeps the last row in required mode (remove is disabled)", () => {
    render(
      <Harness
        initialModules={[{ name: "system", seed: "Seed." }]}
        initialTemplate='{"system": "{{prompt:system}}"}'
      />
    );
    expect(screen.getByRole("button", { name: "Remove Module 1" })).toBeDisabled();
  });
});

describe("modulesEditorError", () => {
  const T = '{"input": "{{user_input}}", "system": "{{prompt:system}}"}';

  it("passes a matching declared↔referenced pair", () => {
    expect(
      modulesEditorError([{ name: "system", seed: "Seed." }], T, { requireModules: true })
    ).toBeNull();
  });

  it("requires at least one Module when requireModules is set", () => {
    expect(modulesEditorError([], '{"input": "{{user_input}}"}', { requireModules: true })).toBe(
      "Declare at least one Module."
    );
  });

  it("allows zero Modules when optional and the template has no {{prompt:*}} refs", () => {
    expect(
      modulesEditorError([], '{"input": "{{user_input}}"}', { requireModules: false })
    ).toBeNull();
  });

  it("still enforces cross-validation with zero Modules (template references a Module)", () => {
    expect(modulesEditorError([], T, { requireModules: false })).toContain(
      'references {{prompt:system}} but no Module "system"'
    );
  });

  it("flags a seeded row with no name", () => {
    expect(
      modulesEditorError([{ name: "", seed: "orphan seed" }], T, { requireModules: false })
    ).toBe("Give every Module a name (or clear the empty row).");
  });

  it("rejects invalid Module name characters", () => {
    expect(
      modulesEditorError([{ name: "bad name!", seed: "Seed." }], T, { requireModules: true })
    ).toContain("use letters, digits, hyphens, or underscores");
  });

  it("requires a seed prompt per named Module", () => {
    expect(
      modulesEditorError([{ name: "system", seed: " " }], T, { requireModules: true })
    ).toBe('Give Module "system" a seed prompt.');
  });

  it("rejects duplicate Module names", () => {
    expect(
      modulesEditorError(
        [
          { name: "system", seed: "A." },
          { name: "system", seed: "B." },
        ],
        T,
        { requireModules: true }
      )
    ).toBe("Module names must be unique.");
  });

  it("rejects a declared Module the template never references", () => {
    expect(
      modulesEditorError(
        [
          { name: "system", seed: "A." },
          { name: "style", seed: "B." },
        ],
        T,
        { requireModules: true }
      )
    ).toContain('Declared Module "style" must be referenced');
  });
});

describe("helpers", () => {
  it("cleanModules trims and drops unnamed rows", () => {
    expect(
      cleanModules([
        { name: "  system ", seed: " Seed. " },
        { name: "", seed: "dropped" },
      ])
    ).toEqual([{ name: "system", seed: "Seed." }]);
  });

  it("crossValidateModules reports both directions of a mismatch", () => {
    const { missingRefs, undeclaredRefs } = crossValidateModules(
      [{ name: "tone", seed: "x" }],
      '{"system": "{{prompt:system}}"}'
    );
    expect(missingRefs).toEqual(["tone"]);
    expect(undeclaredRefs).toEqual(["system"]);
  });

  it("withModuleRef injects into a JSON object and leaves non-objects untouched", () => {
    expect(withModuleRef('{"input": "{{user_input}}"}', "style")).toContain("{{prompt:style}}");
    expect(withModuleRef("not json", "style")).toBe("not json");
  });

  it("nextModuleName skips names already in use", () => {
    expect(nextModuleName([])).toBe("system");
    expect(nextModuleName([{ name: "system", seed: "" }])).toBe("style");
  });
});
