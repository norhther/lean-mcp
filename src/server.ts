#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ClientPool } from "./client-pool.js";
import { ToolRegistry } from "./registry.js";
import { ResultStore } from "./result-store.js";
import { MetaTools, registerMetaTools } from "./meta-tools.js";

const DEFAULT_CONFIG = "lean-mcp.config.json";

/** stderr only — stdout is the MCP protocol channel and must stay clean. */
function log(message: string): void {
  process.stderr.write(`[lean-mcp] ${message}\n`);
}

async function main(): Promise<void> {
  const configPath =
    process.argv[2] ?? process.env.LEAN_MCP_CONFIG ?? DEFAULT_CONFIG;
  const servers = loadConfig(configPath);
  log(`loading ${servers.length} downstream server(s) from ${configPath}`);

  const pool = new ClientPool();
  await pool.connectAll(servers);

  const registry = new ToolRegistry();
  registry.setTools(pool.allTools());

  for (const status of pool.statuses()) {
    log(
      status.connected
        ? `  ${status.name}: ${status.toolCount} tools (${status.transport})`
        : `  ${status.name}: FAILED — ${status.error ?? "unknown error"}`,
    );
  }
  log(`${registry.size} downstream tools collapsed behind 5 meta-tools`);

  const store = new ResultStore();
  const meta = new MetaTools({ registry, pool, store });

  const server = new McpServer({ name: "lean-mcp", version: "0.1.0" });
  registerMetaTools(server, meta);

  await server.connect(new StdioServerTransport());
  log("gateway ready on stdio");

  const shutdown = async (): Promise<void> => {
    log("shutting down");
    await pool.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
