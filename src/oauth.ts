import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthStore } from "./oauth-store.js";

/** Invoked when the SDK needs the user to visit an authorization URL. */
export type RedirectHandler = (url: URL) => void | Promise<void>;

/**
 * An `OAuthClientProvider` whose state lives in a file, not memory.
 *
 * The same class serves two callers:
 *  - the `lean-mcp auth` command, which passes a `redirect` handler that opens
 *    a browser and completes a full authorization;
 *  - the gateway, which passes a handler that throws — it can refresh tokens
 *    silently but must never block on an interactive flow.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private readonly store: OAuthStore;
  private verifierCache?: string;

  constructor(
    server: string,
    private readonly redirect: string,
    private readonly onRedirect: RedirectHandler,
    dir?: string,
  ) {
    this.store = new OAuthStore(server, dir);
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirect],
      client_name: "lean-mcp",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return randomBytes(16).toString("hex");
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.store.load().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.store.save({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.save({ tokens });
  }

  redirectToAuthorization(url: URL): void | Promise<void> {
    return this.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifierCache = verifier;
    this.store.save({ codeVerifier: verifier });
  }

  codeVerifier(): string {
    const verifier = this.verifierCache ?? this.store.load().codeVerifier;
    if (!verifier) {
      throw new Error("No PKCE code verifier — start authorization first");
    }
    return verifier;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all") {
      this.store.clear();
    } else if (scope === "tokens") {
      this.store.save({ tokens: undefined });
    }
  }
}

/**
 * Build a provider for the gateway: it can use and refresh stored tokens but
 * refuses to start an interactive flow, surfacing an actionable instruction
 * instead. The redirect URL is a placeholder — the gateway never registers a
 * fresh client (that happens once, in the `auth` command).
 */
export function gatewayOAuthProvider(server: string): FileOAuthProvider {
  return new FileOAuthProvider(
    server,
    "http://127.0.0.1/lean-mcp-callback",
    () => {
      throw new Error(
        `server "${server}" needs authorization — run: lean-mcp auth ${server}`,
      );
    },
  );
}
