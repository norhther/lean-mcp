import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStore } from "../src/oauth-store.js";

describe("OAuthStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lean-mcp-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty record when nothing is stored", () => {
    expect(new OAuthStore("srv", dir).load()).toEqual({});
  });

  it("persists and merges successive patches", () => {
    const store = new OAuthStore("srv", dir);
    store.save({ codeVerifier: "v1" });
    store.save({ tokens: { access_token: "a", token_type: "bearer" } });
    expect(store.load()).toEqual({
      codeVerifier: "v1",
      tokens: { access_token: "a", token_type: "bearer" },
    });
  });

  it("writes the credential file with 0600 permissions", () => {
    new OAuthStore("srv", dir).save({ codeVerifier: "v" });
    const mode = statSync(join(dir, "srv.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("clear deletes the credential file", () => {
    const store = new OAuthStore("srv", dir);
    store.save({ codeVerifier: "v" });
    store.clear();
    expect(existsSync(join(dir, "srv.json"))).toBe(false);
  });

  it("clear is a no-op when nothing is stored", () => {
    expect(() => new OAuthStore("srv", dir).clear()).not.toThrow();
  });

  it("returns an empty record when the file is corrupt", () => {
    const store = new OAuthStore("srv", dir);
    store.save({ codeVerifier: "v" });
    writeFileSync(join(dir, "srv.json"), "{not valid json");
    expect(store.load()).toEqual({});
  });

  it("sanitizes unsafe server names so they cannot escape the directory", () => {
    new OAuthStore("../evil/name", dir).save({ codeVerifier: "v" });
    expect(existsSync(join(dir, ".._evil_name.json"))).toBe(true);
  });
});
