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

## Status: Proof of Concept

This is a working PoC demonstrating the idea end-to-end:

- ✅ Retro-compatible (dual MCP role: server + client)
- ✅ 5 fixed meta-tools that collapse N downstream definitions
- ✅ BM25 search, on-demand schema inspection, result reduction
- ✅ Remote MCP servers — static token headers + full OAuth 2.0 (PKCE,
  dynamic client registration, automatic token refresh)
- ✅ Token savings proven (85% definition, 92% result)
- ✅ 95 unit + integration tests, 92% coverage
- ⚠️ In-memory result storage only (TTL-based eviction)
- ⚠️ No persistence layer or clustering
- ⚠️ Result summarization uses Claude Haiku; no pluggable summarizer
- ⚠️ Not optimized for production scale (single process, no caching beyond result store)

**What it proves**: The idea works. Schemas don't need to bloat context, and
result reduction is practical. Retro-compatibility is achievable.

**What's missing for production**: persistence, distributed caching, pluggable
summarization, metrics, graceful degradation under load.

## How It Works

### Two bloats, two fixes

**Definition bloat**: Normally, every downstream tool's full JSON schema is
injected into the model's context before it does anything. 50 tools = 50 schema
objects, even if the model only needs 2.

**Fix**: lean-mcp exposes 5 fixed meta-tools. Downstream schemas live in a BM25
index. The model:
1. `search_tools "create issue"` → gets ranked hits (server, name, one-liner)
2. `inspect_tool "tracker" "create_issue"` → gets full schema (only when needed)
3. `call_tool "tracker" "create_issue" {...}` → invokes it

Schemas are never precomputed in context. They're queried on demand.

**Result bloat**: A single tool call can dump 26K tokens (a build log, a file
dump, a verbose API response). All of it lands in context, squeezing out actual
reasoning.

**Fix**: `call_tool` returns a summary (context-sized) and a handle. The model
can page the full result via `read_result` only if needed. Oversized results
are summarized by Claude Haiku (or head/tail-truncated if no API key).

### Why retro-compatible

The magic: the gateway is **both** an MCP server (facing the host) and an MCP
client (facing each downstream). To the host it looks like a normal MCP server
with 5 tools. To each downstream it looks like a normal MCP client. Neither side
needs changes.

When the host calls `call_tool "tracker" "create_issue"`:
1. Gateway's `call_tool` handler receives the call.
2. It validates args against the schema (stored in registry, not in context).
3. It forwards the call to the tracker server as a normal MCP callTool.
4. It receives the result, summarizes it, stores it, returns it.

The downstream has no idea it's being proxied. The host has no idea downstream
schemas aren't preloaded. That abstraction layer is transparent.

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
    "tracker": { "url": "https://example.com/mcp" },
    "api":     { "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer YOUR_TOKEN" } }
  }
}
```

Three server kinds are supported:

- **stdio** — local subprocess (`command` + `args`).
- **remote, static token** — an HTTP `url` plus `headers`. The header set
  (a bearer token, API key, etc.) is sent on every request. Keep this config
  file out of version control if it carries a real token.
- **remote, OAuth** — an HTTP `url` with no `headers`. The gateway attaches an
  OAuth client and uses tokens cached by the `auth` command (see below). A
  `url` server with no headers and no cached tokens simply connects
  unauthenticated, which is correct for public servers.

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

## Authenticating remote servers (OAuth)

For a remote server that speaks OAuth 2.0, run the one-time auth flow:

```bash
npm run build
node dist/server.js auth <server-name> [config-path]
```

This:
1. Starts a temporary loopback callback server on an ephemeral port.
2. Discovers the server's authorization server (RFC 9728 / RFC 8414) and
   dynamically registers `lean-mcp` as an OAuth client (RFC 7591).
3. Opens your browser to the consent screen.
4. Catches the redirect, exchanges the code (PKCE), and caches the tokens.

Tokens and client credentials are stored under `~/.lean-mcp/<server>.json`
(directory `0700`, files `0600`) — never in the repo, never in the config
file. Once cached, the gateway loads them on startup and refreshes the access
token automatically when it expires. If a server needs auth and has no cached
tokens, it shows up degraded in `list_servers` with the exact command to fix.

## Future work

Ideas for moving this from PoC to production:

- **Persistent result store**: swap in-memory store for Redis or a local DB.
- **Semantic search**: add embeddings + vector similarity to `search_tools`.
- **Pluggable summarizers**: let users swap Haiku for other models, or custom logic.
- **Metrics**: emit token counts, search latency, cache stats.
- **Clustering**: multiple gateway instances with a shared result store and sticky
  client sessions (or replicate state across instances).
- **Fallback chains**: if tracker server is down, try a backup; queue tool calls
  for later retry.
- **Credential encryption**: cached tokens in `~/.lean-mcp/` are plaintext
  JSON protected only by file permissions; production should encrypt at rest
  or use an OS keychain.

## Develop

```bash
npm test                  # 95 tests across 12 files
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
  oauth.ts         file-backed OAuthClientProvider for remote servers
  oauth-store.ts   token + client-credential storage (~/.lean-mcp/)
  auth-command.ts  `lean-mcp auth` interactive OAuth flow
  tokens.ts        token estimation
test/
  fixtures/fake-server.ts   a realistic downstream MCP server
  integration.test.ts       end-to-end: host → gateway → downstream
bench/benchmark.ts          token-savings measurement
```

## Understanding the code

Entry points:
- `src/server.ts` — the gateway process. Loads config, connects to downstreams,
  registers the 5 meta-tools, listens on stdio.
- `src/meta-tools.ts` — the 5 meta-tools logic. Pure, testable functions that
  implement search, inspect, call, read, and list.

Key modules:
- `registry.ts` — BM25-indexed, flattened tool set. `search()` returns ranked
  hits; `get()` returns full entry.
- `client-pool.ts` — N MCP clients (one per downstream). Each client is owned
  by a Connection that tracks state. A failed connection is marked degraded but
  doesn't crash the pool.
- `result-store.ts` — in-memory map of handles → content. TTL-based and
  max-entries eviction. Returns pages on demand.
- `summarizer.ts` — async function that takes oversized content and returns
  summarized or truncated text. Uses Claude Haiku if API key is present, else
  truncates (head/tail).
- `config.ts` — parses the `mcpServers` config shape, same as Claude Code uses.

Integration test (`test/integration.test.ts`) is a good place to see the full
flow: host ← in-memory transport → gateway ← real subprocess → fake downstream
server.

## Limitations

**In-memory storage**:
- Result handles expire (30 min TTL, 100 max entries). For a long-running host,
  a model might try to page a result that's already evicted. It will get an
  error and need to re-run the original tool.

**Search quality**:
- BM25 is lexical. A tool description that uses different vocabulary than a
  search query won't surface. E.g., `"send a message"` won't find a tool named
  `"post_comment"` unless the description uses both "send" and "message" or
  "post" and "comment".
- No semantic search (would need embeddings + vector DB).

**Summarization**:
- Uses Claude Haiku only. No pluggable summarizer strategy.
- If Haiku is down or the API key is invalid, the gateway falls back to
  deterministic head/tail truncation. The model won't know which reduction
  strategy was used (truncated vs. llm is reported, but not the reason).

**Remote / OAuth downstreams**:
- Static-token and OAuth 2.0 servers are both supported (see "Authenticating
  remote servers"). OAuth tokens are cached in `~/.lean-mcp/`.
- Token refresh is automatic, but a *full* re-authorization is not: if the
  refresh token expires or is revoked, the server goes degraded and you must
  re-run `lean-mcp auth <server>`. The gateway never opens a browser on its own.
- The demo and benchmark still exercise only stdio servers; the OAuth path is
  covered by unit tests, not an end-to-end live server.

**Single-process**:
- This PoC runs as a single process with no clustering. If load is high or
  uptime matters, you'd need a reverse-proxy (e.g., multiple gateway instances
  behind nginx) and a shared result store (Redis).

**No metrics**:
- The gateway logs to stderr but doesn't emit metrics (token counts, search
  latency, cache hit rate, summarization time). Production would want
  Prometheus metrics, traces, etc.

**No fallback chains**:
- If a downstream server is down, tools from that server become unavailable.
  No automatic failover or retry logic (beyond the initial connection timeout).
