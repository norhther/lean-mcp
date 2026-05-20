import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClientPool } from "../src/client-pool.js";
import { ToolRegistry } from "../src/registry.js";
import { ResultStore } from "../src/result-store.js";
import { MetaTools, registerMetaTools } from "../src/meta-tools.js";
import type { ServerConfig } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeServer: ServerConfig = {
  name: "tracker",
  command: join(here, "..", "node_modules", ".bin", "tsx"),
  args: [join(here, "fixtures", "fake-server.ts")],
};

/** Parse a meta-tool's JSON text payload out of an MCP CallToolResult. */
function parse(result: { content: unknown }): unknown {
  const blocks = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(blocks[0]!.text);
}

describe("lean-mcp gateway (end to end)", () => {
  let pool: ClientPool;
  let gateway: McpServer;
  let client: Client;

  beforeAll(async () => {
    pool = new ClientPool();
    await pool.connectAll([fakeServer]);

    const registry = new ToolRegistry();
    registry.setTools(pool.allTools());
    const store = new ResultStore();
    // apiKey "" deterministically disables the LLM path so the test never
    // depends on a real ANTHROPIC_API_KEY in the environment.
    const meta = new MetaTools({
      registry,
      pool,
      store,
      summarizer: { budgetTokens: 500, apiKey: "" },
    });

    gateway = new McpServer({ name: "lean-mcp", version: "0.1.0" });
    registerMetaTools(gateway, meta);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await gateway.connect(serverTransport);

    client = new Client({ name: "test-host", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    await gateway?.close();
    await pool?.close();
  });

  it("exposes exactly the 5 meta-tools to the host", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "call_tool",
      "inspect_tool",
      "list_servers",
      "read_result",
      "search_tools",
    ]);
  });

  it("connected the downstream server and counted its tools", async () => {
    const out = parse(
      await client.callTool({ name: "list_servers", arguments: {} }),
    ) as { servers: Array<{ name: string; connected: boolean; toolCount: number }> };
    expect(out.servers[0]).toMatchObject({
      name: "tracker",
      connected: true,
      toolCount: 12,
    });
  });

  it("finds a downstream tool by keyword search", async () => {
    const out = parse(
      await client.callTool({
        name: "search_tools",
        arguments: { query: "create a new bug ticket" },
      }),
    ) as { results: Array<{ server: string; name: string }> };
    expect(out.results.map((r) => r.name)).toContain("create_issue");
  });

  it("reveals a downstream tool's full schema on inspect", async () => {
    const out = parse(
      await client.callTool({
        name: "inspect_tool",
        arguments: { server: "tracker", name: "create_issue" },
      }),
    ) as { inputSchema: { properties: Record<string, unknown> } };
    expect(Object.keys(out.inputSchema.properties)).toContain("project");
  });

  it("forwards a valid call to the downstream server", async () => {
    const out = parse(
      await client.callTool({
        name: "call_tool",
        arguments: {
          server: "tracker",
          name: "get_issue",
          arguments: { id: 1 },
        },
      }),
    ) as { ok: boolean; result: string };
    expect(out.ok).toBe(true);
    expect(out.result).toContain("Example issue");
  });

  it("rejects a call with arguments that violate the schema", async () => {
    const result = await client.callTool({
      name: "call_tool",
      arguments: {
        server: "tracker",
        name: "create_issue",
        arguments: { project: "CORE" },
      },
    });
    expect(result.isError).toBe(true);
    const out = parse(result) as { ok: boolean; validationErrors?: string[] };
    expect(out.ok).toBe(false);
    expect(out.validationErrors?.length).toBeTruthy();
  });

  it("summarizes an oversized result and keeps the full text paged", async () => {
    const out = parse(
      await client.callTool({
        name: "call_tool",
        arguments: { server: "tracker", name: "dump_logs", arguments: { sha: "abc123" } },
      }),
    ) as { ok: boolean; reduced: boolean; method: string; handle: string };
    expect(out.ok).toBe(true);
    expect(out.reduced).toBe(true);
    expect(out.method).toBe("truncated");

    const page = parse(
      await client.callTool({
        name: "read_result",
        arguments: { handle: out.handle, offset: 0, limit: 200 },
      }),
    ) as { text: string; total: number };
    expect(page.text).toContain("BUILD LOG START");
    expect(page.total).toBeGreaterThan(50_000);
  });
});
