import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerConfig, ServerStatus, ToolEntry } from "./types.js";

/** Raw content blocks as returned by a downstream MCP tool call. */
export interface DownstreamResult {
  content: unknown;
  isError: boolean;
}

interface Connection {
  config: ServerConfig;
  transport: "stdio" | "http";
  client?: Client;
  tools: ToolEntry[];
  connected: boolean;
  error?: string;
}

function makeTransport(config: ServerConfig): Transport {
  if (config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url));
  }
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env
        ? { ...getDefaultEnvironment(), ...config.env }
        : getDefaultEnvironment(),
    });
  }
  throw new Error(`Server "${config.name}" has neither url nor command`);
}

/**
 * Owns one MCP client per downstream server. A failed connection marks that
 * server degraded — it is excluded from the registry but never crashes the
 * gateway.
 */
export class ClientPool {
  private connections = new Map<string, Connection>();

  /** Connect to every configured server in parallel. Failures are isolated. */
  async connectAll(configs: ServerConfig[]): Promise<void> {
    await Promise.all(configs.map((config) => this.connectOne(config)));
  }

  private async connectOne(config: ServerConfig): Promise<void> {
    const connection: Connection = {
      config,
      transport: config.url ? "http" : "stdio",
      tools: [],
      connected: false,
    };
    this.connections.set(config.name, connection);

    try {
      const client = new Client(
        { name: "lean-mcp-gateway", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(makeTransport(config));
      const listed = await client.listTools();

      connection.client = client;
      connection.connected = true;
      connection.tools = (listed.tools ?? []).map((tool) => ({
        server: config.name,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema:
          (tool.inputSchema as Record<string, unknown> | undefined) ?? {
            type: "object",
          },
      }));
    } catch (error) {
      connection.connected = false;
      connection.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** All tools across all connected servers. */
  allTools(): ToolEntry[] {
    return [...this.connections.values()].flatMap((c) => c.tools);
  }

  /** Connection status of every configured server. */
  statuses(): ServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.config.name,
      transport: c.transport,
      connected: c.connected,
      toolCount: c.tools.length,
      error: c.error,
    }));
  }

  /** Forward a tool call to its downstream server. */
  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<DownstreamResult> {
    const connection = this.connections.get(server);
    if (!connection) {
      throw new Error(`Unknown server "${server}"`);
    }
    if (!connection.connected || !connection.client) {
      throw new Error(
        `Server "${server}" is not connected${
          connection.error ? `: ${connection.error}` : ""
        }`,
      );
    }
    const result = await connection.client.callTool({
      name,
      arguments: args,
    });
    return {
      content: result.content,
      isError: result.isError === true,
    };
  }

  /** Close every downstream connection. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map(async (c) => {
        try {
          await c.client?.close();
        } catch {
          // a downstream that fails to close cleanly must not block shutdown
        }
      }),
    );
  }
}
