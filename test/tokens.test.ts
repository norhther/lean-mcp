import { describe, it, expect } from "vitest";
import { estimateTokens, estimateJsonTokens } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses the ~4-chars-per-token heuristic, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("scales with length", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("estimateJsonTokens", () => {
  it("estimates tokens of the JSON serialization", () => {
    const value = { type: "object", properties: { x: { type: "string" } } };
    expect(estimateJsonTokens(value)).toBe(
      estimateTokens(JSON.stringify(value)),
    );
  });
});
