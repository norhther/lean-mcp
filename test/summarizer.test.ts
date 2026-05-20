import { describe, it, expect } from "vitest";
import { summarize } from "../src/summarizer.js";

describe("summarize", () => {
  it("returns content unchanged when under budget", async () => {
    const result = await summarize("short result", { budgetTokens: 100 });
    expect(result).toMatchObject({
      text: "short result",
      reduced: false,
      method: "inline",
    });
  });

  it("truncates oversized content when no LLM is available", async () => {
    const big = "x".repeat(40_000);
    const result = await summarize(big, { budgetTokens: 100 });
    expect(result.method).toBe("truncated");
    expect(result.reduced).toBe(true);
    expect(result.text.length).toBeLessThan(big.length);
    expect(result.text).toContain("truncated");
  });

  it("keeps both ends of the content when truncating", async () => {
    const content = "HEAD".padEnd(20_000, "-") + "TAIL";
    const result = await summarize(content, { budgetTokens: 100 });
    expect(result.text.startsWith("HEAD")).toBe(true);
    expect(result.text.endsWith("TAIL")).toBe(true);
  });

  it("uses the injected LLM summarizer when over budget", async () => {
    const big = "x".repeat(40_000);
    const result = await summarize(big, {
      budgetTokens: 100,
      llmSummarize: async () => "a concise summary",
    });
    expect(result).toMatchObject({
      text: "a concise summary",
      method: "llm",
      reduced: true,
    });
  });

  it("falls back to truncation when the LLM call fails", async () => {
    const big = "x".repeat(40_000);
    const result = await summarize(big, {
      budgetTokens: 100,
      llmSummarize: async () => {
        throw new Error("API down");
      },
    });
    expect(result.method).toBe("truncated");
  });

  it("reports the original token estimate", async () => {
    const result = await summarize("y".repeat(400), { budgetTokens: 1 });
    expect(result.originalTokens).toBe(100);
  });
});
