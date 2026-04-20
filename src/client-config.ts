import { homedir } from "node:os";
import { join } from "node:path";
import { getDefaultConfigPath } from "./config.js";

export type ClientKind = "claude" | "codex";

interface ClientConfigOptions {
  configPath?: string;
  serverName?: string;
}

interface ClientConfigMutationOptions extends ClientConfigOptions {
  source: string;
}

interface ClientConfigMutationResult {
  changed: boolean;
  content: string;
  path: string;
  serverName: string;
}

function getCallmuxArgs(configPath?: string): string[] {
  const defaultPath = getDefaultConfigPath();
  return configPath && configPath !== defaultPath ? ["--config", configPath] : [];
}

export function getDefaultClientConfigPath(client: ClientKind): string {
  return client === "claude"
    ? join(homedir(), ".claude.json")
    : join(homedir(), ".codex", "config.toml");
}

export function buildClaudeEntry(options?: ClientConfigOptions): {
  command: string;
  args: string[];
} {
  return {
    command: "callmux",
    args: getCallmuxArgs(options?.configPath),
  };
}

export function buildCodexSnippet(options?: ClientConfigOptions): string {
  const serverName = options?.serverName ?? "callmux";

  return [
    `[mcp_servers.${serverName}]`,
    `command = "callmux"`,
    `args = ${JSON.stringify(getCallmuxArgs(options?.configPath))}`,
  ].join("\n");
}

function ensureObjectRecord(
  value: unknown,
  errorMessage: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value as Record<string, unknown>;
}

function normalizeJsonOutput(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function attachClaudeConfig(
  options: ClientConfigMutationOptions
): ClientConfigMutationResult {
  const serverName = options.serverName ?? "callmux";
  const path = getDefaultClientConfigPath("claude");
  const document = options.source.trim()
    ? ensureObjectRecord(
        JSON.parse(options.source) as unknown,
        "Claude config must be a JSON object"
      )
    : {};
  const mcpServers = document.mcpServers === undefined
    ? {}
    : ensureObjectRecord(document.mcpServers, "\"mcpServers\" must be an object");
  const entry = buildClaudeEntry(options);
  const current = mcpServers[serverName];

  if (
    current &&
    JSON.stringify(current) === JSON.stringify(entry)
  ) {
    return {
      changed: false,
      content: normalizeJsonOutput(document),
      path,
      serverName,
    };
  }

  document.mcpServers = {
    ...mcpServers,
    [serverName]: entry,
  };

  return {
    changed: true,
    content: normalizeJsonOutput(document),
    path,
    serverName,
  };
}

export function detachClaudeConfig(
  options: ClientConfigMutationOptions
): ClientConfigMutationResult {
  const serverName = options.serverName ?? "callmux";
  const path = getDefaultClientConfigPath("claude");

  if (!options.source.trim()) {
    return {
      changed: false,
      content: "",
      path,
      serverName,
    };
  }

  const document = ensureObjectRecord(
    JSON.parse(options.source) as unknown,
    "Claude config must be a JSON object"
  );
  const mcpServers = document.mcpServers === undefined
    ? undefined
    : ensureObjectRecord(document.mcpServers, "\"mcpServers\" must be an object");

  if (!mcpServers || !(serverName in mcpServers)) {
    return {
      changed: false,
      content: normalizeJsonOutput(document),
      path,
      serverName,
    };
  }

  delete mcpServers[serverName];
  if (Object.keys(mcpServers).length === 0) {
    delete document.mcpServers;
  } else {
    document.mcpServers = mcpServers;
  }

  return {
    changed: true,
    content: normalizeJsonOutput(document),
    path,
    serverName,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createCodexManagedBlock(serverName: string, configPath?: string): string {
  return [
    `# BEGIN CALLMUX MANAGED ${serverName}`,
    buildCodexSnippet({ configPath, serverName }),
    `# END CALLMUX MANAGED ${serverName}`,
  ].join("\n");
}

function findCodexManagedBlock(source: string, serverName: string): RegExp {
  const escaped = escapeRegExp(serverName);
  return new RegExp(
    `(^|\\n)# BEGIN CALLMUX MANAGED ${escaped}\\n[\\s\\S]*?\\n# END CALLMUX MANAGED ${escaped}(?=\\n|$)`,
    "m"
  );
}

function hasUnmanagedCodexEntry(source: string, serverName: string): boolean {
  return new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]$`, "m").test(source);
}

function normalizeTomlOutput(value: string): string {
  return value.length > 0 ? `${value.replace(/\s+$/, "")}\n` : "";
}

export function attachCodexConfig(
  options: ClientConfigMutationOptions
): ClientConfigMutationResult {
  const serverName = options.serverName ?? "callmux";
  const path = getDefaultClientConfigPath("codex");
  const managedBlock = createCodexManagedBlock(serverName, options.configPath);
  const managedBlockPattern = findCodexManagedBlock(options.source, serverName);

  if (managedBlockPattern.test(options.source)) {
    const content = normalizeTomlOutput(
      options.source.replace(managedBlockPattern, (_match, prefix: string) =>
        `${prefix}${managedBlock}`
      )
    );
    return {
      changed: content !== normalizeTomlOutput(options.source),
      content,
      path,
      serverName,
    };
  }

  if (hasUnmanagedCodexEntry(options.source, serverName)) {
    throw new Error(
      `Codex config already has an unmanaged [mcp_servers.${serverName}] entry`
    );
  }

  const trimmed = options.source.replace(/\s+$/, "");
  const content = normalizeTomlOutput(
    trimmed.length > 0 ? `${trimmed}\n\n${managedBlock}` : managedBlock
  );

  return {
    changed: true,
    content,
    path,
    serverName,
  };
}

export function detachCodexConfig(
  options: ClientConfigMutationOptions
): ClientConfigMutationResult {
  const serverName = options.serverName ?? "callmux";
  const path = getDefaultClientConfigPath("codex");
  const managedBlockPattern = findCodexManagedBlock(options.source, serverName);

  if (!managedBlockPattern.test(options.source)) {
    if (hasUnmanagedCodexEntry(options.source, serverName)) {
      throw new Error(
        `Codex config has an unmanaged [mcp_servers.${serverName}] entry; refusing to remove it`
      );
    }

    return {
      changed: false,
      content: normalizeTomlOutput(options.source),
      path,
      serverName,
    };
  }

  const content = normalizeTomlOutput(
    options.source.replace(managedBlockPattern, (_match, prefix: string) => prefix)
  );

  return {
    changed: true,
    content,
    path,
    serverName,
  };
}
