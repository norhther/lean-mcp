import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** Everything persisted for one OAuth-authenticated downstream server. */
export interface StoredAuth {
  /** Dynamic Client Registration result — the gateway's client_id/secret. */
  clientInformation?: OAuthClientInformationFull;
  /** Access + refresh tokens. */
  tokens?: OAuthTokens;
  /** PKCE code verifier, held only between redirect and code exchange. */
  codeVerifier?: string;
}

/** Default credential directory. Kept out of the repo and out of VCS. */
export function defaultAuthDir(): string {
  return join(homedir(), ".lean-mcp");
}

/**
 * File-backed credential storage, one JSON file per downstream server.
 *
 * Files are written 0600 inside a 0700 directory so other local users cannot
 * read cached tokens. The directory is configurable to keep tests off the
 * real home directory.
 */
export class OAuthStore {
  private readonly file: string;

  constructor(
    server: string,
    private readonly dir: string = defaultAuthDir(),
  ) {
    // server names come from a user config; sanitize before using as a path
    const safe = server.replace(/[^a-zA-Z0-9._-]/g, "_");
    this.file = join(dir, `${safe}.json`);
  }

  /** Load stored credentials, or an empty record if none / unreadable. */
  load(): StoredAuth {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as StoredAuth;
    } catch {
      return {};
    }
  }

  /** Merge a patch into stored credentials and persist. */
  save(patch: Partial<StoredAuth>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const merged: StoredAuth = { ...this.load(), ...patch };
    writeFileSync(this.file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  }

  /** Delete all stored credentials for this server. */
  clear(): void {
    if (existsSync(this.file)) rmSync(this.file);
  }
}
