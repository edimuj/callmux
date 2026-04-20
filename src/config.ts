import { readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { CallmuxConfig, ServerConfig } from "./types.js";

/**
 * Resolve the default config file path, checking in order:
 * 1. $CALLMUX_CONFIG env var
 * 2. ~/.config/callmux/config.json (cross-platform)
 *
 * Returns the path if the file exists, undefined otherwise.
 */
export async function findDefaultConfig(): Promise<string | undefined> {
  const candidates: string[] = [];

  if (process.env.CALLMUX_CONFIG) {
    candidates.push(resolve(process.env.CALLMUX_CONFIG));
  }

  candidates.push(join(homedir(), ".config", "callmux", "config.json"));

  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {}
  }
  return undefined;
}

/**
 * Load callmux config from a JSON file or inline MCP server definitions.
 *
 * Accepts two formats:
 *
 * 1. Full callmux config:
 * {
 *   "servers": { "github": { "command": "...", "args": [...] } },
 *   "cacheTtlSeconds": 60
 * }
 *
 * 2. MCP-compatible mcpServers format (from .mcp.json / Claude Code settings):
 * {
 *   "mcpServers": { "github": { "command": "...", "args": [...] } }
 * }
 */
export async function loadConfig(configPath: string): Promise<CallmuxConfig> {
  const raw = await readFile(resolve(configPath), "utf-8");
  const parsed = JSON.parse(raw);

  // Full callmux config
  if (parsed.servers && typeof parsed.servers === "object") {
    return {
      servers: parsed.servers as Record<string, ServerConfig>,
      cacheTtlSeconds: parsed.cacheTtlSeconds ?? 0,
      maxConcurrency: parsed.maxConcurrency ?? 20,
    };
  }

  // MCP-compatible format
  if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
    return {
      servers: parsed.mcpServers as Record<string, ServerConfig>,
      cacheTtlSeconds: parsed.cacheTtlSeconds ?? 0,
      maxConcurrency: parsed.maxConcurrency ?? 20,
    };
  }

  throw new Error(
    "Invalid config: expected { servers: {...} } or { mcpServers: {...} }"
  );
}

/**
 * Build config from CLI arguments for single-server mode.
 * callmux -- command arg1 arg2
 */
export function configFromArgs(args: string[]): CallmuxConfig {
  const dashDash = args.indexOf("--");
  if (dashDash === -1 || dashDash === args.length - 1) {
    throw new Error("Usage: callmux [options] -- command [args...]");
  }

  const command = args[dashDash + 1];
  const commandArgs = args.slice(dashDash + 2);

  let cacheTtl = 0;
  let maxConcurrency = 20;
  let tools: string[] | undefined;

  for (let i = 0; i < dashDash; i++) {
    if (args[i] === "--cache" && i + 1 < dashDash) {
      cacheTtl = parseInt(args[++i], 10) || 0;
    } else if (args[i] === "--concurrency" && i + 1 < dashDash) {
      maxConcurrency = parseInt(args[++i], 10) || 20;
    } else if (args[i] === "--tools" && i + 1 < dashDash) {
      tools = args[++i].split(",").map((t) => t.trim()).filter(Boolean);
    }
  }

  return {
    servers: {
      default: { command, args: commandArgs, tools },
    },
    cacheTtlSeconds: cacheTtl,
    maxConcurrency,
  };
}
