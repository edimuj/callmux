import * as p from "@clack/prompts";
import { UpstreamManager } from "./upstream.js";
import { loadManagedConfig, saveManagedConfig, getDefaultConfigPath } from "./config.js";
import {
  attachClaudeConfig,
  attachCodexConfig,
  getDefaultClientConfigPath,
  type ClientKind,
} from "./client-config.js";
import { detectExistingConfigs, type DetectedServer } from "./detect.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SERVER_REGISTRY, type RegistryEntry } from "./registry.js";
import { isHttpServerConfig } from "./types.js";
import { META_TOOLS } from "./meta-tools.js";
import type { CallmuxConfig, ServerConfig } from "./types.js";

interface DiscoveredServer {
  name: string;
  config: ServerConfig;
  tools: string[];
  selectedTools?: string[];
}

export async function runSetup(configPath?: string): Promise<void> {
  const resolvedConfigPath = configPath ?? getDefaultConfigPath();

  p.intro("callmux setup");

  const existing = await loadManagedConfig(resolvedConfigPath);
  if (existing && Object.keys(existing.servers).length > 0) {
    const action = await p.select({
      message: `Found existing config at ${resolvedConfigPath} with ${Object.keys(existing.servers).length} server(s). What would you like to do?`,
      options: [
        { value: "extend", label: "Add more servers to existing config" },
        { value: "replace", label: "Start fresh (overwrites current config)" },
        { value: "cancel", label: "Cancel" },
      ],
    });

    if (p.isCancel(action) || action === "cancel") {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (action === "replace") {
      // Will be overwritten at the end
    }
  }

  const imported = await detectAndImport();
  const servers = await selectServers();

  if (imported.length === 0 && servers.length === 0) {
    p.cancel("No servers selected.");
    process.exit(0);
  }

  const discovered = await discoverTools(servers, imported);

  const cacheChoice = await p.confirm({
    message: "Enable caching for read-only tools? (recommended)",
    initialValue: true,
  });

  if (p.isCancel(cacheChoice)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const cacheTtl = cacheChoice ? 60 : 0;

  const totalToolCount = discovered.reduce(
    (sum, s) => sum + (s.selectedTools?.length ?? s.tools.length),
    0
  );

  const metaOnlyChoice = await p.confirm({
    message: `Enable meta-only mode? Hides individual tools from your agent's listing and exposes them only through callmux meta-tools. Reduces tool listing from ${totalToolCount} tools to ${META_TOOLS.length}.`,
    initialValue: false,
  });

  if (p.isCancel(metaOnlyChoice)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let descriptionMaxLength: number | undefined;
  if (metaOnlyChoice) {
    const descMaxInput = await p.text({
      message: "Max description length for tool discovery (leave blank for no limit):",
      placeholder: "100",
      validate: (v = "") => {
        if (v && (!/^\d+$/.test(v) || Number(v) < 1))
          return "Must be a positive integer";
      },
    });

    if (p.isCancel(descMaxInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    descriptionMaxLength = descMaxInput ? Number(descMaxInput) : undefined;
  }

  const config = buildConfig(
    discovered,
    cacheTtl,
    metaOnlyChoice,
    descriptionMaxLength,
    existing
  );

  await saveManagedConfig(resolvedConfigPath, config);
  p.log.success(`Config written to ${resolvedConfigPath}`);

  await attachToClients(resolvedConfigPath);

  p.outro("Setup complete! Your agent now has access to callmux meta-tools.");
}

async function detectAndImport(): Promise<DiscoveredServer[]> {
  const detection = await detectExistingConfigs();

  if (detection.servers.length === 0) return [];

  const grouped = new Map<string, DetectedServer[]>();
  for (const server of detection.servers) {
    const list = grouped.get(server.source) ?? [];
    list.push(server);
    grouped.set(server.source, list);
  }

  p.log.info(
    `Found ${detection.servers.length} existing MCP server(s) in: ${[...grouped.keys()].join(", ")}`
  );

  const options = detection.servers.map((s) => {
    const hint = isHttpServerConfig(s.config) ? s.config.url : `${(s.config as { command: string }).command}`;
    return {
      value: s.name,
      label: `${s.name} (${s.source})`,
      hint,
    };
  });

  const selected = await p.multiselect({
    message: "Import existing servers into callmux?",
    options,
    required: false,
  });

  if (p.isCancel(selected) || selected.length === 0) return [];

  const imported: DiscoveredServer[] = [];
  for (const name of selected) {
    const server = detection.servers.find((s) => s.name === name)!;
    imported.push({ name: server.name, config: server.config, tools: [] });
  }

  return imported;
}

async function selectServers(): Promise<Array<{ entry?: RegistryEntry; custom?: { name: string; command: string; url?: string } }>> {
  const registryOptions = SERVER_REGISTRY.map((entry) => ({
    value: entry.name,
    label: entry.label,
    hint: entry.description,
  }));

  const selected = await p.multiselect({
    message: "Which MCP servers do you want to connect?",
    options: [
      ...registryOptions,
      { value: "__custom__", label: "Custom server", hint: "Enter command manually" },
    ],
    required: true,
  });

  if (p.isCancel(selected)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const results: Array<{ entry?: RegistryEntry; custom?: { name: string; command: string; url?: string } }> = [];

  for (const name of selected) {
    if (name === "__custom__") {
      const customName = await p.text({
        message: "Name for your custom server (used as identifier):",
        placeholder: "my-server",
        validate: (v = "") => {
          if (!v.trim()) return "Name is required";
          if (!/^[a-z0-9-]+$/.test(v)) return "Use lowercase letters, numbers, and hyphens only";
        },
      });

      if (p.isCancel(customName)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const connectionType = await p.select({
        message: "How does this server connect?",
        options: [
          { value: "stdio", label: "Local command (stdio)", hint: "npx, node, python, etc." },
          { value: "url", label: "Remote URL (HTTP/SSE)", hint: "https://..." },
        ],
      });

      if (p.isCancel(connectionType)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      if (connectionType === "url") {
        const customUrl = await p.text({
          message: "Server URL:",
          placeholder: "https://mcp.example.com/sse",
          validate: (v = "") => {
            if (!v.trim()) return "URL is required";
            try { new URL(v); } catch { return "Must be a valid URL"; }
          },
        });

        if (p.isCancel(customUrl)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        results.push({ custom: { name: customName, command: "", url: customUrl } });
      } else {
        const customCommand = await p.text({
          message: "Command to start the server:",
          placeholder: "npx -y @modelcontextprotocol/server-something",
          validate: (v = "") => {
            if (!v.trim()) return "Command is required";
          },
        });

        if (p.isCancel(customCommand)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        results.push({ custom: { name: customName, command: customCommand } });
      }
    } else {
      results.push({ entry: SERVER_REGISTRY.find((e) => e.name === name)! });
    }
  }

  return results;
}

async function promptEnvVars(entry: RegistryEntry): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const spec of entry.envVars) {
    const value = await p.text({
      message: `${spec.description}:`,
      placeholder: spec.hint ?? "",
      validate: (v = "") => {
        if (spec.required && !v.trim()) return `${spec.name} is required`;
      },
    });

    if (p.isCancel(value)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (value.trim()) {
      env[spec.name] = value.trim();
    }
  }

  return env;
}

async function discoverTools(
  servers: Array<{ entry?: RegistryEntry; custom?: { name: string; command: string; url?: string } }>,
  preImported: DiscoveredServer[] = []
): Promise<DiscoveredServer[]> {
  const discovered: DiscoveredServer[] = [...preImported];

  for (const server of servers) {
    const name = server.entry?.name ?? server.custom!.name;
    const label = server.entry?.label ?? server.custom!.name;

    let env: Record<string, string> = {};
    if (server.entry && server.entry.envVars.length > 0) {
      env = await promptEnvVars(server.entry);
    }

    let config: ServerConfig;

    if (server.custom?.url) {
      config = { url: server.custom.url };
    } else if (server.entry) {
      config = {
        command: server.entry.command,
        args: [...server.entry.args],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    } else {
      const parts = server.custom!.command.split(/\s+/);
      config = {
        command: parts[0],
        args: parts.slice(1),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }

    const s = p.spinner();
    s.start(`Connecting to ${label}...`);

    const upstream = new UpstreamManager();
    let tools: string[] = [];

    try {
      const [connection] = await upstream.connect({ [name]: config });
      tools = connection?.tools.map((t) => t.name).sort() ?? [];
      s.stop(`${label}: found ${tools.length} tool${tools.length === 1 ? "" : "s"}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      s.stop(`${label}: connection failed`);

      const action = await p.select({
        message: `Could not connect to ${label}: ${msg}. What do you want to do?`,
        options: [
          { value: "skip", label: "Skip this server" },
          { value: "add-anyway", label: "Add without tool discovery (expose all tools)" },
        ],
      });

      if (p.isCancel(action) || action === "skip") {
        continue;
      }
    } finally {
      await upstream.close();
    }

    let selectedTools: string[] | undefined;

    if (tools.length > 0) {
      const toolChoice = await p.select({
        message: `${label} exposes ${tools.length} tools. Which do you want?`,
        options: [
          { value: "all", label: `All ${tools.length} tools`, hint: tools.slice(0, 5).join(", ") + (tools.length > 5 ? "..." : "") },
          { value: "pick", label: "Pick individually" },
        ],
      });

      if (p.isCancel(toolChoice)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      if (toolChoice === "pick") {
        const picked = await p.multiselect({
          message: `Select tools from ${label}:`,
          options: tools.map((t) => ({ value: t, label: t })),
          required: true,
        });

        if (p.isCancel(picked)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        selectedTools = picked;
      }
    }

    discovered.push({ name, config, tools, selectedTools });
  }

  return discovered;
}

function buildConfig(
  discovered: DiscoveredServer[],
  cacheTtl: number,
  metaOnly: boolean,
  descriptionMaxLength: number | undefined,
  existing?: CallmuxConfig | null
): CallmuxConfig {
  const servers: Record<string, ServerConfig> = existing?.servers ?? {};

  for (const { name, config, selectedTools } of discovered) {
    servers[name] = {
      ...config,
      ...(selectedTools ? { tools: selectedTools } : {}),
    };
  }

  return {
    servers,
    ...(cacheTtl > 0 ? { cacheTtlSeconds: cacheTtl } : {}),
    maxConcurrency: existing?.maxConcurrency ?? 20,
    ...(metaOnly ? { metaOnly } : {}),
    ...(descriptionMaxLength ? { descriptionMaxLength } : {}),
  };
}

async function attachToClients(configPath: string): Promise<void> {
  const clients = await p.multiselect({
    message: "Register callmux in which client(s)?",
    options: [
      { value: "claude", label: "Claude Code", hint: "~/.claude.json" },
      { value: "codex", label: "Codex", hint: "~/.codex/config.toml" },
      { value: "desktop", label: "Claude Desktop", hint: "claude_desktop_config.json" },
    ],
    required: false,
  });

  if (p.isCancel(clients) || clients.length === 0) {
    p.log.info("Skipped client registration. Run `callmux client attach <client>` later.");
    return;
  }

  for (const client of clients) {
    if (client === "desktop") {
      p.log.info("Claude Desktop: add callmux manually to claude_desktop_config.json (see README).");
      continue;
    }

    const kind = client as ClientKind;
    const filePath = getDefaultClientConfigPath(kind);

    try {
      let source = "";
      try {
        source = await readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist yet — will be created
      }

      const mutate = kind === "claude" ? attachClaudeConfig : attachCodexConfig;
      const result = mutate({ source, configPath, serverName: "callmux" });

      if (result.changed) {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, result.content, "utf-8");
        p.log.success(`Attached to ${kind === "claude" ? "Claude Code" : "Codex"} (${filePath})`);
      } else {
        p.log.info(`${kind === "claude" ? "Claude Code" : "Codex"} already configured.`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      p.log.error(`Failed to attach to ${kind}: ${msg}`);
    }
  }
}
