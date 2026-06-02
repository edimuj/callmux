import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  BearerAuthConfig,
  CallmuxConfig,
  ManagementConfig,
  ServerConfig,
} from "./types.js";
import { isHttpServerConfig } from "./types.js";

const DEFAULT_MANAGEMENT_PATH = "/management/v1";

export interface ManagementOverlay {
  version: 1;
  servers?: Record<string, { config?: ServerConfig; deleted?: boolean }>;
  updatedAt?: string;
}

export interface NormalizedManagementConfig {
  enabled: boolean;
  path: string;
  statePath?: string;
  auth?: BearerAuthConfig;
  allowUnauthenticatedRead: boolean;
  allowAuthenticatedRead: boolean;
}

function normalizePath(path: string | undefined): string {
  if (!path || path.trim().length === 0) return DEFAULT_MANAGEMENT_PATH;
  const trimmed = path.trim();
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (absolute === "/") return absolute;
  return absolute.replace(/\/+$/, "");
}

export function defaultManagementStatePath(configPath: string | undefined): string | undefined {
  return configPath ? `${resolve(configPath)}.management.json` : undefined;
}

export function normalizeManagementConfig(
  config: ManagementConfig | undefined,
  configPath?: string
): NormalizedManagementConfig {
  const statePath = config?.statePath
    ? resolve(configPath ? dirname(resolve(configPath)) : process.cwd(), config.statePath)
    : defaultManagementStatePath(configPath);

  return {
    enabled: config?.enabled ?? false,
    path: normalizePath(config?.path),
    ...(statePath ? { statePath } : {}),
    ...(config?.auth ? { auth: config.auth } : {}),
    allowUnauthenticatedRead: config?.allowUnauthenticatedRead ?? false,
    allowAuthenticatedRead: config?.allowAuthenticatedRead ?? false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
}

export function assertServerConfig(value: unknown, field = "config"): asserts value is ServerConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const hasUrl = typeof value.url === "string" && value.url.length > 0;
  const hasCommand = typeof value.command === "string" && value.command.length > 0;
  if (hasUrl === hasCommand) {
    throw new Error(`${field} must have exactly one of "command" or "url"`);
  }
  assertStringArray(value.tools, `${field}.tools`);
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
    throw new Error(`${field}.disabled must be a boolean`);
  }
  if (hasUrl) {
    if (
      value.transport !== undefined &&
      value.transport !== "streamable-http" &&
      value.transport !== "sse"
    ) {
      throw new Error(`${field}.transport must be "streamable-http" or "sse"`);
    }
    if (value.headers !== undefined && !isRecord(value.headers)) {
      throw new Error(`${field}.headers must be an object`);
    }
    return;
  }
  assertStringArray(value.args, `${field}.args`);
  if (value.env !== undefined && !isRecord(value.env)) {
    throw new Error(`${field}.env must be an object`);
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error(`${field}.cwd must be a string`);
  }
  if (
    value.cwdMode !== undefined &&
    value.cwdMode !== "global" &&
    value.cwdMode !== "session"
  ) {
    throw new Error(`${field}.cwdMode must be "global" or "session"`);
  }
}

export async function loadManagementOverlay(
  statePath: string | undefined
): Promise<ManagementOverlay> {
  if (!statePath) return { version: 1 };
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf-8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      throw new Error("management overlay must have version 1");
    }
    const overlay: ManagementOverlay = { version: 1 };
    if (isRecord(parsed.servers)) {
      overlay.servers = {};
      for (const [name, entry] of Object.entries(parsed.servers)) {
        if (!isRecord(entry)) {
          throw new Error(`management overlay server "${name}" must be an object`);
        }
        if (entry.deleted !== undefined && typeof entry.deleted !== "boolean") {
          throw new Error(`management overlay server "${name}".deleted must be a boolean`);
        }
        if (entry.config !== undefined) {
          assertServerConfig(entry.config, `management overlay server "${name}".config`);
        }
        overlay.servers[name] = {
          ...(entry.config !== undefined ? { config: entry.config } : {}),
          ...(entry.deleted !== undefined ? { deleted: entry.deleted } : {}),
        };
      }
    }
    if (typeof parsed.updatedAt === "string") overlay.updatedAt = parsed.updatedAt;
    return overlay;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw error;
  }
}

export async function saveManagementOverlay(
  statePath: string | undefined,
  overlay: ManagementOverlay
): Promise<void> {
  if (!statePath) {
    throw new Error("management statePath is required for persistent mutations");
  }
  await mkdir(dirname(statePath), { recursive: true });
  const next = { ...overlay, version: 1 as const, updatedAt: new Date().toISOString() };
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

export function applyManagementOverlay(
  baseConfig: CallmuxConfig,
  overlay: ManagementOverlay
): CallmuxConfig {
  const servers: Record<string, ServerConfig> = { ...baseConfig.servers };
  for (const [name, entry] of Object.entries(overlay.servers ?? {})) {
    if (entry.deleted) {
      delete servers[name];
    } else if (entry.config) {
      servers[name] = entry.config;
    }
  }
  return {
    ...baseConfig,
    servers,
  };
}

export function setOverlayServer(
  overlay: ManagementOverlay,
  name: string,
  config: ServerConfig
): ManagementOverlay {
  return {
    ...overlay,
    servers: {
      ...(overlay.servers ?? {}),
      [name]: { config },
    },
  };
}

export function deleteOverlayServer(
  overlay: ManagementOverlay,
  name: string
): ManagementOverlay {
  return {
    ...overlay,
    servers: {
      ...(overlay.servers ?? {}),
      [name]: { deleted: true },
    },
  };
}

export function redactConfig(config: CallmuxConfig): CallmuxConfig {
  const servers = Object.fromEntries(
    Object.entries(config.servers).map(([name, server]) => {
      if (isHttpServerConfig(server)) {
        return [
          name,
          {
            ...server,
            ...(server.headers ? { headers: redactRecord(server.headers) } : {}),
          },
        ];
      }
      return [
        name,
        {
          ...server,
          ...(server.env ? { env: redactRecord(server.env) } : {}),
        },
      ];
    })
  );

  return {
    ...config,
    servers,
    ...(config.auth ? { auth: redactAuth(config.auth) } : {}),
    ...(config.management ? { management: redactManagement(config.management) } : {}),
  };
}

function redactManagement(config: ManagementConfig): ManagementConfig {
  return {
    ...config,
    ...(config.auth ? { auth: redactBearerAuth(config.auth) } : {}),
  };
}

function redactAuth(config: BearerAuthConfig | CallmuxConfig["auth"]): CallmuxConfig["auth"] {
  if (!config || config.mode !== "bearer") return config;
  return redactBearerAuth(config);
}

function redactBearerAuth(config: BearerAuthConfig): BearerAuthConfig {
  return {
    ...config,
    tokens: config.tokens.map((token) => ({
      id: token.id,
      ...("hash" in token || "hashRef" in token
        ? { hash: "[redacted]" }
        : { token: "[redacted]" }),
    })),
  };
}

function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, "[redacted]"])
  );
}
