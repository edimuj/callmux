import { buildClaudeEntry, buildCodexSnippet, type ClientKind } from "./client-config.js";
import { getDefaultConfigPath } from "./config.js";
import { formatCommandForDisplay, redactUrl } from "./redact.js";
import { isHttpServerConfig, isStdioServerConfig } from "./types.js";
import type { CachePolicyConfig, CallmuxConfig, ServerConfig, StdioServerConfig } from "./types.js";

interface ServerMutation {
  command?: string;
  args?: string[];
  replaceTools?: string[];
  addTools?: string[];
  removeTools?: string[];
  clearTools?: boolean;
  cwd?: string;
  clearCwd?: boolean;
  setEnv?: Record<string, string>;
  removeEnv?: string[];
  clearEnv?: boolean;
  cacheAllowTools?: string[];
  cacheDenyTools?: string[];
  clearCachePolicy?: boolean;
}

function parseCommaList(value: string): string[] | undefined {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function buildCachePolicy(
  allowTools?: string[],
  denyTools?: string[]
): CachePolicyConfig | undefined {
  if (!allowTools && !denyTools) return undefined;
  return {
    ...(allowTools ? { allowTools } : {}),
    ...(denyTools ? { denyTools } : {}),
  };
}

function formatCommand(server: ServerConfig): string {
  if (isHttpServerConfig(server)) {
    return redactUrl(server.url);
  }
  return formatCommandForDisplay(server.command, server.args);
}

function formatValueList(values: string[] | undefined): string | undefined {
  return values && values.length > 0 ? values.join(", ") : undefined;
}

export function parseCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error("Unterminated quoted argument");
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

export function createEmptyConfig(): CallmuxConfig {
  return {
    servers: {},
    cacheTtlSeconds: 0,
    maxConcurrency: 20,
  };
}

function parseEnvPair(pair: string): { key: string; value: string } {
  const equals = pair.indexOf("=");
  if (equals <= 0) {
    throw new Error(`Invalid --env value "${pair}". Expected KEY=VALUE.`);
  }

  return {
    key: pair.slice(0, equals),
    value: pair.slice(equals + 1),
  };
}

export function parseServerDefinitionArgs(args: string[]): ServerConfig {
  const dashDash = args.indexOf("--");
  if (dashDash === -1 || dashDash === args.length - 1) {
    throw new Error("Usage: callmux server add <name> [options] -- <command> [args...]");
  }

  const command = args[dashDash + 1];
  const commandArgs = args.slice(dashDash + 2);

  let tools: string[] | undefined;
  let cwd: string | undefined;
  let cacheAllowTools: string[] | undefined;
  let cacheDenyTools: string[] | undefined;
  const env: Record<string, string> = {};

  for (let i = 0; i < dashDash; i++) {
    const arg = args[i];
    if (arg === "--tools" && i + 1 < dashDash) {
      tools = parseCommaList(args[++i]);
    } else if (arg === "--cwd" && i + 1 < dashDash) {
      cwd = args[++i];
    } else if (arg === "--env" && i + 1 < dashDash) {
      const pair = parseEnvPair(args[++i]);
      env[pair.key] = pair.value;
    } else if (arg === "--cache-allow" && i + 1 < dashDash) {
      cacheAllowTools = parseCommaList(args[++i]);
    } else if (arg === "--cache-deny" && i + 1 < dashDash) {
      cacheDenyTools = parseCommaList(args[++i]);
    } else {
      throw new Error(`Unknown server add option "${arg}"`);
    }
  }

  return {
    command,
    args: commandArgs.length > 0 ? commandArgs : undefined,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tools ? { tools } : {}),
    ...(buildCachePolicy(cacheAllowTools, cacheDenyTools)
      ? { cachePolicy: buildCachePolicy(cacheAllowTools, cacheDenyTools) }
      : {}),
  };
}

export function parseServerMutationArgs(args: string[]): ServerMutation {
  const dashDash = args.indexOf("--");
  const optionsLimit = dashDash === -1 ? args.length : dashDash;
  const mutation: ServerMutation = {};

  for (let i = 0; i < optionsLimit; i++) {
    const arg = args[i];

    if (arg === "--tools" && i + 1 < optionsLimit) {
      mutation.replaceTools = parseCommaList(args[++i]) ?? [];
    } else if (arg === "--add-tool" && i + 1 < optionsLimit) {
      mutation.addTools = [...(mutation.addTools ?? []), args[++i]];
    } else if (arg === "--remove-tool" && i + 1 < optionsLimit) {
      mutation.removeTools = [...(mutation.removeTools ?? []), args[++i]];
    } else if (arg === "--clear-tools") {
      mutation.clearTools = true;
    } else if (arg === "--cwd" && i + 1 < optionsLimit) {
      mutation.cwd = args[++i];
    } else if (arg === "--clear-cwd") {
      mutation.clearCwd = true;
    } else if (arg === "--env" && i + 1 < optionsLimit) {
      const pair = parseEnvPair(args[++i]);
      mutation.setEnv = {
        ...(mutation.setEnv ?? {}),
        [pair.key]: pair.value,
      };
    } else if (arg === "--remove-env" && i + 1 < optionsLimit) {
      mutation.removeEnv = [...(mutation.removeEnv ?? []), args[++i]];
    } else if (arg === "--clear-env") {
      mutation.clearEnv = true;
    } else if (arg === "--cache-allow" && i + 1 < optionsLimit) {
      mutation.cacheAllowTools = parseCommaList(args[++i]) ?? [];
    } else if (arg === "--cache-deny" && i + 1 < optionsLimit) {
      mutation.cacheDenyTools = parseCommaList(args[++i]) ?? [];
    } else if (arg === "--clear-cache-policy") {
      mutation.clearCachePolicy = true;
    } else {
      throw new Error(`Unknown server set option "${arg}"`);
    }
  }

  if (dashDash !== -1) {
    if (dashDash === args.length - 1) {
      throw new Error("Usage: callmux server set <name> [options] [-- <command> [args...]]");
    }
    mutation.command = args[dashDash + 1];
    mutation.args = args.slice(dashDash + 2);
  }

  if (
    !mutation.command &&
    !mutation.replaceTools &&
    !mutation.addTools &&
    !mutation.removeTools &&
    !mutation.clearTools &&
    mutation.cwd === undefined &&
    !mutation.clearCwd &&
    !mutation.setEnv &&
    !mutation.removeEnv &&
    !mutation.clearEnv &&
    mutation.cacheAllowTools === undefined &&
    mutation.cacheDenyTools === undefined &&
    !mutation.clearCachePolicy
  ) {
    throw new Error("No server changes requested");
  }

  return mutation;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function applyServerMutation(
  server: ServerConfig,
  mutation: ServerMutation
): ServerConfig {
  let tools =
    mutation.replaceTools !== undefined
      ? [...mutation.replaceTools]
      : server.tools
        ? [...server.tools]
        : undefined;

  if (mutation.clearTools) {
    tools = undefined;
  } else {
    if (mutation.addTools?.length) {
      tools = dedupe([...(tools ?? []), ...mutation.addTools]);
    }
    if (mutation.removeTools?.length && tools) {
      const removals = new Set(mutation.removeTools);
      tools = tools.filter((tool) => !removals.has(tool));
      if (tools.length === 0) tools = undefined;
    }
  }

  let cachePolicy = mutation.clearCachePolicy
    ? undefined
    : server.cachePolicy
      ? { ...server.cachePolicy }
      : undefined;
  if (mutation.cacheAllowTools !== undefined) {
    cachePolicy = {
      ...(cachePolicy ?? {}),
      ...(mutation.cacheAllowTools.length > 0
        ? { allowTools: mutation.cacheAllowTools }
        : {}),
    };
    if (mutation.cacheAllowTools.length === 0 && cachePolicy) {
      delete cachePolicy.allowTools;
    }
  }
  if (mutation.cacheDenyTools !== undefined) {
    cachePolicy = {
      ...(cachePolicy ?? {}),
      ...(mutation.cacheDenyTools.length > 0
        ? { denyTools: mutation.cacheDenyTools }
        : {}),
    };
    if (mutation.cacheDenyTools.length === 0 && cachePolicy) {
      delete cachePolicy.denyTools;
    }
  }
  if (
    cachePolicy &&
    !cachePolicy.allowTools &&
    !cachePolicy.denyTools
  ) {
    cachePolicy = undefined;
  }

  if (isHttpServerConfig(server)) {
    return {
      url: server.url,
      ...(server.transport ? { transport: server.transport } : {}),
      ...(server.headers ? { headers: server.headers } : {}),
      ...(tools ? { tools } : {}),
      ...(cachePolicy ? { cachePolicy } : {}),
    };
  }

  let env = mutation.clearEnv
    ? undefined
    : server.env
      ? { ...server.env }
      : undefined;
  if (mutation.setEnv) {
    env = { ...(env ?? {}), ...mutation.setEnv };
  }
  if (mutation.removeEnv?.length && env) {
    for (const key of mutation.removeEnv) {
      delete env[key];
    }
    if (Object.keys(env).length === 0) env = undefined;
  }

  return {
    command: mutation.command ?? server.command,
    ...(mutation.command
      ? mutation.args && mutation.args.length > 0
        ? { args: mutation.args }
        : {}
      : server.args
        ? { args: server.args }
        : {}),
    ...(env ? { env } : {}),
    ...((mutation.clearCwd ? undefined : mutation.cwd) ?? (!mutation.clearCwd ? server.cwd : undefined)
      ? { cwd: (mutation.clearCwd ? undefined : mutation.cwd) ?? server.cwd }
      : {}),
    ...(tools ? { tools } : {}),
    ...(cachePolicy ? { cachePolicy } : {}),
  };
}

export function serializeServers(config: CallmuxConfig): Array<{
  name: string;
  command?: string;
  url?: string;
  transport?: string;
  args?: string[];
  cwd?: string;
  tools?: string[];
  envKeys?: string[];
  cachePolicy?: CachePolicyConfig;
}> {
  return Object.entries(config.servers).map(([name, server]) => {
    if (isHttpServerConfig(server)) {
      return {
        name,
        url: server.url,
        ...(server.transport ? { transport: server.transport } : {}),
        ...(server.tools ? { tools: server.tools } : {}),
        ...(server.cachePolicy ? { cachePolicy: server.cachePolicy } : {}),
      };
    }
    return {
      name,
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.tools ? { tools: server.tools } : {}),
      ...(server.env ? { envKeys: Object.keys(server.env).sort() } : {}),
      ...(server.cachePolicy ? { cachePolicy: server.cachePolicy } : {}),
    };
  });
}

export function formatServerList(config: CallmuxConfig): string {
  const entries = Object.entries(config.servers);
  if (entries.length === 0) {
    return "No downstream servers configured.";
  }

  return entries
    .map(([name, server]) => {
      const lines: string[] = [name];

      if (isHttpServerConfig(server)) {
        lines.push(`  url: ${redactUrl(server.url)}`);
        if (server.transport) lines.push(`  transport: ${server.transport}`);
      } else {
        lines.push(`  command: ${formatCommand(server)}`);
        if (server.cwd) lines.push(`  cwd: ${server.cwd}`);
        const envKeys = formatValueList(server.env ? Object.keys(server.env).sort() : undefined);
        if (envKeys) lines.push(`  env keys: ${envKeys}`);
      }

      const tools = formatValueList(server.tools);
      const cacheAllow = formatValueList(server.cachePolicy?.allowTools);
      const cacheDeny = formatValueList(server.cachePolicy?.denyTools);

      if (tools) lines.push(`  tools: ${tools}`);
      if (cacheAllow) lines.push(`  cache allow: ${cacheAllow}`);
      if (cacheDeny) lines.push(`  cache deny: ${cacheDeny}`);

      return lines.join("\n");
    })
    .join("\n\n");
}

export function renderClientSnippet(
  client: ClientKind,
  options?: { configPath?: string; serverName?: string }
): string {
  const serverName = options?.serverName ?? "callmux";

  if (client === "claude") {
    return JSON.stringify(
      {
        mcpServers: {
          [serverName]: buildClaudeEntry(options),
        },
      },
      null,
      2
    );
  }

  return buildCodexSnippet({
    configPath: options?.configPath,
    serverName,
  });
}
