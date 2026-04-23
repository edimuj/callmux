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

interface ClientConfigStatus {
  client: ClientKind;
  path: string;
  serverName: string;
  exists: boolean;
  status:
    | "configured"
    | "configured_managed"
    | "managed_mismatch"
    | "different_entry"
    | "unmanaged_entry"
    | "absent"
    | "invalid";
  configured: boolean;
  details?: string;
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

function getClientServerName(serverName?: string): string {
  const name = serverName ?? "callmux";
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      "client server name must contain only letters, numbers, underscores, and hyphens"
    );
  }
  return name;
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
  getClientServerName(options?.serverName);
  return {
    command: "callmux",
    args: getCallmuxArgs(options?.configPath),
  };
}

export function buildCodexSnippet(options?: ClientConfigOptions): string {
  const serverName = getClientServerName(options?.serverName);

  return [
    `[mcp_servers.${serverName}]`,
    `command = "callmux"`,
    `args = ${JSON.stringify(getCallmuxArgs(options?.configPath))}`,
  ].join("\n");
}

export function renderClientAttachPreview(
  client: ClientKind,
  options?: ClientConfigOptions
): string {
  const serverName = getClientServerName(options?.serverName);
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

  return createCodexManagedBlock(
    serverName,
    options?.configPath
  );
}

export function getClaudeConfigStatus(
  options: ClientConfigMutationOptions
): ClientConfigStatus {
  const serverName = getClientServerName(options.serverName);
  const path = getDefaultClientConfigPath("claude");
  const exists = options.source.trim().length > 0;

  if (!exists) {
    return {
      client: "claude",
      path,
      serverName,
      exists: false,
      status: "absent",
      configured: false,
      details: "config file does not exist or is empty",
    };
  }

  let document: Record<string, unknown>;
  let mcpServers: Record<string, unknown> | undefined;
  try {
    document = ensureObjectRecord(
      JSON.parse(options.source) as unknown,
      "Claude config must be a JSON object"
    );
    mcpServers = document.mcpServers === undefined
      ? undefined
      : ensureObjectRecord(document.mcpServers, "\"mcpServers\" must be an object");
  } catch (error) {
    return {
      client: "claude",
      path,
      serverName,
      exists: true,
      status: "invalid",
      configured: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
  const entry = mcpServers?.[serverName];

  if (!entry) {
    return {
      client: "claude",
      path,
      serverName,
      exists: true,
      status: "absent",
      configured: false,
      details: `no mcpServers.${serverName} entry`,
    };
  }

  const expected = buildClaudeEntry(options);
  const matches = JSON.stringify(entry) === JSON.stringify(expected);

  return {
    client: "claude",
    path,
    serverName,
    exists: true,
    status: matches ? "configured" : "different_entry",
    configured: matches,
    details: matches
      ? `command "callmux" with ${expected.args.length} args`
      : `mcpServers.${serverName} exists but does not match the expected callmux entry`,
  };
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
  const serverName = getClientServerName(options.serverName);
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
  const serverName = getClientServerName(options.serverName);
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

function extractManagedCodexBlock(source: string, serverName: string): string | undefined {
  const pattern = findCodexManagedBlock(source, serverName);
  const match = source.match(pattern)?.[0];
  return match?.replace(/^\n/, "");
}

export function getCodexConfigStatus(
  options: ClientConfigMutationOptions
): ClientConfigStatus {
  const serverName = getClientServerName(options.serverName);
  const path = getDefaultClientConfigPath("codex");
  const exists = options.source.trim().length > 0;

  if (!exists) {
    return {
      client: "codex",
      path,
      serverName,
      exists: false,
      status: "absent",
      configured: false,
      details: "config file does not exist or is empty",
    };
  }

  const managedBlock = extractManagedCodexBlock(options.source, serverName);
  const expectedManagedBlock = createCodexManagedBlock(serverName, options.configPath);

  if (managedBlock) {
    const configured = managedBlock === expectedManagedBlock;
    return {
      client: "codex",
      path,
      serverName,
      exists: true,
      status: configured ? "configured_managed" : "managed_mismatch",
      configured,
      details: configured
        ? "CALLMUX-managed entry matches expected config"
        : "CALLMUX-managed entry exists but does not match the expected config",
    };
  }

  if (hasUnmanagedCodexEntry(options.source, serverName)) {
    return {
      client: "codex",
      path,
      serverName,
      exists: true,
      status: "unmanaged_entry",
      configured: false,
      details: `unmanaged [mcp_servers.${serverName}] entry exists`,
    };
  }

  return {
    client: "codex",
    path,
    serverName,
    exists: true,
    status: "absent",
    configured: false,
    details: `no mcp_servers.${serverName} entry`,
  };
}

export function formatClientStatus(status: ClientConfigStatus): string {
  const lines = [
    `${status.client}: ${status.status}`,
    `  path: ${status.path}`,
    `  server: ${status.serverName}`,
    `  configured: ${status.configured ? "yes" : "no"}`,
  ];

  if (status.details) {
    lines.push(`  details: ${status.details}`);
  }

  return lines.join("\n");
}

export function attachCodexConfig(
  options: ClientConfigMutationOptions
): ClientConfigMutationResult {
  const serverName = getClientServerName(options.serverName);
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
  const serverName = getClientServerName(options.serverName);
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
