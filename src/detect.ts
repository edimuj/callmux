import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import type { ServerConfig } from "./types.js";

export interface DetectedServer {
  name: string;
  config: ServerConfig;
  source: string;
}

interface DetectionResult {
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

async function readJsonDocument(
  path: string
): Promise<{ doc: Record<string, unknown> | null; error?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    // Absent file is the normal case, not an error worth surfacing.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { doc: null };
    return { doc: null, error: (err as Error).message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { doc: parsed as Record<string, unknown> };
    }
    return { doc: null, error: "expected a JSON object at the top level" };
  } catch (err) {
    return { doc: null, error: `invalid JSON: ${(err as Error).message}` };
  }
}

function extractServers(
  doc: Record<string, unknown>,
  path: string,
  errors: Array<{ path: string; error: string }>
): Record<string, ServerConfig> {
  const result: Record<string, ServerConfig> = {};
  const mcpServers = doc.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return result;
  }

  for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;

    if (typeof e.command === "string" && e.command.length > 0) {
      if (
        e.args !== undefined &&
        (!Array.isArray(e.args) || !e.args.every((a) => typeof a === "string"))
      ) {
        errors.push({ path, error: `server "${name}": args must be an array of strings` });
        continue;
      }
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
    } else {
      errors.push({ path, error: `server "${name}": missing "command" or "url"` });
    }
  }

  return result;
}

export async function detectExistingConfigs(): Promise<DetectionResult> {
  const locations = getConfigLocations();
  const servers: DetectedServer[] = [];
  const scanned: string[] = locations.map((l) => l.path);
  const errors: Array<{ path: string; error: string }> = [];

  const reads = await Promise.all(
    locations.map(async ({ path, label }) => ({
      path,
      label,
      ...(await readJsonDocument(path)),
    }))
  );

  for (const { path, label, doc, error } of reads) {
    if (error) {
      errors.push({ path, error });
      continue;
    }
    if (!doc) continue;
    for (const [name, config] of Object.entries(extractServers(doc, path, errors))) {
      servers.push({ name, config, source: label });
    }
  }

  return { servers, scanned, errors };
}
