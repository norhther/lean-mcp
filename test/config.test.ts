import { describe, it, expect } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("parses a stdio server", () => {
    const result = parseConfig(
      JSON.stringify({
        mcpServers: {
          cavemem: { command: "node", args: ["index.js", "mcp"] },
        },
      }),
    );
    expect(result).toEqual([
      { name: "cavemem", command: "node", args: ["index.js", "mcp"], env: undefined },
    ]);
  });

  it("parses an http server", () => {
    const result = parseConfig(
      JSON.stringify({
        mcpServers: { gmail: { url: "https://example.com/mcp" } },
      }),
    );
    expect(result).toEqual([
      { name: "gmail", url: "https://example.com/mcp" },
    ]);
  });

  it("parses an http server with static headers", () => {
    const result = parseConfig(
      JSON.stringify({
        mcpServers: {
          api: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      }),
    );
    expect(result).toEqual([
      {
        name: "api",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    ]);
  });

  it("ignores non-string-valued headers", () => {
    const [server] = parseConfig(
      JSON.stringify({
        mcpServers: {
          api: { url: "https://example.com/mcp", headers: { bad: 123 } },
        },
      }),
    );
    expect(server?.headers).toBeUndefined();
  });

  it("ignores keys beginning with underscore", () => {
    const result = parseConfig(
      JSON.stringify({
        mcpServers: { _comment: "ignore me", real: { command: "x" } },
      }),
    );
    expect(result.map((s) => s.name)).toEqual(["real"]);
  });

  it("defaults missing args to an empty array", () => {
    const [server] = parseConfig(
      JSON.stringify({ mcpServers: { x: { command: "run" } } }),
    );
    expect(server?.args).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseConfig("{not json")).toThrow(/Invalid JSON/);
  });

  it("throws when mcpServers is missing", () => {
    expect(() => parseConfig(JSON.stringify({ servers: {} }))).toThrow(
      /mcpServers/,
    );
  });

  it("throws when a server has neither command nor url", () => {
    expect(() =>
      parseConfig(JSON.stringify({ mcpServers: { broken: {} } })),
    ).toThrow(/either "command" .* or "url"/);
  });
});
