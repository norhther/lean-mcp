import { readFileSync } from "node:fs";
import type { ServerConfig } from "./types.js";

/**
 * Parse a downstream-server config. Reuses the standard MCP `mcpServers`
 * shape so an existing Claude Code config can be pasted in unchanged.
 *
 * Keys beginning with `_` are ignored (allows `_comment` fields).
 */
export function parseConfig(raw: string): ServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in config: ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) {
    throw new Error('Config must have a top-level "mcpServers" object');
  }

  const servers = (parsed as { mcpServers: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null) {
    throw new Error('"mcpServers" must be an object');
  }

  const result: ServerConfig[] = [];
  for (const [name, definition] of Object.entries(
    servers as Record<string, unknown>,
  )) {
    if (name.startsWith("_")) continue;
    if (typeof definition !== "object" || definition === null) {
      throw new Error(`Server "${name}" must be an object`);
    }
    const def = definition as Record<string, unknown>;

    if (typeof def.url === "string") {
      result.push({ name, url: def.url });
    } else if (typeof def.command === "string") {
      result.push({
        name,
        command: def.command,
        args: Array.isArray(def.args) ? def.args.map(String) : [],
        env: isStringRecord(def.env) ? def.env : undefined,
      });
    } else {
      throw new Error(
        `Server "${name}" must have either "command" (stdio) or "url" (http)`,
      );
    }
  }
  return result;
}

/** Load and parse a config file from disk. */
export function loadConfig(path: string): ServerConfig[] {
  return parseConfig(readFileSync(path, "utf8"));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
