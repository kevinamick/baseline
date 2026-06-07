import { describe, it, expect } from "vitest";
import { parseInstancesCsv, parseInstancesJson } from "./parse-instances";

describe("parseInstancesCsv", () => {
  it("parses a user_input-only CSV (no agent_output required)", () => {
    const rows = parseInstancesCsv("user_input\nHow do I reset my password?\nWhat are your hours?");
    expect(rows).toEqual([
      { userInput: "How do I reset my password?", expectedOutput: "", retrievalContext: "" },
      { userInput: "What are your hours?", expectedOutput: "", retrievalContext: "" },
    ]);
  });

  it("picks up optional expected_output and retrieval_context columns in any order", () => {
    const rows = parseInstancesCsv(
      "retrieval_context,user_input,expected_output\ndocs,Refund policy?,Full refund in 30 days"
    );
    expect(rows).toEqual([
      {
        userInput: "Refund policy?",
        expectedOutput: "Full refund in 30 days",
        retrievalContext: "docs",
      },
    ]);
  });

  it("honors quoted fields containing commas", () => {
    const rows = parseInstancesCsv('user_input\n"Hello, world, and more"');
    expect(rows[0].userInput).toBe("Hello, world, and more");
  });

  it("returns [] when there is no user_input column", () => {
    // agent_output alone is not enough — optimization instances need user_input.
    expect(parseInstancesCsv("agent_output\nsome answer")).toEqual([]);
  });

  it("drops rows with a blank user_input", () => {
    const rows = parseInstancesCsv("user_input,expected_output\n,orphan expected\nReal question,answer");
    expect(rows).toEqual([
      { userInput: "Real question", expectedOutput: "answer", retrievalContext: "" },
    ]);
  });

  it("returns [] for an empty or header-only document", () => {
    expect(parseInstancesCsv("")).toEqual([]);
    expect(parseInstancesCsv("user_input")).toEqual([]);
  });

  it("keeps columns aligned when the header itself contains a quoted comma", () => {
    // The header is split with the same quote-aware splitter as the rows, so the quoted
    // "label,extra" stays one column and user_input resolves to the correct index.
    const rows = parseInstancesCsv('"label,extra",user_input\nignored,Real question');
    expect(rows).toEqual([
      { userInput: "Real question", expectedOutput: "", retrievalContext: "" },
    ]);
  });
});

describe("parseInstancesJson", () => {
  it("parses an array of snake_case instance objects", () => {
    const rows = parseInstancesJson(
      '[{"user_input":"Q1","expected_output":"A1"},{"user_input":"Q2","retrieval_context":"ctx"}]'
    );
    expect(rows).toEqual([
      { userInput: "Q1", expectedOutput: "A1", retrievalContext: "" },
      { userInput: "Q2", expectedOutput: "", retrievalContext: "ctx" },
    ]);
  });

  it("accepts camelCase keys too", () => {
    const rows = parseInstancesJson('[{"userInput":"Q","expectedOutput":"A"}]');
    expect(rows).toEqual([{ userInput: "Q", expectedOutput: "A", retrievalContext: "" }]);
  });

  it("drops objects without a user_input", () => {
    const rows = parseInstancesJson('[{"expected_output":"orphan"},{"user_input":"keep"}]');
    expect(rows).toEqual([{ userInput: "keep", expectedOutput: "", retrievalContext: "" }]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseInstancesJson("not json")).toThrow();
  });

  it("throws when the root is not an array", () => {
    expect(() => parseInstancesJson('{"user_input":"Q"}')).toThrow();
  });

  it("trims field values so the JSON path matches the CSV path", () => {
    const rows = parseInstancesJson('[{"user_input":"  Q  ","expected_output":"  A  "}]');
    expect(rows).toEqual([{ userInput: "Q", expectedOutput: "A", retrievalContext: "" }]);
  });
});
