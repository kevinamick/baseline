import { describe, it, expect } from "vitest";
import { parseCsv } from "./parse-csv";

describe("parseCsv", () => {
  describe("basic parsing", () => {
    it("parses a simple comma-separated CSV with a header row", () => {
      const rows = parseCsv("user_input,agent_output\nHello,Hi there");
      expect(rows).toEqual([{ userInput: "Hello", agentOutput: "Hi there" }]);
    });

    it("parses multiple data rows", () => {
      const rows = parseCsv("user_input,agent_output\nQ1,A1\nQ2,A2");
      expect(rows).toEqual([
        { userInput: "Q1", agentOutput: "A1" },
        { userInput: "Q2", agentOutput: "A2" },
      ]);
    });

    it("returns [] for empty input", () => {
      expect(parseCsv("")).toEqual([]);
    });

    it("returns [] for whitespace-only input", () => {
      expect(parseCsv("   \n\n  ")).toEqual([]);
    });

    it("returns [] for header-only input (no data rows)", () => {
      expect(parseCsv("user_input,agent_output")).toEqual([]);
    });
  });

  describe("required-column detection", () => {
    it("returns [] when neither user_input nor agent_output is present", () => {
      expect(parseCsv("foo,bar\n1,2")).toEqual([]);
    });

    it("returns [] when user_input is present but agent_output is missing", () => {
      expect(parseCsv("user_input\nOnly this")).toEqual([]);
    });

    it("returns [] when agent_output is present but user_input is missing", () => {
      expect(parseCsv("agent_output\nOnly this")).toEqual([]);
    });
  });

  describe("column aliases and header normalization", () => {
    it("recognizes the userinput/agent/output aliases", () => {
      const rows = parseCsv("userinput,output\nQ,A");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A" }]);
    });

    it("recognizes the user/agent aliases", () => {
      const rows = parseCsv("user,agent\nQ,A");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A" }]);
    });

    it("picks up optional expected_output and retrieval_context columns in any order", () => {
      const rows = parseCsv(
        "retrieval_context,user_input,expected_output,agent_output\ndocs,Refund policy?,Full refund,We refund in full"
      );
      expect(rows).toEqual([
        {
          userInput: "Refund policy?",
          agentOutput: "We refund in full",
          expectedOutput: "Full refund",
          retrievalContext: "docs",
        },
      ]);
    });

    it("normalizes headers regardless of case and surrounding whitespace", () => {
      const rows = parseCsv(" User Input , Agent Output \nHello,Hi");
      expect(rows).toEqual([{ userInput: "Hello", agentOutput: "Hi" }]);
    });

    it("normalizes quoted header cells (no interior padding)", () => {
      const rows = parseCsv('"User Input","Agent Output"\nHello,Hi');
      expect(rows).toEqual([{ userInput: "Hello", agentOutput: "Hi" }]);
    });

    it("prefers the canonical alias over an earlier-positioned ambiguous alias", () => {
      // "user_input" is checked before "user" in the alias priority list, so it wins even
      // though the "user" column appears first in the header.
      const rows = parseCsv("user,agent,user_input\nfallback1,fallback2,Real Q");
      expect(rows).toEqual([{ userInput: "Real Q", agentOutput: "fallback2" }]);
    });
  });

  describe("quoting", () => {
    it("honors quoted fields containing commas", () => {
      const rows = parseCsv('user_input,agent_output\n"Hello, world",Answer text');
      expect(rows).toEqual([{ userInput: "Hello, world", agentOutput: "Answer text" }]);
    });

    it("collapses doubled double-quotes to one literal quote (RFC4180)", () => {
      const rows = parseCsv('user_input,agent_output\n"She said ""hi"" to me",Answer');
      expect(rows).toEqual([
        { userInput: 'She said "hi" to me', agentOutput: "Answer" },
      ]);
    });
  });

  describe("line endings", () => {
    it("handles CRLF line endings", () => {
      const rows = parseCsv("user_input,agent_output\r\nQ1,A1\r\nQ2,A2");
      expect(rows).toEqual([
        { userInput: "Q1", agentOutput: "A1" },
        { userInput: "Q2", agentOutput: "A2" },
      ]);
    });

    it("handles bare LF line endings", () => {
      const rows = parseCsv("user_input,agent_output\nQ1,A1\nQ2,A2");
      expect(rows).toEqual([
        { userInput: "Q1", agentOutput: "A1" },
        { userInput: "Q2", agentOutput: "A2" },
      ]);
    });

    it("handles a mix of CRLF and LF line endings in the same document", () => {
      const rows = parseCsv("user_input,agent_output\r\nQ1,A1\nQ2,A2");
      expect(rows).toEqual([
        { userInput: "Q1", agentOutput: "A1" },
        { userInput: "Q2", agentOutput: "A2" },
      ]);
    });

    it("handles a trailing newline", () => {
      const rows = parseCsv("user_input,agent_output\nQ,A\n");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A" }]);
    });

    it("handles input with no trailing newline", () => {
      const rows = parseCsv("user_input,agent_output\nQ,A");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A" }]);
    });
  });

  describe("empty fields and ragged rows", () => {
    it("preserves an empty middle field (a,,c shape) as an empty/undefined value", () => {
      const rows = parseCsv("user_input,expected_output,agent_output\nQ,,A");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A", expectedOutput: undefined }]);
    });

    it("drops a row whose user_input ends up empty", () => {
      const rows = parseCsv("user_input,agent_output\n,A\nReal,Answer");
      expect(rows).toEqual([{ userInput: "Real", agentOutput: "Answer" }]);
    });

    it("drops a row whose agent_output ends up empty", () => {
      const rows = parseCsv("user_input,agent_output\nQ,\nReal,Answer");
      expect(rows).toEqual([{ userInput: "Real", agentOutput: "Answer" }]);
    });

    it("fills missing optional trailing columns with undefined when a row is short", () => {
      const rows = parseCsv("user_input,agent_output,expected_output,retrieval_context\nQ,A");
      expect(rows).toEqual([
        { userInput: "Q", agentOutput: "A", expectedOutput: undefined, retrievalContext: undefined },
      ]);
    });

    it("drops a row that is too short to populate a required agent_output column", () => {
      const rows = parseCsv("user_input,agent_output,expected_output\nOnlyOneField");
      expect(rows).toEqual([]);
    });

    it("drops a row that is too short to populate a required user_input column", () => {
      // user_input is the second column here, so a single-field row leaves cols[uiCol]
      // undefined and exercises the `cols[uiCol] ?? ""` fallback.
      const rows = parseCsv("agent_output,user_input\nOnlyAgentOutputField");
      expect(rows).toEqual([]);
    });

    it("ignores extra columns when a row is longer than the header", () => {
      const rows = parseCsv("user_input,agent_output\nQ,A,extra,more");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A" }]);
    });

    it("skips blank lines between data rows", () => {
      const rows = parseCsv("user_input,agent_output\nQ1,A1\n\nQ2,A2");
      expect(rows).toEqual([
        { userInput: "Q1", agentOutput: "A1" },
        { userInput: "Q2", agentOutput: "A2" },
      ]);
    });
  });

  describe("whitespace trimming", () => {
    it("trims whitespace from every field value", () => {
      const rows = parseCsv("user_input,agent_output\n  Q  ,  A  ");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A" }]);
    });

    it("trims surrounding whitespace from the whole input before parsing", () => {
      const rows = parseCsv("\n\n  user_input,agent_output\nQ,A\n\n  ");
      expect(rows).toEqual([{ userInput: "Q", agentOutput: "A" }]);
    });
  });

  describe("malformed input", () => {
    it("swallows the rest of the line into one field on an unbalanced quote, dropping that row without throwing", () => {
      const rows = parseCsv(
        'user_input,agent_output\n"Bad row,MissingCloseQuote\nGood question,Good answer'
      );
      expect(rows).toEqual([{ userInput: "Good question", agentOutput: "Good answer" }]);
    });

    it("parses a quoted comma in the header without misaligning column indices against quote-aware data rows", () => {
      const rows = parseCsv(
        '"label,extra",user_input,agent_output\nignored,Real question,Real answer'
      );
      expect(rows).toEqual([{ userInput: "Real question", agentOutput: "Real answer" }]);
    });
  });
});
