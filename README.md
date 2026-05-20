# lean-mcp

A context-lean gateway for the Model Context Protocol.

MCP works, but it bloats LLM context two ways:

1. **Definition bloat** — every downstream tool's name, description, and full
   JSON Schema is injected up front. Ten servers can mean 50–100 tool
   definitions sitting in context before the model does anything.
2. **Result bloat** — a single tool call can return tens of thousands of
   tokens (a log dump, a large file, a verbose API response), and all of it
   lands in context.

`lean-mcp` is a proxy that sits between an MCP host and any number of
downstream MCP servers. The host sees **5 fixed meta-tools** instead of every
downstream definition. Downstream schemas are loaded only when searched, and
oversized results are summarized with the full text held retrievable.

It is **retro-compatible**: to the host it is a vanilla MCP server; to each
downstream it is a vanilla MCP client. Neither side needs to change.

## Results

From `npm run bench` (3 downstream servers, 36 tools):

```
DEFINITION BLOAT  (tokens injected into context up front)
  baseline (36 tool defs):          4009 tokens
  lean-mcp (5 meta-tool defs):       592 tokens
  reduction:                          85%

RESULT BLOAT  (one oversized result: dump_logs)
  baseline (raw result):           26408 tokens
  lean-mcp (truncated):             2043 tokens
  reduction:                          92%
  full result retained — pageable via read_result
```

Token counts use the real Anthropic tokenizer when `ANTHROPIC_API_KEY` is set,
otherwise a ~4-chars-per-token estimate. Both sides use the same counter.

## The 5 meta-tools

| Tool | Purpose |
|------|---------|
| `search_tools` | Keyword/BM25 search over downstream tools. Returns ranked `server`/`name`/one-line-description. |
| `inspect_tool` | Full JSON Schema for one tool — paid for only when needed. |
| `call_tool` | Validates arguments against the schema, forwards the call, reduces an oversized result. |
| `read_result` | Pages the full, unreduced output of a previous `call_tool` by handle. |
| `list_servers` | Connection status and tool counts for every downstream server. |

The model's loop becomes: `search_tools` → `inspect_tool` → `call_tool`, with
`read_result` available when a summary dropped something it needs.

## Architecture

```
        ┌────────┐   5 meta-tools    ┌───────────┐   N MCP servers   ┌────────────┐
  host ─┤ MCP    ├──────────────────►│ lean-mcp  ├──────────────────►│ downstream │
        │ client │   (stdio)         │ gateway   │   (stdio / http)  │ servers    │
        └────────┘                   └───────────┘                   └────────────┘
                       MCP server ───┘           └─── MCP client
```

The gateway is both roles at once — that dual identity is the whole
retro-compatibility mechanism.

- **Discovery** — downstream tools are flattened into a BM25 index. The real
  schemas live in the registry and never reach the host until `inspect_tool`.
- **Results** — `call_tool` stores the full downstream output in an in-memory
  store (TTL + max-entries eviction) and returns a handle. If the output is
  over budget it is summarized by Claude Haiku, or head/tail-truncated when no
  API key is available. The call never fails because summarization failed.

## Quick start

```bash
npm install
npm run build
```

Configure downstream servers in `lean-mcp.config.json`. It reuses the standard
`mcpServers` shape, so an existing Claude Code config can be pasted in:

```json
{
  "mcpServers": {
    "github":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "tracker": { "url": "https://example.com/mcp" }
  }
}
```

Run the gateway (stdio):

```bash
npm start            # node dist/server.js [config-path]
npm run dev          # tsx src/server.ts (no build step)
```

Register it with an MCP host as a single stdio server. For Claude Code:

```json
{
  "mcpServers": {
    "lean-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/lean-mcp/dist/server.js",
               "/absolute/path/to/lean-mcp.config.json"]
    }
  }
}
```

The config path may also be set via `LEAN_MCP_CONFIG`. Set `ANTHROPIC_API_KEY`
to enable LLM summarization of oversized results; without it the gateway
truncates instead.

## Develop

```bash
npm test                  # 63 tests across 9 files
npm run test -- --coverage
npm run bench             # token-savings benchmark
```

## Layout

```
src/
  server.ts        gateway entry point (stdio)
  meta-tools.ts    the 5 meta-tools + MCP registration
  client-pool.ts   one MCP client per downstream server; failures isolated
  registry.ts      flattened tool set + BM25-backed search
  search.ts        BM25 index
  result-store.ts  out-of-context result storage, handle + paging
  summarizer.ts    over-budget result reduction (LLM, with truncation fallback)
  config.ts        mcpServers config parsing
  tokens.ts        token estimation
test/
  fixtures/fake-server.ts   a realistic downstream MCP server
  integration.test.ts       end-to-end: host → gateway → downstream
bench/benchmark.ts          token-savings measurement
```

## Limitations

- A failed-to-summarize result truncates rather than erroring — the model can
  still page the full text via `read_result`, but a summary is better.
- Remote OAuth-protected servers (Google, Notion, Slack) need their own auth
  flow to proxy; the demo and benchmark use stdio servers.
- BM25 search is lexical. A tool whose description shares no words with the
  query will not surface — descriptions should use the vocabulary a caller
  would search for.
