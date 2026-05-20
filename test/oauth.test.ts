import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOAuthProvider, gatewayOAuthProvider } from "../src/oauth.js";
import type { RedirectHandler } from "../src/oauth.js";

const REDIRECT = "http://127.0.0.1:9999/callback";

describe("FileOAuthProvider", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lean-mcp-oauth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (onRedirect: RedirectHandler = () => {}): FileOAuthProvider =>
    new FileOAuthProvider("srv", REDIRECT, onRedirect, dir);

  it("exposes the redirect url and client metadata", () => {
    const provider = make();
    expect(provider.redirectUrl).toBe(REDIRECT);
    expect(provider.clientMetadata.redirect_uris).toEqual([REDIRECT]);
    expect(provider.clientMetadata.client_name).toBe("lean-mcp");
    expect(provider.clientMetadata.grant_types).toContain("refresh_token");
  });

  it("generates a unique hex state on each call", () => {
    const provider = make();
    const a = provider.state();
    const b = provider.state();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it("round-trips client information", () => {
    const provider = make();
    expect(provider.clientInformation()).toBeUndefined();
    provider.saveClientInformation({
      client_id: "cid",
      redirect_uris: [REDIRECT],
    });
    expect(provider.clientInformation()?.client_id).toBe("cid");
  });

  it("round-trips tokens", () => {
    const provider = make();
    expect(provider.tokens()).toBeUndefined();
    provider.saveTokens({ access_token: "at", token_type: "bearer" });
    expect(provider.tokens()?.access_token).toBe("at");
  });

  it("throws for the code verifier before one is saved", () => {
    expect(() => make().codeVerifier()).toThrow(/code verifier/);
  });

  it("returns a saved code verifier", () => {
    const provider = make();
    provider.saveCodeVerifier("verifier-123");
    expect(provider.codeVerifier()).toBe("verifier-123");
  });

  it("reads the verifier from disk in a fresh instance", () => {
    make().saveCodeVerifier("persisted");
    expect(make().codeVerifier()).toBe("persisted");
  });

  it("delegates redirectToAuthorization to the handler", async () => {
    let seen: URL | undefined;
    const provider = make((url) => {
      seen = url;
    });
    await provider.redirectToAuthorization(
      new URL("https://auth.example/authorize"),
    );
    expect(seen?.href).toBe("https://auth.example/authorize");
  });

  it("invalidateCredentials 'all' clears every credential", () => {
    const provider = make();
    provider.saveTokens({ access_token: "at", token_type: "bearer" });
    provider.invalidateCredentials("all");
    expect(provider.tokens()).toBeUndefined();
  });

  it("invalidateCredentials 'tokens' clears tokens but keeps the client", () => {
    const provider = make();
    provider.saveClientInformation({
      client_id: "cid",
      redirect_uris: [REDIRECT],
    });
    provider.saveTokens({ access_token: "at", token_type: "bearer" });
    provider.invalidateCredentials("tokens");
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()?.client_id).toBe("cid");
  });

  it("invalidateCredentials 'verifier' is a no-op that leaves tokens intact", () => {
    const provider = make();
    provider.saveTokens({ access_token: "at", token_type: "bearer" });
    provider.invalidateCredentials("verifier");
    expect(provider.tokens()?.access_token).toBe("at");
  });
});

describe("gatewayOAuthProvider", () => {
  it("refuses an interactive redirect with an actionable message", () => {
    const provider = gatewayOAuthProvider("notion");
    expect(() =>
      provider.redirectToAuthorization(new URL("https://auth.example/a")),
    ).toThrow(/lean-mcp auth notion/);
  });
});
