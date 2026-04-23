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

function parseIntegerOption(
  value: string,
  optionName: string,
  allowZero: boolean
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${optionName} must be ${allowZero ? "a non-negative" : "a positive"} integer`
    );
  }

  const parsed = Number(value);
  return allowZero
    ? parseNonNegativeInteger(parsed, optionName)
    : parsePositiveInteger(parsed, optionName);
}

function readOptionValue(
  args: string[],
  index: number,
  optionsLimit: number,
  optionName: string
): string {
  if (index + 1 >= optionsLimit) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return args[index + 1];
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

  const hasUrl = typeof value.url === "string" && value.url.length > 0;
  const hasCommand = typeof value.command === "string" && value.command.length > 0;

  if (!hasUrl && !hasCommand) {
    throw new Error(`servers.${serverName} must have either "command" (stdio) or "url" (http/sse)`);
  }

  if (hasUrl && hasCommand) {
    throw new Error(`servers.${serverName} cannot have both "command" and "url"`);
  }

  const tools = parseStringArray(value.tools, `servers.${serverName}.tools`);
  const cachePolicy = parseCachePolicy(
    value.cachePolicy,
    `servers.${serverName}.cachePolicy`
  );
  const maxConcurrency = value.maxConcurrency !== undefined
    ? parsePositiveInteger(value.maxConcurrency, `servers.${serverName}.maxConcurrency`)
    : undefined;

  const shared = {
    ...(tools ? { tools } : {}),
    ...(cachePolicy ? { cachePolicy } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
  };

  if (hasUrl) {
    const transport = value.transport === undefined
      ? undefined
      : (["streamable-http", "sse"].includes(value.transport as string)
        ? value.transport as "streamable-http" | "sse"
        : (() => { throw new Error(`servers.${serverName}.transport must be "streamable-http" or "sse"`); })());
    const headers = parseStringRecord(value.headers, `servers.${serverName}.headers`);

    return {
      url: value.url as string,
      ...(transport ? { transport } : {}),
      ...(headers ? { headers } : {}),
      ...shared,
    };
  }

  if (value.args !== undefined && !Array.isArray(value.args)) {
    throw new Error(`servers.${serverName}.args must be an array of strings`);
  }

  const args = parseStringArray(value.args, `servers.${serverName}.args`);
  const env = parseStringRecord(value.env, `servers.${serverName}.env`);
  const cwd =
    value.cwd === undefined
      ? undefined
      : typeof value.cwd === "string"
        ? value.cwd
        : (() => {
            throw new Error(`servers.${serverName}.cwd must be a string`);
          })();

  return {
    command: value.command as string,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...shared,
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
      ...(parsed.connectTimeoutMs !== undefined
        ? {
            connectTimeoutMs: parsePositiveInteger(
              parsed.connectTimeoutMs,
              "connectTimeoutMs"
            ),
          }
        : {}),
      ...(parsed.callTimeoutMs !== undefined
        ? {
            callTimeoutMs: parsePositiveInteger(
              parsed.callTimeoutMs,
              "callTimeoutMs"
            ),
          }
        : {}),
      ...(parsed.strictStartup !== undefined
        ? {
            strictStartup:
              typeof parsed.strictStartup === "boolean"
                ? parsed.strictStartup
                : (() => { throw new Error("strictStartup must be a boolean"); })(),
          }
        : {}),
      ...(parsed.maxCacheEntries !== undefined
        ? {
            maxCacheEntries: parsePositiveInteger(
              parsed.maxCacheEntries,
              "maxCacheEntries"
            ),
          }
        : {}),
      ...(parsed.metaOnly !== undefined
        ? {
            metaOnly:
              typeof parsed.metaOnly === "boolean"
                ? parsed.metaOnly
                : (() => { throw new Error("metaOnly must be a boolean"); })(),
          }
        : {}),
      ...(parsed.descriptionMaxLength !== undefined
        ? {
            descriptionMaxLength: parsePositiveInteger(
              parsed.descriptionMaxLength,
              "descriptionMaxLength"
            ),
          }
        : {}),
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

export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/edimuj/callmux/main/schema.json";

export async function saveManagedConfig(
  configPath: string,
  config: CallmuxConfig
): Promise<void> {
  const resolvedPath = resolve(configPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const withSchema = { $schema: CONFIG_SCHEMA_URL, ...config };
  await writeFile(
    resolvedPath,
    `${JSON.stringify(withSchema, null, 2)}\n`,
    "utf-8"
  );
}

/**
 * Build config from CLI arguments for single-server mode.
 * callmux -- command arg1 arg2
 * callmux --url https://mcp.example.com/sse
 */
export function configFromArgs(args: string[]): CallmuxConfig {
  let cacheTtl = 0;
  let maxConcurrency = 20;
  let maxCacheEntries: number | undefined;
  let connectTimeoutMs: number | undefined;
  let callTimeoutMs: number | undefined;
  let strictStartup = false;
  let metaOnly = false;
  let descriptionMaxLength: number | undefined;
  let tools: string[] | undefined;
  let cacheAllowTools: string[] | undefined;
  let cacheDenyTools: string[] | undefined;
  let url: string | undefined;
  let transport: "streamable-http" | "sse" | undefined;
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};

  const dashDash = args.indexOf("--");
  const optionsLimit = dashDash === -1 ? args.length : dashDash;

  for (let i = 0; i < optionsLimit; i++) {
    if (args[i] === "--cache") {
      const raw = readOptionValue(args, i, optionsLimit, "--cache");
      cacheTtl = parseIntegerOption(raw, "--cache", true);
      i++;
    } else if (args[i] === "--concurrency") {
      const raw = readOptionValue(args, i, optionsLimit, "--concurrency");
      maxConcurrency = parseIntegerOption(raw, "--concurrency", false);
      i++;
    } else if (args[i] === "--cache-max-entries") {
      const raw = readOptionValue(args, i, optionsLimit, "--cache-max-entries");
      maxCacheEntries = parseIntegerOption(raw, "--cache-max-entries", false);
      i++;
    } else if (args[i] === "--connect-timeout") {
      const raw = readOptionValue(args, i, optionsLimit, "--connect-timeout");
      connectTimeoutMs = parseIntegerOption(raw, "--connect-timeout", false);
      i++;
    } else if (args[i] === "--call-timeout") {
      const raw = readOptionValue(args, i, optionsLimit, "--call-timeout");
      callTimeoutMs = parseIntegerOption(raw, "--call-timeout", false);
      i++;
    } else if (args[i] === "--tools") {
      tools = readOptionValue(args, i, optionsLimit, "--tools").split(",").map((t) => t.trim()).filter(Boolean);
      i++;
    } else if (args[i] === "--cache-allow") {
      cacheAllowTools = readOptionValue(args, i, optionsLimit, "--cache-allow").split(",").map((t) => t.trim()).filter(Boolean);
      i++;
    } else if (args[i] === "--cache-deny") {
      cacheDenyTools = readOptionValue(args, i, optionsLimit, "--cache-deny").split(",").map((t) => t.trim()).filter(Boolean);
      i++;
    } else if (args[i] === "--env") {
      const pair = readOptionValue(args, i, optionsLimit, "--env");
      i++;
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        throw new Error(`Invalid --env value "${pair}": must be KEY=VALUE`);
      }
      env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if (args[i] === "--meta-only") {
      metaOnly = true;
    } else if (args[i] === "--strict-startup") {
      strictStartup = true;
    } else if (args[i] === "--description-max-length") {
      const raw = readOptionValue(args, i, optionsLimit, "--description-max-length");
      descriptionMaxLength = parseIntegerOption(raw, "--description-max-length", false);
      i++;
    } else if (args[i] === "--url") {
      url = readOptionValue(args, i, optionsLimit, "--url");
      i++;
    } else if (args[i] === "--transport") {
      const t = readOptionValue(args, i, optionsLimit, "--transport");
      i++;
      if (t !== "streamable-http" && t !== "sse") {
        throw new Error(`--transport must be "streamable-http" or "sse"`);
      }
      transport = t;
    } else if (args[i] === "--header") {
      const pair = readOptionValue(args, i, optionsLimit, "--header");
      i++;
      const colonIdx = pair.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`Invalid --header value "${pair}": must be Name:Value`);
      }
      headers[pair.slice(0, colonIdx).trim()] = pair.slice(colonIdx + 1).trim();
    } else {
      throw new Error(`Unknown option "${args[i]}"`);
    }
  }

  const cachePolicy =
    cacheAllowTools?.length || cacheDenyTools?.length
      ? {
          ...(cacheAllowTools?.length ? { allowTools: cacheAllowTools } : {}),
          ...(cacheDenyTools?.length ? { denyTools: cacheDenyTools } : {}),
        }
      : undefined;

  if (url) {
    if (dashDash !== -1) {
      throw new Error("Cannot use both --url and -- command");
    }
    return {
      servers: {
        default: {
          url,
          ...(transport ? { transport } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(tools ? { tools } : {}),
          ...(cachePolicy ? { cachePolicy } : {}),
        },
      },
      cacheTtlSeconds: cacheTtl,
      maxConcurrency,
      ...(maxCacheEntries !== undefined ? { maxCacheEntries } : {}),
      ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
      ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
      ...(strictStartup ? { strictStartup } : {}),
      ...(metaOnly ? { metaOnly } : {}),
      ...(descriptionMaxLength ? { descriptionMaxLength } : {}),
    };
  }

  if (dashDash === -1 || dashDash === args.length - 1) {
    throw new Error("Usage: callmux [options] -- command [args...] OR callmux --url <url>");
  }

  const command = args[dashDash + 1];
  const commandArgs = args.slice(dashDash + 2);

  return {
    servers: {
      default: {
        command,
        args: commandArgs,
        tools,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cachePolicy ? { cachePolicy } : {}),
      },
    },
    cacheTtlSeconds: cacheTtl,
    maxConcurrency,
    ...(maxCacheEntries !== undefined ? { maxCacheEntries } : {}),
    ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    ...(strictStartup ? { strictStartup } : {}),
    ...(metaOnly ? { metaOnly } : {}),
    ...(descriptionMaxLength ? { descriptionMaxLength } : {}),
  };
}
