import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrowser,
  runAuthCommand,
  startCallbackServer,
} from "../src/auth-command.js";

describe("startCallbackServer", () => {
  it("resolves waitForCode when a code redirect arrives", async () => {
    const cb = await startCallbackServer();
    const res = await fetch(`http://127.0.0.1:${cb.port}/callback?code=abc123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Authorized");
    await expect(cb.waitForCode).resolves.toBe("abc123");
  });

  it("rejects waitForCode when an error redirect arrives", async () => {
    const cb = await startCallbackServer();
    await fetch(`http://127.0.0.1:${cb.port}/callback?error=access_denied`);
    await expect(cb.waitForCode).rejects.toThrow(/access_denied/);
  });

  it("returns 404 for a non-callback path", async () => {
    const cb = await startCallbackServer();
    const res = await fetch(`http://127.0.0.1:${cb.port}/elsewhere`);
    expect(res.status).toBe(404);
    cb.close();
  });

  it("escapes html in the reflected error message", async () => {
    const cb = await startCallbackServer();
    const res = await fetch(
      `http://127.0.0.1:${cb.port}/callback?error=${encodeURIComponent(
        "<script>x</script>",
      )}`,
    );
    const body = await res.text();
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("<script>x");
    await expect(cb.waitForCode).rejects.toThrow();
  });
});

describe("openBrowser", () => {
  it("does not throw for an unreachable url", () => {
    expect(() => openBrowser("http://127.0.0.1:1/never")).not.toThrow();
  });
});

describe("runAuthCommand", () => {
  let dir: string;

  const writeConfig = (cfg: unknown): string => {
    const path = join(dir, "cfg.json");
    writeFileSync(path, JSON.stringify(cfg));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lean-mcp-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws when the server is not in the config", async () => {
    const path = writeConfig({
      mcpServers: { other: { url: "https://example.com/mcp" } },
    });
    await expect(runAuthCommand("missing", path, () => {})).rejects.toThrow(
      /not found/,
    );
  });

  it("throws for a stdio server", async () => {
    const path = writeConfig({ mcpServers: { local: { command: "node" } } });
    await expect(runAuthCommand("local", path, () => {})).rejects.toThrow(
      /stdio/,
    );
  });

  it("throws for a static-header server", async () => {
    const path = writeConfig({
      mcpServers: {
        api: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer t" },
        },
      },
    });
    await expect(runAuthCommand("api", path, () => {})).rejects.toThrow(
      /static header/,
    );
  });

  it("returns early when cached tokens are already valid", async () => {
    const path = writeConfig({
      mcpServers: { remote: { url: "https://example.com/mcp" } },
    });
    await expect(
      runAuthCommand("remote", path, () => {}, async () => "AUTHORIZED"),
    ).resolves.toBeUndefined();
  });

  it("exchanges the code delivered to the callback server", async () => {
    const path = writeConfig({
      mcpServers: { remote: { url: "https://example.com/mcp" } },
    });
    let calls = 0;
    await expect(
      runAuthCommand("remote", path, () => {}, async (provider, options) => {
        calls += 1;
        if (calls === 1) {
          await fetch(`${String(provider.redirectUrl)}?code=the-code`);
          return "REDIRECT";
        }
        expect(options.authorizationCode).toBe("the-code");
        return "AUTHORIZED";
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("throws when the token exchange does not complete", async () => {
    const path = writeConfig({
      mcpServers: { remote: { url: "https://example.com/mcp" } },
    });
    let calls = 0;
    await expect(
      runAuthCommand("remote", path, () => {}, async (provider) => {
        calls += 1;
        if (calls === 1) {
          await fetch(`${String(provider.redirectUrl)}?code=c`);
        }
        return "REDIRECT";
      }),
    ).rejects.toThrow(/did not complete/);
  });
});
