import { describe, it, expect } from "vitest";
import { fmtUsd, fmtRate } from "../format";

describe("fmtUsd", () => {
  it("formats whole dollars", () => {
    expect(fmtUsd(5)).toBe("$5.00");
  });

  it("formats fractional dollars, rounded to cents", () => {
    expect(fmtUsd(4.999)).toBe("$5.00");
    expect(fmtUsd(0)).toBe("$0.00");
  });

  it("formats negative amounts", () => {
    expect(fmtUsd(-10)).toBe("-$10.00");
  });
});

describe("fmtRate", () => {
  it("shows at least two decimals for a whole rate", () => {
    expect(fmtRate(1.5)).toBe("$1.50");
  });

  it("shows up to four decimals for sub-cent rates", () => {
    expect(fmtRate(0.0005)).toBe("$0.0005");
  });

  it("rounds beyond four decimals", () => {
    expect(fmtRate(0.00005)).toBe("$0.0001");
  });

  it("formats zero", () => {
    expect(fmtRate(0)).toBe("$0.00");
  });
});
