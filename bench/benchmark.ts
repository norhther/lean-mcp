#!/usr/bin/env tsx
/**
 * Quantifies what lean-mcp saves, on both bloat axes:
 *
 *  1. Definition bloat — tokens spent injecting tool schemas into context.
 *     Baseline: every downstream tool definition. lean-mcp: 5 meta-tools.
 *  2. Result bloat — tokens spent on one oversized tool result.
 *     Baseline: the raw result. lean-mcp: the reduced result (full text
 *     stays retrievable via read_result).
 *
 * Token counts use the real Anthropic tokenizer when ANTHROPIC_API_KEY is
 * set; otherwise a ~4-chars-per-token estimate. Either way the comparison is
 * apples-to-apples because both sides use the same counter.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClientPool } from "../src/client-pool.js";
import { ToolRegistry } from "../src/registry.js";
import { ResultStore } from "../src/result-store.js";
import { MetaTools, registerMetaTools } from "../src/meta-tools.js";
import { estimateJsonTokens } from "../src/tokens.js";
import type { ServerConfig } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = join(here, "..", "test", "fixtures", "fake-server.ts");
const TSX = join(here, "..", "node_modules", ".bin", "tsx");
const SERVER_COUNT = 3;

/** An Anthropic-API tool definition — the exact thing injected into context. */
interface ApiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function downstreamConfigs(): ServerConfig[] {
  return Array.from({ length: SERVER_COUNT }, (_, i) => ({
    name: `tracker-${i + 1}`,
    command: TSX,
    args: [FAKE_SERVER],
  }));
}

/** Count tokens for a tool set, via the Anthropic API if a key is present. */
async function countToolTokens(tools: ApiTool[]): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });
      const res = await client.messages.countTokens({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "." }],
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as { type: "object" },
        })),
      });
      return res.input_tokens;
    } catch (error) {
      process.stderr.write(
        `countTokens API failed, using estimate: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  return estimateJsonTokens(tools);
}

function pct(baseline: number, reduced: number): string {
  if (baseline === 0) return "0%";
  return `${Math.round((1 - reduced / baseline) * 100)}%`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(34)}${value}`;
}

async function main(): Promise<void> {
  const pool = new ClientPool();
  await pool.connectAll(downstreamConfigs());

  const registry = new ToolRegistry();
  registry.setTools(pool.allTools());

  // Baseline: every downstream tool definition, as a host would inject them.
  const baselineTools: ApiTool[] = pool.allTools().map((entry) => ({
    name: `${entry.server}__${entry.name}`,
    description: entry.description,
    input_schema: entry.inputSchema,
  }));

  // lean-mcp: stand up the gateway and read back exactly the 5 defs it exposes.
  const store = new ResultStore();
  const meta = new MetaTools({
    registry,
    pool,
    store,
    summarizer: { budgetTokens: 2000, apiKey: "" },
  });
  const gateway = new McpServer({ name: "lean-mcp", version: "0.1.0" });
  registerMetaTools(gateway, meta);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverTransport);
  const client = new Client({ name: "benchmark", version: "0.0.0" });
  await client.connect(clientTransport);

  const gatewayTools: ApiTool[] = (await client.listTools()).tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
  }));

  const baselineDefTokens = await countToolTokens(baselineTools);
  const gatewayDefTokens = await countToolTokens(gatewayTools);

  // Result bloat: one oversized downstream result through call_tool.
  const callRaw = await client.callTool({
    name: "call_tool",
    arguments: {
      server: "tracker-1",
      name: "dump_logs",
      arguments: { sha: "benchmark" },
    },
  });
  const call = JSON.parse(
    (callRaw.content as Array<{ text: string }>)[0]!.text,
  ) as { originalTokens: number; result: string; method: string };
  const rawResultTokens = call.originalTokens;
  const reducedResultTokens = estimateJsonTokens(call.result);

  const counter = process.env.ANTHROPIC_API_KEY
    ? "Anthropic tokenizer"
    : "estimate (~4 chars/token)";

  const lines = [
    "",
    "lean-mcp benchmark",
    "==================",
    "",
    `Downstream: ${SERVER_COUNT} servers, ${registry.size} tools`,
    `Token counter: ${counter}`,
    "",
    "DEFINITION BLOAT  (tokens injected into context up front)",
    row(`baseline (${baselineTools.length} tool defs):`, `${baselineDefTokens} tokens`),
    row("lean-mcp (5 meta-tool defs):", `${gatewayDefTokens} tokens`),
    row("reduction:", pct(baselineDefTokens, gatewayDefTokens)),
    "",
    "RESULT BLOAT  (one oversized result: dump_logs)",
    row("baseline (raw result):", `${rawResultTokens} tokens`),
    row(`lean-mcp (${call.method}):`, `${reducedResultTokens} tokens`),
    row("reduction:", pct(rawResultTokens, reducedResultTokens)),
    "  full result retained — pageable via read_result",
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");

  await client.close();
  await gateway.close();
  await pool.close();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `benchmark failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
