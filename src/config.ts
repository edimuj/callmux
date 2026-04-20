import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  CachePolicyConfig,
  CallmuxConfig,
  ConfigFormat,
  ServerConfig,
} from "./types.js";

function parseNonNegativeInteger(value: unknown, optionName: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }

  return value as number;
}

function parsePositiveInteger(value: unknown, optionName: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }

  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStringArray(
  value: unknown,
  optionName: string
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${optionName} must be an array of strings`);
  }
  return value;
}

function parseStringRecord(
  value: unknown,
  optionName: string
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object of string values`);
  }

  const entries = Object.entries(value);
  if (!entries.every(([, nested]) => typeof nested === "string")) {
    throw new Error(`${optionName} must be an object of string values`);
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function parseCachePolicy(
  value: unknown,
  optionName: string
): CachePolicyConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const allowTools = parseStringArray(
    value.allowTools,
    `${optionName}.allowTools`
  );
  const denyTools = parseStringArray(
    value.denyTools,
    `${optionName}.denyTools`
  );

  if (!allowTools && !denyTools) {
    return undefined;
  }

  return {
    ...(allowTools ? { allowTools } : {}),
    ...(denyTools ? { denyTools } : {}),
  };
}

function parseServerConfig(value: unknown, serverName: string): ServerConfig {
  if (!isRecord(value)) {
    throw new Error(`servers.${serverName} must be an object`);
  }

  if (typeof value.command !== "string" || value.command.length === 0) {
    throw new Error(`servers.${serverName}.command must be a non-empty string`);
  }

  if (value.args !== undefined && !Array.isArray(value.args)) {
    throw new Error(`servers.${serverName}.args must be an array of strings`);
  }

  const args = parseStringArray(value.args, `servers.${serverName}.args`);
  const env = parseStringRecord(value.env, `servers.${serverName}.env`);
  const tools = parseStringArray(value.tools, `servers.${serverName}.tools`);
  const cachePolicy = parseCachePolicy(
    value.cachePolicy,
    `servers.${serverName}.cachePolicy`
  );
  const cwd =
    value.cwd === undefined
      ? undefined
      : typeof value.cwd === "string"
        ? value.cwd
        : (() => {
            throw new Error(`servers.${serverName}.cwd must be a string`);
          })();

  return {
    command: value.command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tools ? { tools } : {}),
    ...(cachePolicy ? { cachePolicy } : {}),
  };
}

function parseServers(
  value: unknown,
  optionName: string
): Record<string, ServerConfig> {
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, config]) => [name, parseServerConfig(config, name)])
  );
}

function parseConfigDocument(parsed: Record<string, unknown>): {
  config: CallmuxConfig;
  format: ConfigFormat;
} {
  const parseSharedFields = () => {
    const cachePolicy = parseCachePolicy(parsed.cachePolicy, "cachePolicy");
    return {
      cacheTtlSeconds:
        parsed.cacheTtlSeconds === undefined
          ? 0
          : parseNonNegativeInteger(parsed.cacheTtlSeconds, "cacheTtlSeconds"),
      ...(cachePolicy ? { cachePolicy } : {}),
      maxConcurrency:
        parsed.maxConcurrency === undefined
          ? 20
          : parsePositiveInteger(parsed.maxConcurrency, "maxConcurrency"),
    };
  };

  if (parsed.servers && typeof parsed.servers === "object") {
    return {
      config: {
        servers: parseServers(parsed.servers, "servers"),
        ...parseSharedFields(),
      },
      format: "native",
    };
  }

  if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
    return {
      config: {
        servers: parseServers(parsed.mcpServers, "mcpServers"),
        ...parseSharedFields(),
      },
      format: "mcpCompatible",
    };
  }

  throw new Error(
    "Invalid config: expected { servers: {...} } or { mcpServers: {...} }"
  );
}

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

  candidates.push(getDefaultConfigPath());

  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {}
  }
  return undefined;
}

export function getDefaultConfigPath(): string {
  return join(homedir(), ".config", "callmux", "config.json");
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
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return parseConfigDocument(parsed).config;
}

export async function loadConfigWithMetadata(configPath: string): Promise<{
  config: CallmuxConfig;
  format: ConfigFormat;
}> {
  const raw = await readFile(resolve(configPath), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return parseConfigDocument(parsed);
}

export async function loadManagedConfig(
  configPath: string
): Promise<CallmuxConfig | null> {
  const resolvedPath = resolve(configPath);

  try {
    const { config, format } = await loadConfigWithMetadata(resolvedPath);
    if (format === "mcpCompatible") {
      throw new Error(
        "Managed server commands require native callmux config with a top-level \"servers\" object"
      );
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveManagedConfig(
  configPath: string,
  config: CallmuxConfig
): Promise<void> {
  const resolvedPath = resolve(configPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf-8"
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
  let cacheAllowTools: string[] | undefined;
  let cacheDenyTools: string[] | undefined;
  const env: Record<string, string> = {};

  for (let i = 0; i < dashDash; i++) {
    if (args[i] === "--cache" && i + 1 < dashDash) {
      const value = Number.parseInt(args[++i], 10);
      cacheTtl = parseNonNegativeInteger(value, "--cache");
    } else if (args[i] === "--concurrency" && i + 1 < dashDash) {
      const value = Number.parseInt(args[++i], 10);
      maxConcurrency = parsePositiveInteger(value, "--concurrency");
    } else if (args[i] === "--tools" && i + 1 < dashDash) {
      tools = args[++i].split(",").map((t) => t.trim()).filter(Boolean);
    } else if (args[i] === "--cache-allow" && i + 1 < dashDash) {
      cacheAllowTools = args[++i].split(",").map((t) => t.trim()).filter(Boolean);
    } else if (args[i] === "--cache-deny" && i + 1 < dashDash) {
      cacheDenyTools = args[++i].split(",").map((t) => t.trim()).filter(Boolean);
    } else if (args[i] === "--env" && i + 1 < dashDash) {
      const pair = args[++i];
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        throw new Error(`Invalid --env value "${pair}": must be KEY=VALUE`);
      }
      env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }

  return {
    servers: {
      default: {
        command,
        args: commandArgs,
        tools,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        cachePolicy:
          cacheAllowTools?.length || cacheDenyTools?.length
            ? {
                ...(cacheAllowTools?.length
                  ? { allowTools: cacheAllowTools }
                  : {}),
                ...(cacheDenyTools?.length
                  ? { denyTools: cacheDenyTools }
                  : {}),
              }
            : undefined,
      },
    },
    cacheTtlSeconds: cacheTtl,
    maxConcurrency,
  };
}
