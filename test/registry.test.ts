import { describe, it, expect } from "vitest";
import { ToolRegistry, oneLine } from "../src/registry.js";
import type { ToolEntry } from "../src/types.js";

const tools: ToolEntry[] = [
  {
    server: "slack",
    name: "post_message",
    description: "Post a message to a Slack channel.",
    inputSchema: { type: "object", properties: { channel: {}, text: {} } },
  },
  {
    server: "gmail",
    name: "send_email",
    description: "Send an email to a recipient.",
    inputSchema: { type: "object", properties: { to: {}, subject: {} } },
  },
];

describe("oneLine", () => {
  it("keeps only the first line", () => {
    expect(oneLine("first line\nsecond line")).toBe("first line");
  });

  it("truncates overly long lines with an ellipsis", () => {
    expect(oneLine("x".repeat(200), 10)).toHaveLength(10);
  });
});

describe("ToolRegistry", () => {
  it("looks up a tool by server and name", () => {
    const registry = new ToolRegistry();
    registry.setTools(tools);
    expect(registry.get("slack", "post_message")?.name).toBe("post_message");
    expect(registry.get("slack", "missing")).toBeUndefined();
  });

  it("reports its size", () => {
    const registry = new ToolRegistry();
    registry.setTools(tools);
    expect(registry.size).toBe(2);
  });

  it("finds tools by free-text query, including param names", () => {
    const registry = new ToolRegistry();
    registry.setTools(tools);
    const hit = registry.search("send an email", 1)[0];
    expect(hit?.name).toBe("send_email");
  });

  it("matches on a parameter name", () => {
    const registry = new ToolRegistry();
    registry.setTools(tools);
    const hit = registry.search("channel", 1)[0];
    expect(hit?.server).toBe("slack");
  });

  it("replaces the tool set on a second setTools call", () => {
    const registry = new ToolRegistry();
    registry.setTools(tools);
    registry.setTools([tools[0]!]);
    expect(registry.size).toBe(1);
    expect(registry.get("gmail", "send_email")).toBeUndefined();
  });
});
