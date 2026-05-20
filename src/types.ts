/** A JSON Schema object as supplied by a downstream MCP server. */
export type JsonSchema = Record<string, unknown>;

/** One tool exposed by one downstream server, flattened into the registry. */
export interface ToolEntry {
  server: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** A downstream MCP server to proxy. Either stdio (command) or HTTP (url). */
export interface ServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** Connection state of one downstream server. */
export interface ServerStatus {
  name: string;
  transport: "stdio" | "http";
  connected: boolean;
  toolCount: number;
  error?: string;
}
