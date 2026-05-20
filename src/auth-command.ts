import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig } from "./config.js";
import { FileOAuthProvider } from "./oauth.js";

const CALLBACK_PATH = "/callback";

/** A running local HTTP server that catches one OAuth redirect. */
export interface CallbackServer {
  /** Ephemeral port the server is listening on. */
  port: number;
  /** Resolves with the authorization code once the redirect arrives. */
  waitForCode: Promise<string>;
  /** Stop listening. */
  close(): void;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => entities[c] ?? c);
}

function resultPage(code: string | null, error: string | null): string {
  const message = code
    ? "Authorized. You can close this tab and return to the terminal."
    : `Authorization failed: ${error ?? "no code returned"}.`;
  return (
    '<!doctype html><meta charset="utf-8"><title>lean-mcp</title>' +
    '<body style="font-family:system-ui;padding:2rem">' +
    `<h1>lean-mcp</h1><p>${escapeHtml(message)}</p></body>`
  );
}

/**
 * Start a loopback HTTP server on an ephemeral port that waits for exactly
 * one OAuth redirect. The redirect's `code` (or `error`) settles `waitForCode`.
 */
export function startCallbackServer(): Promise<CallbackServer> {
  return new Promise<CallbackServer>((resolveServer, rejectServer) => {
    let settle: {
      resolve: (code: string) => void;
      reject: (err: Error) => void;
    };
    const waitForCode = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // a rejection nobody is awaiting yet (e.g. early close) must not crash
    waitForCode.catch(() => {});

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(resultPage(code, error));
      server.close();
      if (code) {
        settle.resolve(code);
      } else {
        settle.reject(
          new Error(`authorization failed: ${error ?? "no code returned"}`),
        );
      }
    });

    server.on("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        server.close();
        rejectServer(new Error("could not determine callback port"));
        return;
      }
      resolveServer({
        port: address.port,
        waitForCode,
        close: () => server.close(),
      });
    });
  });
}

/** Open a URL in the user's default browser. Best-effort. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // launching a browser is best-effort; the URL is also printed to stderr
  }
}

/**
 * Run the interactive `lean-mcp auth <server>` flow: discover the server's
 * authorization server, register a client, open a browser for consent, catch
 * the redirect, exchange the code, and cache the resulting tokens.
 */
export async function runAuthCommand(
  serverName: string,
  configPath: string,
  log: (message: string) => void = (m) => process.stderr.write(`${m}\n`),
  authFn: typeof auth = auth,
): Promise<void> {
  const server = loadConfig(configPath).find((s) => s.name === serverName);
  if (!server) {
    throw new Error(`server "${serverName}" not found in ${configPath}`);
  }
  if (!server.url) {
    throw new Error(
      `server "${serverName}" is stdio — OAuth applies only to remote (url) servers`,
    );
  }
  if (server.headers) {
    throw new Error(
      `server "${serverName}" uses static header auth — no OAuth flow needed`,
    );
  }

  const callback = await startCallbackServer();
  const redirect = `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`;
  const provider = new FileOAuthProvider(serverName, redirect, (url) => {
    log(`opening browser for authorization:\n  ${url.toString()}`);
    openBrowser(url.toString());
  });

  try {
    const first = await authFn(provider, { serverUrl: server.url });
    if (first === "AUTHORIZED") {
      log(`already authorized — cached tokens for "${serverName}" are valid`);
      return;
    }
    log("waiting for the authorization callback...");
    const code = await callback.waitForCode;
    const final = await authFn(provider, {
      serverUrl: server.url,
      authorizationCode: code,
    });
    if (final !== "AUTHORIZED") {
      throw new Error("token exchange did not complete");
    }
    log(`authorized — tokens cached for "${serverName}"`);
  } finally {
    callback.close();
  }
}
