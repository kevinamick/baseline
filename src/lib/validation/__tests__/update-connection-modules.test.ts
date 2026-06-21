import { describe, it, expect } from "vitest";
import { UpdateConnectionModulesSchema } from "@/lib/validation/schemas";

const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: CONNECTION_ID,
    requestTemplate: '{"input":"{{user_input}}","system":"{{prompt:system}}"}',
    modules: [{ name: "system", seed: "Answer helpfully." }],
    ...overrides,
  };
}

function firstMessage(res: ReturnType<typeof UpdateConnectionModulesSchema.safeParse>): string {
  return res.success ? "" : res.error.issues[0].message;
}

describe("UpdateConnectionModulesSchema", () => {
  it("accepts a matching declared↔referenced pair", () => {
    expect(UpdateConnectionModulesSchema.safeParse(valid()).success).toBe(true);
  });

  it("allows an empty Module list when the template has no {{prompt:*}} refs", () => {
    const res = UpdateConnectionModulesSchema.safeParse(
      valid({ requestTemplate: '{"input":"{{user_input}}"}', modules: [] })
    );
    expect(res.success).toBe(true);
  });

  it("rejects a declared Module the template never references", () => {
    const res = UpdateConnectionModulesSchema.safeParse(
      valid({
        modules: [
          { name: "system", seed: "A." },
          { name: "style", seed: "B." },
        ],
      })
    );
    expect(res.success).toBe(false);
    expect(firstMessage(res)).toContain('Declared Module "style"');
  });

  it("rejects a template reference with no declared Module (even with zero Modules)", () => {
    const res = UpdateConnectionModulesSchema.safeParse(valid({ modules: [] }));
    expect(res.success).toBe(false);
    expect(firstMessage(res)).toContain('no Module "system" is declared');
  });

  it("rejects duplicate Module names", () => {
    const res = UpdateConnectionModulesSchema.safeParse(
      valid({
        modules: [
          { name: "system", seed: "A." },
          { name: "system", seed: "B." },
        ],
      })
    );
    expect(res.success).toBe(false);
    expect(firstMessage(res)).toBe("Module names must be unique");
  });

  it("rejects a non-JSON request template", () => {
    const res = UpdateConnectionModulesSchema.safeParse(valid({ requestTemplate: "not json" }));
    expect(res.success).toBe(false);
    expect(firstMessage(res)).toBe("Request template must be valid JSON");
  });

  it("rejects a non-uuid connection id", () => {
    expect(UpdateConnectionModulesSchema.safeParse(valid({ connectionId: "nope" })).success).toBe(
      false
    );
  });
});
