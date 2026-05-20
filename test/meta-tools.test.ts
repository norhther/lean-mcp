import { describe, it, expect } from "vitest";
import { MetaTools } from "../src/meta-tools.js";
import { ToolRegistry } from "../src/registry.js";
import { ResultStore } from "../src/result-store.js";
import type { ClientPool, DownstreamResult } from "../src/client-pool.js";
import type { ServerStatus, ToolEntry } from "../src/types.js";
import type { SummarizerOptions } from "../src/summarizer.js";

const tools: ToolEntry[] = [
  {
    server: "math",
    name: "add",
    description: "Add two numbers together.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    server: "fs",
    name: "read_file",
    description: "Read a file from disk.\nSecond line is dropped.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

interface FakePool {
  callTool?: (
    server: string,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<DownstreamResult>;
  statuses?: () => ServerStatus[];
}

function makePool(fake: FakePool = {}): ClientPool {
  return {
    callTool:
      fake.callTool ??
      (async () => ({ content: [{ type: "text", text: "ok" }], isError: false })),
    statuses: fake.statuses ?? (() => []),
  } as unknown as ClientPool;
}

function makeMeta(pool: ClientPool, summarizer?: SummarizerOptions) {
  const registry = new ToolRegistry();
  registry.setTools(tools);
  const store = new ResultStore();
  const meta = new MetaTools({ registry, pool, store, summarizer });
  return { meta, store };
}

describe("MetaTools.searchTools", () => {
  it("ranks tools by a free-text query and collapses descriptions", () => {
    const { meta } = makeMeta(makePool());
    const out = meta.searchTools("add two numbers", 5);
    expect(out.results[0]?.name).toBe("add");
    expect(out.count).toBe(out.results.length);
  });

  it("returns one-line descriptions", () => {
    const { meta } = makeMeta(makePool());
    const hit = meta.searchTools("read a file", 1).results[0];
    expect(hit?.description).toBe("Read a file from disk.");
  });
});

describe("MetaTools.inspectTool", () => {
  it("returns the full schema for a known tool", () => {
    const { meta } = makeMeta(makePool());
    const out = meta.inspectTool("math", "add");
    expect(out).toMatchObject({
      server: "math",
      name: "add",
      inputSchema: { required: ["a", "b"] },
    });
  });

  it("returns an actionable error for an unknown tool", () => {
    const { meta } = makeMeta(makePool());
    const out = meta.inspectTool("math", "subtract");
    expect("error" in out && out.error).toContain("search_tools");
  });
});

describe("MetaTools.callTool", () => {
  it("forwards a valid call and stores the full result under a handle", async () => {
    const { meta, store } = makeMeta(
      makePool({
        callTool: async () => ({
          content: [{ type: "text", text: "3" }],
          isError: false,
        }),
      }),
      { budgetTokens: 1000 },
    );
    const out = await meta.callTool("math", "add", { a: 1, b: 2 });
    expect(out).toMatchObject({ ok: true, result: "3", method: "inline" });
    if ("handle" in out) expect(store.get(out.handle)).toBe("3");
  });

  it("rejects an unknown tool without calling downstream", async () => {
    const { meta } = makeMeta(makePool());
    const out = await meta.callTool("math", "divide", {});
    expect(out).toMatchObject({ ok: false });
    expect("error" in out && out.error).toContain("search_tools");
  });

  it("rejects arguments that violate the schema", async () => {
    const { meta } = makeMeta(makePool());
    const out = await meta.callTool("math", "add", { a: 1 });
    expect(out.ok).toBe(false);
    expect("validationErrors" in out && out.validationErrors?.length).toBeTruthy();
  });

  it("reports a downstream error result as not ok", async () => {
    const { meta } = makeMeta(
      makePool({
        callTool: async () => ({
          content: [{ type: "text", text: "boom" }],
          isError: true,
        }),
      }),
      { budgetTokens: 1000 },
    );
    const out = await meta.callTool("math", "add", { a: 1, b: 2 });
    expect(out).toMatchObject({ ok: false, result: "boom" });
  });

  it("surfaces a thrown downstream exception as an error", async () => {
    const { meta } = makeMeta(
      makePool({
        callTool: async () => {
          throw new Error("server gone");
        },
      }),
    );
    const out = await meta.callTool("math", "add", { a: 1, b: 2 });
    expect(out).toMatchObject({ ok: false });
    expect("error" in out && out.error).toBe("server gone");
  });

  it("summarizes an oversized result but keeps the full text retrievable", async () => {
    const big = "x".repeat(40_000);
    const { meta, store } = makeMeta(
      makePool({
        callTool: async () => ({
          content: [{ type: "text", text: big }],
          isError: false,
        }),
      }),
      { budgetTokens: 50, llmSummarize: async () => "concise summary" },
    );
    const out = await meta.callTool("math", "add", { a: 1, b: 2 });
    expect(out).toMatchObject({ ok: true, result: "concise summary", method: "llm" });
    if ("handle" in out) expect(store.get(out.handle)).toBe(big);
  });
});

describe("MetaTools.readResult", () => {
  it("pages the full stored result by handle", async () => {
    const { meta } = makeMeta(
      makePool({
        callTool: async () => ({
          content: [{ type: "text", text: "0123456789" }],
          isError: false,
        }),
      }),
      { budgetTokens: 1000 },
    );
    const call = await meta.callTool("math", "add", { a: 1, b: 2 });
    const handle = "handle" in call ? call.handle : "";
    expect(meta.readResult(handle, 0, 4)).toMatchObject({
      text: "0123",
      nextOffset: 4,
      total: 10,
    });
  });

  it("returns an error for an unknown handle", () => {
    const { meta } = makeMeta(makePool());
    const out = meta.readResult("res_999");
    expect("error" in out && out.error).toContain("res_999");
  });
});

describe("MetaTools.listServers", () => {
  it("reports downstream connection status", () => {
    const statuses: ServerStatus[] = [
      { name: "math", transport: "stdio", connected: true, toolCount: 1 },
    ];
    const { meta } = makeMeta(makePool({ statuses: () => statuses }));
    expect(meta.listServers()).toEqual({ servers: statuses });
  });
});
