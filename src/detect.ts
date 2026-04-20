import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import type { ServerConfig } from "./types.js";

export interface DetectedServer {
  name: string;
  config: ServerConfig;
  source: string;
}

export interface DetectionResult {
  servers: DetectedServer[];
  scanned: string[];
  errors: Array<{ path: string; error: string }>;
}

interface McpJsonDocument {
  mcpServers?: Record<string, ServerConfig>;
}

function getClaudeDesktopConfigPath(): string {
  const p = platform();
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (p === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function getConfigLocations(): Array<{ path: string; label: string }> {
  return [
    { path: join(process.cwd(), ".mcp.json"), label: "project .mcp.json" },
    { path: join(homedir(), ".claude.json"), label: "Claude Code" },
    { path: getClaudeDesktopConfigPath(), label: "Claude Desktop" },
  ];
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractServers(doc: Record<string, unknown>): Record<string, ServerConfig> | null {
  const mcpServers = doc.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return null;
  }

  const result: Record<string, ServerConfig> = {};
  for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;

    if (typeof e.command === "string" && e.command.length > 0) {
      result[name] = {
        command: e.command,
        ...(Array.isArray(e.args) ? { args: e.args as string[] } : {}),
        ...(e.env && typeof e.env === "object" ? { env: e.env as Record<string, string> } : {}),
        ...(typeof e.cwd === "string" ? { cwd: e.cwd } : {}),
      };
    } else if (typeof e.url === "string" && e.url.length > 0) {
      result[name] = {
        url: e.url,
        ...(typeof e.transport === "string" ? { transport: e.transport as "streamable-http" | "sse" } : {}),
        ...(e.headers && typeof e.headers === "object" ? { headers: e.headers as Record<string, string> } : {}),
      };
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

export async function detectExistingConfigs(): Promise<DetectionResult> {
  const locations = getConfigLocations();
  const servers: DetectedServer[] = [];
  const scanned: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const { path, label } of locations) {
    scanned.push(path);
    const doc = await readJsonSafe(path);
    if (!doc) continue;

    const extracted = extractServers(doc);
    if (!extracted) continue;

    for (const [name, config] of Object.entries(extracted)) {
      servers.push({ name, config, source: label });
    }
  }

  return { servers, scanned, errors };
}
