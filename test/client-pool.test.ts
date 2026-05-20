import { describe, it, expect } from "vitest";
import { ClientPool } from "../src/client-pool.js";
import type { ServerConfig } from "../src/types.js";

describe("ClientPool", () => {
  it("throws when calling a tool on an unknown server", async () => {
    const pool = new ClientPool();
    await expect(pool.callTool("nope", "x", {})).rejects.toThrow(
      /Unknown server/,
    );
  });

  it("isolates a failed connection without crashing the pool", async () => {
    const bad: ServerConfig = {
      name: "broken",
      command: "lean-mcp-no-such-binary-xyz",
      args: [],
    };
    const pool = new ClientPool();
    await pool.connectAll([bad]);

    const status = pool.statuses()[0];
    expect(status).toMatchObject({ name: "broken", connected: false });
    expect(status?.error).toBeTruthy();
    expect(pool.allTools()).toEqual([]);
  });

  it("throws an actionable error when calling a degraded server", async () => {
    const pool = new ClientPool();
    await pool.connectAll([
      { name: "broken", command: "lean-mcp-no-such-binary-xyz", args: [] },
    ]);
    await expect(pool.callTool("broken", "x", {})).rejects.toThrow(
      /not connected/,
    );
  });

  it("builds an http transport for a url server with static headers", async () => {
    const pool = new ClientPool();
    await pool.connectAll([
      {
        name: "api",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer x" },
      },
    ]);
    expect(pool.statuses()[0]).toMatchObject({
      name: "api",
      transport: "http",
      connected: false,
    });
    await pool.close();
  });

  it("attaches an oauth provider for a url server without headers", async () => {
    const pool = new ClientPool();
    await pool.connectAll([{ name: "remote", url: "http://127.0.0.1:9/mcp" }]);
    expect(pool.statuses()[0]).toMatchObject({
      name: "remote",
      transport: "http",
      connected: false,
    });
    await pool.close();
  });

  it("closes cleanly with no connections", async () => {
    await expect(new ClientPool().close()).resolves.toBeUndefined();
  });
});
