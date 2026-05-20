# lean-mcp — Design Spec

**Date:** 2026-05-20
**Status:** Approved (brainstorming complete, pending implementation plan)

## Problem

The Model Context Protocol (MCP) bloats LLM context in two distinct ways:

1. **Definition bloat.** Every connected MCP server injects all of its tool
   schemas (name + description + full JSON Schema) into the system prompt at
   session start. With many servers the cost is tens of thousands of tokens
   spent *before the model does any work*. Example: 10 servers x 15 tools x
   ~400 tokens ~= 60k tokens of pure overhead.
2. **Result bloat.** A single tool call (`read_file`, `list_issues`, a search)
   can return a large payload that lands verbatim in the conversation.

These have different root causes and therefore different fixes. Definition
bloat needs lazy, searchable tool discovery. Result bloat needs out-of-band
result storage with on-demand paging.

## Goal

A proof of concept that measurably reduces both forms of bloat **and is
retro-compatible** with current MCP clients and servers — it must drop into
Claude Code today with zero protocol changes on either side.

## Non-goals

- A new wire protocol or clean-slate MCP successor.
- Client-side changes of any kind.
- Dynamic tool activation via `tools/list_changed` (deferred to a possible
  Phase 2; see "Approach" below).

## Approach

The PoC is a **gateway**: a process that is simultaneously a standard MCP
*server* (facing the host) and a standard MCP *client* (facing the real
servers). The host spawns it like any other MCP server; it connects out to the
real servers like any other MCP client. Neither side knows it is special —
that is the retro-compatibility mechanism.

```
Claude Code ──stdio MCP──▶ lean-mcp gateway ──stdio / streamable-HTTP MCP──▶ real servers
              (5 meta-tools)                   (real tool defs stay here)      (Notion, Gmail, …)
```

The host sees a fixed set of ~5 meta-tools and nothing else. Real tool schemas
live inside the gateway and are surfaced only when the model explicitly asks
for them.

### Approach chosen: Universal call gateway (Approach A)

The host always sees the same ~5 meta-tools. To run a real downstream tool the
model calls `call_tool(server, name, arguments)`; the gateway validates the
arguments against the cached downstream schema and forwards the call.

- Context cost is **flat** (~1.5k tokens) regardless of how many downstream
  servers or tools exist.
- Works with *every* MCP client — no dependency on optional protocol features.
- Trade-off: tool calls are indirect, so the host cannot do per-tool schema
  validation. The gateway performs that validation instead.

**Rejected alternative — Approach B (dynamic activation):** start with only
`search_tools`, then inject a real tool definition and fire
`notifications/tools/list_changed` when the model selects it. Gives native
tool calls but only works on clients that honor `list_changed` mid-session.
Rejected because retro-compatibility was the priority. `call_tool` will be
designed so Approach B can be layered on later without redesign.

## Architecture

### Components

Small files, one responsibility each (per coding-style rules: 200-400 lines
typical).

| File | Responsibility |
|------|----------------|
| `src/config.ts` | Parse the downstream-server list. **Reuses the standard MCP `mcpServers` JSON shape**, so an existing Claude Code config can be pasted in unchanged. Retro-compat at the config layer. |
| `src/client-pool.ts` | One MCP client per configured server. Connects via stdio or streamable HTTP, calls `tools/list`, caches the definitions. A connect failure marks the server *degraded* — not fatal. |
| `src/registry.ts` | Flattens all downstream tools into a single namespace. Holds the canonical JSON Schema for each tool. Source of truth for search and validation. |
| `src/search.ts` | Hand-rolled BM25 ranking (~80 lines, no external dependency) over `name + description + parameter names`. |
| `src/result-store.ts` | In-memory `handle -> full result` map with TTL eviction. Backs `read_result`. |
| `src/summarizer.ts` | When a downstream result exceeds the token budget, summarize it with Claude Haiku 4.5. **Graceful degradation:** if no `ANTHROPIC_API_KEY` is set, fall back to head/tail truncation. The PoC runs with or without a key. |
| `src/meta-tools.ts` | Defines the 5 host-facing meta-tools and their handlers. |
| `src/server.ts` | Entry point. Wires the meta-tools, opens the stdio transport. |
| `src/tokens.ts` | A `chars / 4` estimate for fast runtime budgeting, plus the Anthropic `count_tokens` API for accurate benchmark figures. |

### The 5 meta-tools

- `search_tools(query, limit=5)` — BM25 search over the registry. Returns
  ranked matches as `{server, name, oneLineDescription, score}`. **No JSON
  Schema** in the response. ~200 tokens.
- `inspect_tool(server, name)` — returns the full JSON Schema for one tool.
  This is the pay-per-use expansion. ~400 tokens, charged once.
- `call_tool(server, name, arguments)` — validates `arguments` against the
  cached schema (ajv), forwards the call through the client pool, returns the
  result (summarized if it exceeds the budget).
- `read_result(handle, offset?, limit?)` — pages through a raw stored result.
- `list_servers()` — returns server names, connection status, and tool counts.
  Cheap orientation for the model.

### Data flow — a single tool call

1. Model calls `search_tools("send a slack message")`. Gateway runs BM25,
   returns the top 5 matches (names + one-liners only). ~200 tokens.
2. Model calls `inspect_tool("slack", "post_message")`. Gateway returns the
   full schema. ~400 tokens, paid once.
3. Model calls `call_tool("slack", "post_message", {channel, text})`. Gateway
   validates the arguments against the cached schema, forwards via the client
   pool, receives the downstream result.
4. Result size check: if it exceeds the budget, the summarizer produces
   `{summary, handle, originalTokens}`; otherwise the result is returned
   inline.
5. Optionally the model calls `read_result(handle, offset=200)` to page in
   more of the raw result.

## Error handling

- **Downstream connect failure** — server marked degraded, excluded from
  search, surfaced in `list_servers`. Not fatal to the gateway.
- **Argument validation failure** — `call_tool` returns a structured error
  *including the schema*, so the model can correct and retry. No exception
  thrown.
- **Downstream call error** — wrapped and returned as tool-error content. The
  gateway does not crash.
- **Summarizer / API failure** — fall back to truncation. A call never fails
  because summarization failed.
- **Unknown handle** in `read_result` — clear, explicit error.

## Proof — benchmark

The PoC must demonstrate the savings. `bench/benchmark.ts` connects to the
user's 6 real MCP servers and reports:

- **Baseline** — total tokens of all raw downstream tool definitions (what
  stock MCP would inject into the system prompt).
- **Gateway** — tokens of the 5 meta-tool definitions.
- **Savings %**.
- A scripted scenario (`search_tools` -> `inspect_tool` -> `call_tool`) that
  shows realistic per-task token cost, not just the static floor.

Token counts for the benchmark use the Anthropic `count_tokens` API for
accuracy; runtime budgeting uses the fast `chars / 4` estimate.

## Testing

Target 80%+ coverage, test-driven (per project rules).

- **Unit** — BM25 ranking, argument validation, result-store TTL eviction,
  summarizer truncation fallback, config parsing.
- **Integration** — `test/fixtures/fake-server.ts` is a fake downstream MCP
  server exposing a handful of tools; the gateway is driven end-to-end
  (`search` -> `inspect` -> `call` -> `read_result`).
- The Anthropic API is mocked in all automated tests.
- **E2E (manual)** — register the gateway in Claude Code, point it at the real
  servers, run the benchmark.

## Stack

- `@modelcontextprotocol/sdk` — MCP server and client.
- `ajv` — JSON Schema validation of `call_tool` arguments.
- `zod` — meta-tool input schemas (used by the MCP SDK).
- `@anthropic-ai/sdk` — Haiku 4.5 summarization (optional code path).
- `vitest` — test runner.
- BM25 — hand-rolled, no dependency.

Language: TypeScript / Node (Node 23 available; `@modelcontextprotocol/sdk` is
the reference implementation with the best transport coverage).

## Project layout

```
~/lean-mcp/
  src/
    config.ts
    client-pool.ts
    registry.ts
    search.ts
    result-store.ts
    summarizer.ts
    meta-tools.ts
    server.ts
    tokens.ts
  bench/
    benchmark.ts
  test/
    *.test.ts
    fixtures/fake-server.ts
  docs/superpowers/specs/2026-05-20-lean-mcp-design.md
  package.json
  tsconfig.json
  lean-mcp.config.json   (sample downstream-server config)
  README.md
```

## Build phases

1. **Discovery** — `config`, `client-pool`, `registry`, `search`; meta-tools
   `search_tools`, `inspect_tool`, `list_servers`; the benchmark. Definition
   bloat solved and measured.
2. **Calling** — `call_tool` with argument validation and downstream
   forwarding.
3. **Results** — `result-store`, `summarizer`, `read_result`. Result bloat
   solved.
4. **Polish** — benchmark output, README, register the gateway in Claude Code
   and validate end-to-end.

## Future work (out of scope for the PoC)

- Approach B: dynamic tool activation via `tools/list_changed` for clients
  that support it.
- Persistent result store (currently in-memory).
- Semantic search to complement BM25.
