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
  /**
   * Static request headers for an HTTP server (e.g. a bearer token or API
   * key). When set, the gateway sends them on every request and does NOT
   * attach an OAuth provider — this is the "static token" auth tier.
   */
  headers?: Record<string, string>;
}

/** Connection state of one downstream server. */
export interface ServerStatus {
  name: string;
  transport: "stdio" | "http";
  connected: boolean;
  toolCount: number;
  error?: string;
}
