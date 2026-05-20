import { z } from "zod";
import { Ajv } from "ajv";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolRegistry, oneLine } from "./registry.js";
import type { ClientPool } from "./client-pool.js";
import type { ResultStore } from "./result-store.js";
import { summarize, type SummarizerOptions } from "./summarizer.js";
import type { JsonSchema, ServerStatus } from "./types.js";

/** A condensed search hit: enough to decide, not enough to bloat context. */
export interface SearchHit {
  server: string;
  name: string;
  description: string;
}

/** Outcome of a forwarded downstream call. */
export interface CallOutcome {
  ok: boolean;
  server: string;
  name: string;
  /** Context-sized text: the result inline, summarized, or truncated. */
  result: string;
  /** Whether `result` is smaller than the raw downstream output. */
  reduced: boolean;
  method: "inline" | "llm" | "truncated";
  originalTokens: number;
  /** Handle to page the full, unreduced result via `read_result`. */
  handle: string;
}

export interface MetaToolsDeps {
  registry: ToolRegistry;
  pool: ClientPool;
  store: ResultStore;
  /** Forwarded to the summarizer; lets tests inject a fake LLM. */
  summarizer?: SummarizerOptions;
}

/** Flatten downstream MCP content blocks into a single string. */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "type" in block) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

/**
 * The five fixed meta-tools that replace every downstream tool definition in
 * the host's context. Logic lives here as plain methods so it can be unit
 * tested without an MCP transport; `registerMetaTools` does the wiring.
 */
export class MetaTools {
  private readonly registry: ToolRegistry;
  private readonly pool: ClientPool;
  private readonly store: ResultStore;
  private readonly summarizer: SummarizerOptions;
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  constructor(deps: MetaToolsDeps) {
    this.registry = deps.registry;
    this.pool = deps.pool;
    this.store = deps.store;
    this.summarizer = deps.summarizer ?? {};
  }

  /** Rank downstream tools against a free-text query. */
  searchTools(
    query: string,
    limit = 5,
  ): { query: string; count: number; results: SearchHit[] } {
    const results = this.registry.search(query, limit).map((entry) => ({
      server: entry.server,
      name: entry.name,
      description: oneLine(entry.description),
    }));
    return { query, count: results.length, results };
  }

  /** Reveal one tool's full JSON Schema — paid for only when needed. */
  inspectTool(
    server: string,
    name: string,
  ):
    | { server: string; name: string; description: string; inputSchema: JsonSchema }
    | { error: string } {
    const entry = this.registry.get(server, name);
    if (!entry) {
      return {
        error: `No tool "${name}" on server "${server}". Use search_tools to find the correct server/name.`,
      };
    }
    return {
      server: entry.server,
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    };
  }

  /** Validate, forward, and reduce a downstream tool call. */
  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<
    | CallOutcome
    | { ok: false; error: string; validationErrors?: string[] }
  > {
    const entry = this.registry.get(server, name);
    if (!entry) {
      return {
        ok: false,
        error: `No tool "${name}" on server "${server}". Use search_tools first.`,
      };
    }

    const validationErrors = this.validateArgs(entry.inputSchema, args);
    if (validationErrors) {
      return {
        ok: false,
        error: `Arguments do not match the schema for "${name}". Call inspect_tool to see the full schema.`,
        validationErrors,
      };
    }

    let downstream;
    try {
      downstream = await this.pool.callTool(server, name, args);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const text = stringifyContent(downstream.content);
    const handle = this.store.put(text);
    const summary = await summarize(text, this.summarizer);

    return {
      ok: !downstream.isError,
      server,
      name,
      result: summary.text,
      reduced: summary.reduced,
      method: summary.method,
      originalTokens: summary.originalTokens,
      handle,
    };
  }

  /** Page raw, unreduced content held out of context by `call_tool`. */
  readResult(handle: string, offset?: number, limit?: number) {
    const page = this.store.slice(handle, offset, limit);
    if (!page) {
      return {
        error: `No result for handle "${handle}". Handles expire; re-run call_tool to refresh.`,
      };
    }
    return page;
  }

  /** Connection status of every configured downstream server. */
  listServers(): { servers: ServerStatus[] } {
    return { servers: this.pool.statuses() };
  }

  /**
   * Best-effort JSON Schema validation. If the schema cannot be compiled
   * (unsupported draft, duplicate $id), validation is skipped rather than
   * blocking an otherwise valid call.
   */
  private validateArgs(
    schema: JsonSchema,
    args: Record<string, unknown>,
  ): string[] | null {
    try {
      const validate = this.ajv.compile(schema);
      if (validate(args)) return null;
      return (validate.errors ?? []).map(
        (err) => `${err.instancePath || "(root)"} ${err.message ?? "is invalid"}`,
      );
    } catch {
      return null;
    }
  }
}

/** True when a meta-tool result should be reported to the host as an error. */
function isErrorResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  return typeof r.error === "string" || r.ok === false;
}

/** Wrap a meta-tool result object as an MCP CallToolResult. */
function asToolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    isError: isErrorResult(result),
  };
}

/** Register the five meta-tools onto an McpServer facing the host. */
export function registerMetaTools(server: McpServer, meta: MetaTools): void {
  server.registerTool(
    "search_tools",
    {
      description:
        "Find downstream tools by keyword. Returns ranked server/name/description triples. Start here — downstream tools are not loaded into context until searched.",
      inputSchema: {
        query: z.string().describe("Free-text description of the task."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Max results (default 5)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => asToolResult(meta.searchTools(query, limit)),
  );

  server.registerTool(
    "inspect_tool",
    {
      description:
        "Get the full JSON Schema and description for one downstream tool. Call this before call_tool to learn the exact arguments.",
      inputSchema: {
        server: z.string().describe("Downstream server name."),
        name: z.string().describe("Downstream tool name."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ server: srv, name }) => asToolResult(meta.inspectTool(srv, name)),
  );

  server.registerTool(
    "call_tool",
    {
      description:
        "Invoke a downstream tool. Arguments are validated against its schema. Large results are summarized; the full result stays retrievable via read_result.",
      inputSchema: {
        server: z.string().describe("Downstream server name."),
        name: z.string().describe("Downstream tool name."),
        arguments: z
          .record(z.unknown())
          .optional()
          .describe("Arguments object matching the tool's inputSchema."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ server: srv, name, arguments: args }) =>
      asToolResult(await meta.callTool(srv, name, args ?? {})),
  );

  server.registerTool(
    "read_result",
    {
      description:
        "Page through the full, unreduced output of a previous call_tool by handle. Use when a summarized result omitted something you need.",
      inputSchema: {
        handle: z.string().describe("Handle returned by call_tool."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start character offset (default 0)."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Max characters to return (default 4000)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ handle, offset, limit }) =>
      asToolResult(meta.readResult(handle, offset, limit)),
  );

  server.registerTool(
    "list_servers",
    {
      description:
        "List configured downstream servers with connection status and tool counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => asToolResult(meta.listServers()),
  );
}
