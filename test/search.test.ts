import { describe, it, expect } from "vitest";
import { Bm25Index, tokenize } from "../src/search.js";

describe("tokenize", () => {
  it("splits snake_case and lowercases", () => {
    expect(tokenize("send_slack_message")).toEqual([
      "send",
      "slack",
      "message",
    ]);
  });

  it("splits camelCase", () => {
    expect(tokenize("createPullRequest")).toEqual([
      "create",
      "pull",
      "request",
    ]);
  });

  it("drops single-character noise", () => {
    expect(tokenize("a big file")).toEqual(["big", "file"]);
  });
});

describe("Bm25Index", () => {
  const docs = [
    { id: "slack", text: "post a message to a slack channel" },
    { id: "email", text: "send an email message to a recipient" },
    { id: "weather", text: "get the current weather forecast" },
  ];

  it("ranks the most relevant document first", () => {
    const hits = new Bm25Index(docs).search("slack channel", 3);
    expect(hits[0]?.id).toBe("slack");
  });

  it("returns no hits when nothing matches", () => {
    expect(new Bm25Index(docs).search("kubernetes deployment")).toEqual([]);
  });

  it("respects the limit", () => {
    const hits = new Bm25Index(docs).search("message", 1);
    expect(hits).toHaveLength(1);
  });

  it("ranks a rarer term higher via IDF", () => {
    // "weather" is unique to one doc; "message" is shared by two.
    const hits = new Bm25Index(docs).search("weather message", 3);
    expect(hits[0]?.id).toBe("weather");
  });

  it("handles an empty index without throwing", () => {
    expect(new Bm25Index([]).search("anything")).toEqual([]);
  });
});
