import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CallCache } from "./cache.js";
import {
  configFromArgs,
  getDefaultConfigPath,
  loadConfig,
  loadManagedConfig,
  saveManagedConfig,
} from "./config.js";
import {
  applyServerMutation,
  createEmptyConfig,
  formatServerList,
  parseCommandLine,
  parseServerMutationArgs,
  parseServerDefinitionArgs,
  renderClientSnippet,
  serializeServers,
} from "./cli.js";
import {
  attachClaudeConfig,
  attachCodexConfig,
  detachClaudeConfig,
  detachCodexConfig,
  formatClientStatus,
  getClaudeConfigStatus,
  getCodexConfigStatus,
  renderClientAttachPreview,
} from "./client-config.js";
import {
  createDoctorFailureReport,
  formatDoctorReport,
  formatServerTestReports,
  formatServerTestReport,
  runDoctor,
  runServerTest,
} from "./doctor.js";
import { handleBatch, handleCall, handleCacheClear, handleParallel, handlePipeline, handleStatus } from "./handlers.js";
import { CallmuxProxy } from "./proxy.js";
import { mapBounded, UpstreamManager } from "./upstream.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, StdioServerConfig } from "./types.js";
import { META_TOOLS } from "./meta-tools.js";
import { formatCommandForDisplay, redactUrl } from "./redact.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fakeMcpServer(
  name: string,
  env: Record<string, string> = {}
): StdioServerConfig {
  return {
    command: process.execPath,
    args: [join(process.cwd(), "dist-test", "test-fixtures", "fake-mcp-server.js")],
    env: {
      FAKE_MCP_NAME: name,
      ...env,
    },
  };
}

test("CallCache distinguishes nested arguments while preserving stable object order", () => {
  const cache = new CallCache(60);
  const result = textResult("cached");

  cache.set("get_issue", { filter: { state: "open", labels: ["bug"] } }, result);

  assert.deepEqual(
    cache.get("get_issue", { filter: { labels: ["bug"], state: "open" } }),
    result
  );
  assert.equal(
    cache.get("get_issue", { filter: { state: "closed", labels: ["bug"] } }),
    null
  );
});

test("CallCache prunes expired entries", async () => {
  const cache = new CallCache(0.01);

  cache.set("get_issue", { id: 1 }, textResult("stale"));
  assert.equal(cache.size, 1);

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(cache.size, 0);
});

test("CallCache evicts least-recently-used entries beyond max size", () => {
  const cache = new CallCache(60, undefined, undefined, 2);

  cache.set("get_item", { id: 1 }, textResult("one"));
  cache.set("get_item", { id: 2 }, textResult("two"));
  assert.deepEqual(cache.get("get_item", { id: 1 }), textResult("one"));
  cache.set("get_item", { id: 3 }, textResult("three"));

  assert.deepEqual(cache.get("get_item", { id: 1 }), textResult("one"));
  assert.equal(cache.get("get_item", { id: 2 }), null);
  assert.deepEqual(cache.get("get_item", { id: 3 }), textResult("three"));
  assert.equal(cache.stats().maxEntries, 2);
});

test("CallCache respects explicit allow and deny policies", () => {
  const cache = new CallCache(
    60,
    { allowTools: ["get_*"], denyTools: ["get_secret"] },
    { github: { allowTools: ["list_*"] } }
  );

  cache.set("get_issue", { id: 1 }, textResult("issue"));
  cache.set("get_secret", { id: 1 }, textResult("secret"));
  cache.set("list_pull_requests", { page: 1 }, textResult("prs"), "github");

  assert.deepEqual(cache.get("get_issue", { id: 1 }), textResult("issue"));
  assert.equal(cache.get("get_secret", { id: 1 }), null);
  assert.deepEqual(
    cache.get("list_pull_requests", { page: 1 }, "github"),
    textResult("prs")
  );
});

test("parallel caching is scoped by server identity", async () => {
  const cache = new CallCache(60);
  let calls = 0;
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>, server?: string) {
      calls++;
      return textResult(`${server}:${tool}:${JSON.stringify(args)}`);
    },
    getServerConcurrency() { return undefined; },
  };

  await handleParallel(
    upstream as never,
    cache,
    { calls: [{ server: "github", tool: "get_issue", arguments: { id: 1 } }] },
    4
  );
  await handleParallel(
    upstream as never,
    cache,
    { calls: [{ server: "linear", tool: "get_issue", arguments: { id: 1 } }] },
    4
  );

  assert.equal(calls, 2);
});

test("per-server concurrency limits parallel calls to that server", async () => {
  let maxConcurrent = 0;
  let current = 0;
  const upstream = {
    async callTool() {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise((r) => setTimeout(r, 20));
      current--;
      return textResult("ok");
    },
    getServerConcurrency(server: string) {
      return server === "fragile" ? 1 : undefined;
    },
  };

  await handleParallel(
    upstream as never,
    new CallCache(0),
    {
      calls: [
        { server: "fragile", tool: "a", arguments: {} },
        { server: "fragile", tool: "b", arguments: {} },
        { server: "fragile", tool: "c", arguments: {} },
      ],
    },
    10
  );

  assert.equal(maxConcurrent, 1);
});

test("batch respects per-server concurrency limit", async () => {
  let maxConcurrent = 0;
  let current = 0;
  const upstream = {
    async callTool() {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise((r) => setTimeout(r, 20));
      current--;
      return textResult("ok");
    },
    getServerConcurrency() { return 2; },
  };

  await handleBatch(
    upstream as never,
    new CallCache(0),
    {
      server: "limited",
      tool: "process",
      items: [
        { arguments: { id: 1 } },
        { arguments: { id: 2 } },
        { arguments: { id: 3 } },
        { arguments: { id: 4 } },
      ],
    },
    10
  );

  assert.equal(maxConcurrent, 2);
});

test("mutating proxied tools are never served from cache", async () => {
  const proxy = new CallmuxProxy({
    servers: {
      default: { command: "ignored" },
    },
    cacheTtlSeconds: 60,
  });

  let calls = 0;
  (proxy as unknown as {
    upstream: { callTool: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult> };
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  }).upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      calls++;
      return textResult(`${tool}:${JSON.stringify(args)}:${calls}`);
    },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const first = await harness.handleToolCall("create_issue", { title: "x" });
  const second = await harness.handleToolCall("create_issue", { title: "x" });

  assert.equal(calls, 2);
  assert.notDeepEqual(first, second);
});

test("invalid concurrency fails fast instead of hanging", async () => {
  const result = await handleBatch(
    {
      async callTool() {
        return textResult("ok");
      },
    } as never,
    new CallCache(60),
    { tool: "get_issue", items: [{ arguments: { id: 1 } }] },
    0
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "invalid_arguments",
      message: "maxConcurrency must be a positive integer",
      details: { maxConcurrency: 0 },
    },
  });
});

test("pipeline reuses cached read-only step results", async () => {
  const cache = new CallCache(60);
  let calls = 0;
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      calls++;
      return textResult(JSON.stringify({ tool, args, calls }));
    },
  };

  await handlePipeline(
    upstream as never,
    cache,
    { steps: [{ tool: "get_issue", arguments: { id: 42 } }] }
  );
  await handlePipeline(
    upstream as never,
    cache,
    { steps: [{ tool: "get_issue", arguments: { id: 42 } }] }
  );

  assert.equal(calls, 1);
});

test("cache clear can target a specific server", () => {
  const cache = new CallCache(60);

  cache.set("get_issue", { id: 1 }, textResult("github"), "github");
  cache.set("get_issue", { id: 1 }, textResult("linear"), "linear");

  const result = handleCacheClear(cache, { tool: "get_issue", server: "github" });

  assert.deepEqual(result.structuredContent, {
    cleared: 1,
    tool: "get_issue",
    server: "github",
    scope: "tool-server",
  });
  assert.equal(cache.get("get_issue", { id: 1 }, "github"), null);
  assert.deepEqual(
    cache.get("get_issue", { id: 1 }, "linear"),
    textResult("linear")
  );
});

test("parallel validation errors are returned as structured tool errors", async () => {
  const result = await handleParallel(
    {
      async callTool() {
        return textResult("nope");
      },
    } as never,
    new CallCache(60),
    { calls: [{ arguments: {} }] },
    4
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "invalid_arguments",
      message: "calls[0].tool must be a non-empty string",
      details: { field: "calls[0].tool" },
    },
  });
});

test("pipeline validation rejects empty steps", async () => {
  const result = await handlePipeline(
    {
      async callTool() {
        return textResult("nope");
      },
    } as never,
    new CallCache(60),
    { steps: [] }
  );

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "invalid_arguments",
      message: "\"steps\" must contain at least one step",
      details: { field: "steps" },
    },
  });
});

test("configFromArgs rejects invalid concurrency", () => {
  assert.throws(
    () => configFromArgs(["--concurrency", "0", "--", "node", "server.js"]),
    /positive integer/
  );
});

test("configFromArgs rejects unknown options and malformed numeric values", () => {
  assert.throws(
    () => configFromArgs(["--cahce", "60", "--", "node", "server.js"]),
    /Unknown option/
  );

  assert.throws(
    () => configFromArgs(["--cache", "10abc", "--", "node", "server.js"]),
    /non-negative integer/
  );

  assert.throws(
    () => configFromArgs(["--cache", "--", "node", "server.js"]),
    /Missing value/
  );
});

test("configFromArgs parses explicit cache allow and deny lists", () => {
  const config = configFromArgs([
    "--cache",
    "60",
    "--cache-allow",
    "get_*,list_*",
    "--cache-deny",
    "get_secret",
    "--",
    "node",
    "server.js",
  ]);

  assert.deepEqual(config.servers.default.cachePolicy, {
    allowTools: ["get_*", "list_*"],
    denyTools: ["get_secret"],
  });
});

test("configFromArgs parses cache max entries", () => {
  const config = configFromArgs([
    "--cache",
    "60",
    "--cache-max-entries",
    "25",
    "--",
    "node",
    "server.js",
  ]);

  assert.equal(config.maxCacheEntries, 25);
});

test("configFromArgs parses timeout and strict startup flags", () => {
  const config = configFromArgs([
    "--connect-timeout",
    "1000",
    "--call-timeout",
    "2000",
    "--strict-startup",
    "--",
    "node",
    "server.js",
  ]);

  assert.equal(config.connectTimeoutMs, 1000);
  assert.equal(config.callTimeoutMs, 2000);
  assert.equal(config.strictStartup, true);
});

test("configFromArgs parses --env KEY=VALUE pairs", () => {
  const config = configFromArgs([
    "--env",
    "GITHUB_TOKEN=abc123",
    "--env",
    "OTHER_KEY=val=with=equals",
    "--",
    "node",
    "server.js",
  ]);

  assert.deepEqual((config.servers.default as StdioServerConfig).env, {
    GITHUB_TOKEN: "abc123",
    OTHER_KEY: "val=with=equals",
  });
});

test("configFromArgs rejects --env without equals sign", () => {
  assert.throws(
    () => configFromArgs(["--env", "NOEQUALS", "--", "node", "server.js"]),
    /must be KEY=VALUE/
  );
});

test("loadConfig rejects invalid maxConcurrency from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-config-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          default: { command: "node", args: ["server.js"] },
        },
        maxConcurrency: 0,
      })
    );

    await assert.rejects(loadConfig(configPath), /positive integer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses cache policy configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-config-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: {
            command: "node",
            args: ["server.js"],
            cachePolicy: { allowTools: ["get_*"] },
          },
        },
        cachePolicy: { denyTools: ["get_secret"] },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.cachePolicy, { denyTools: ["get_secret"] });
    assert.deepEqual(config.servers.github.cachePolicy, {
      allowTools: ["get_*"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveManagedConfig and loadManagedConfig round-trip native config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-managed-"));
  const configPath = join(dir, "config.json");

  try {
    const config = createEmptyConfig();
    config.servers.github = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    };

    await saveManagedConfig(configPath, config);
    const loaded = await loadManagedConfig(configPath);

    assert.deepEqual(loaded, config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadManagedConfig rejects mcpServers format for managed commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-managed-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      })
    );

    await assert.rejects(loadManagedConfig(configPath), /native callmux config/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseServerDefinitionArgs parses server add options", () => {
  const server = parseServerDefinitionArgs([
    "--tools",
    "get_issue,list_issues",
    "--env",
    "GITHUB_TOKEN=secret",
    "--cwd",
    "/tmp/project",
    "--cache-allow",
    "get_*,list_*",
    "--cache-deny",
    "get_secret",
    "--",
    "npx",
    "-y",
    "@modelcontextprotocol/server-github",
  ]);

  assert.deepEqual(server, {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "secret" },
    cwd: "/tmp/project",
    tools: ["get_issue", "list_issues"],
    cachePolicy: {
      allowTools: ["get_*", "list_*"],
      denyTools: ["get_secret"],
    },
  });
});

test("parseCommandLine preserves quoted custom command arguments", () => {
  assert.deepEqual(
    parseCommandLine('npx -y "server package" --flag="two words" path\\ with\\ spaces'),
    ["npx", "-y", "server package", "--flag=two words", "path with spaces"]
  );

  assert.throws(() => parseCommandLine('node "server.js'), /Unterminated/);
});

test("parseServerMutationArgs parses server set options and command replacement", () => {
  const mutation = parseServerMutationArgs([
    "--add-tool",
    "search",
    "--remove-tool",
    "create_issue",
    "--env",
    "GITHUB_TOKEN=secret",
    "--remove-env",
    "OLD_TOKEN",
    "--cwd",
    "/tmp/project",
    "--cache-allow",
    "get_*,list_*",
    "--cache-deny",
    "get_secret",
    "--",
    "uvx",
    "server-github",
  ]);

  assert.deepEqual(mutation, {
    addTools: ["search"],
    removeTools: ["create_issue"],
    setEnv: { GITHUB_TOKEN: "secret" },
    removeEnv: ["OLD_TOKEN"],
    cwd: "/tmp/project",
    cacheAllowTools: ["get_*", "list_*"],
    cacheDenyTools: ["get_secret"],
    command: "uvx",
    args: ["server-github"],
  });
});

test("applyServerMutation updates tools env cwd and cache policy without leaking empties", () => {
  const updated = applyServerMutation(
    {
      command: "npx",
      args: ["server.js"],
      env: { OLD_TOKEN: "x", KEEP: "y" },
      cwd: "/tmp/old",
      tools: ["get_issue", "create_issue"],
      cachePolicy: { allowTools: ["get_*"], denyTools: ["create_*"] },
    },
    {
      command: "uvx",
      args: ["server-github"],
      addTools: ["search"],
      removeTools: ["create_issue"],
      setEnv: { GITHUB_TOKEN: "secret" },
      removeEnv: ["OLD_TOKEN"],
      cwd: "/tmp/new",
      cacheAllowTools: [],
      cacheDenyTools: ["create_*", "delete_*"],
    }
  );

  assert.deepEqual(updated, {
    command: "uvx",
    args: ["server-github"],
    env: {
      KEEP: "y",
      GITHUB_TOKEN: "secret",
    },
    cwd: "/tmp/new",
    tools: ["get_issue", "search"],
    cachePolicy: {
      denyTools: ["create_*", "delete_*"],
    },
  });
});

test("serializeServers redacts env values and preserves cache policy", () => {
  const config = createEmptyConfig();
  config.servers.github = {
    command: "npx",
    args: ["server.js"],
    env: { B_TOKEN: "b", A_TOKEN: "a" },
    cachePolicy: { allowTools: ["get_*"] },
  };

  assert.deepEqual(serializeServers(config), [
    {
      name: "github",
      command: "npx",
      args: ["server.js"],
      envKeys: ["A_TOKEN", "B_TOKEN"],
      cachePolicy: { allowTools: ["get_*"] },
    },
  ]);
});

test("formatServerList redacts env values and shows key metadata", () => {
  const config = createEmptyConfig();
  config.servers.github = {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "secret" },
    tools: ["get_issue"],
    cachePolicy: { allowTools: ["get_*"] },
  };

  const output = formatServerList(config);

  assert.match(output, /^github/m);
  assert.match(output, /command: npx -y @modelcontextprotocol\/server-github/);
  assert.match(output, /tools: get_issue/);
  assert.match(output, /env keys: GITHUB_TOKEN/);
  assert.doesNotMatch(output, /secret/);
});

test("display helpers redact command arguments and URL secrets", () => {
  assert.equal(
    formatCommandForDisplay("server", [
      "--token",
      "secret-token",
      "--api-key=secret-key",
      "--safe",
      "visible",
    ]),
    "server --token [redacted] --api-key=[redacted] --safe visible"
  );

  assert.equal(
    redactUrl("https://user:pass@example.com/mcp?token=secret&query=visible"),
    "https://%5Bredacted%5D:%5Bredacted%5D@example.com/mcp?token=%5Bredacted%5D&query=visible"
  );
});

test("attachClaudeConfig inserts callmux into Claude config", () => {
  const result = attachClaudeConfig({
    source: JSON.stringify({ theme: "dark" }),
    serverName: "callmux",
  });

  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.content), {
    theme: "dark",
    mcpServers: {
      callmux: {
        command: "callmux",
        args: [],
      },
    },
  });
});

test("detachClaudeConfig removes only the managed entry", () => {
  const result = detachClaudeConfig({
    source: JSON.stringify({
      mcpServers: {
        callmux: { command: "callmux", args: [] },
        github: { command: "npx", args: ["server-github"] },
      },
    }),
    serverName: "callmux",
  });

  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.content), {
    mcpServers: {
      github: { command: "npx", args: ["server-github"] },
    },
  });
});

test("attachCodexConfig adds a managed block and is idempotent", () => {
  const first = attachCodexConfig({
    source: 'model = "gpt-5.4"\n',
    serverName: "callmux",
  });
  const second = attachCodexConfig({
    source: first.content,
    serverName: "callmux",
  });

  assert.equal(first.changed, true);
  assert.match(first.content, /# BEGIN CALLMUX MANAGED callmux/);
  assert.match(first.content, /\[mcp_servers\.callmux\]/);
  assert.equal(second.changed, false);
});

test("detachCodexConfig refuses to remove unmanaged entries", () => {
  assert.throws(
    () =>
      detachCodexConfig({
        source: [
          "[mcp_servers.callmux]",
          'command = "callmux"',
          "args = []",
        ].join("\n"),
        serverName: "callmux",
      }),
    /unmanaged/
  );
});

test("getClaudeConfigStatus reports drifted entries", () => {
  const status = getClaudeConfigStatus({
    source: JSON.stringify({
      mcpServers: {
        callmux: {
          command: "callmux",
          args: ["--config", "/tmp/old.json"],
        },
      },
    }),
    configPath: "/tmp/new.json",
    serverName: "callmux",
  });

  assert.equal(status.status, "different_entry");
  assert.equal(status.configured, false);
});

test("getCodexConfigStatus distinguishes managed and unmanaged entries", () => {
  const managed = getCodexConfigStatus({
    source: [
      "# BEGIN CALLMUX MANAGED callmux",
      "[mcp_servers.callmux]",
      'command = "callmux"',
      'args = ["--config","/tmp/callmux.json"]',
      "# END CALLMUX MANAGED callmux",
    ].join("\n"),
    configPath: "/tmp/callmux.json",
    serverName: "callmux",
  });
  const unmanaged = getCodexConfigStatus({
    source: [
      "[mcp_servers.callmux]",
      'command = "callmux"',
      "args = []",
    ].join("\n"),
    serverName: "callmux",
  });

  assert.equal(managed.status, "configured_managed");
  assert.equal(managed.configured, true);
  assert.equal(unmanaged.status, "unmanaged_entry");
  assert.equal(unmanaged.configured, false);
});

test("formatClientStatus renders a compact status block", () => {
  const output = formatClientStatus({
    client: "codex",
    path: "/tmp/config.toml",
    serverName: "callmux",
    exists: true,
    status: "configured_managed",
    configured: true,
    details: "CALLMUX-managed entry matches expected config",
  });

  assert.match(output, /^codex: configured_managed/m);
  assert.match(output, /configured: yes/);
});

test("renderClientAttachPreview only includes the managed callmux snippet", () => {
  const preview = renderClientAttachPreview("claude", {
    configPath: "/tmp/callmux.json",
    serverName: "callmux",
  });

  assert.deepEqual(JSON.parse(preview), {
    mcpServers: {
      callmux: {
        command: "callmux",
        args: ["--config", "/tmp/callmux.json"],
      },
    },
  });
});

test("renderClientSnippet emits Claude snippet with default autodiscovery", () => {
  const snippet = JSON.parse(renderClientSnippet("claude"));

  assert.deepEqual(snippet, {
    mcpServers: {
      callmux: {
        command: "callmux",
        args: [],
      },
    },
  });
});

test("renderClientSnippet emits Codex snippet with explicit config path when needed", () => {
  const configPath = join(tmpdir(), "custom-callmux.json");
  const snippet = renderClientSnippet("codex", {
    configPath,
    serverName: "github",
  });

  assert.equal(
    snippet,
    [
      "[mcp_servers.github]",
      'command = "callmux"',
      `args = ${JSON.stringify(["--config", configPath])}`,
    ].join("\n")
  );
});

test("client config helpers reject unsafe server names", () => {
  assert.throws(
    () =>
      renderClientSnippet("codex", {
        serverName: 'callmux"]\n[mcp_servers.injected]',
      }),
    /client server name/
  );

  assert.throws(
    () =>
      renderClientAttachPreview("claude", {
        serverName: "bad name",
      }),
    /client server name/
  );
});

test("getDefaultConfigPath points to callmux config.json", () => {
  assert.match(getDefaultConfigPath(), /callmux[\/\\]config\.json$/);
});

test("runDoctor reports empty config as healthy", async () => {
  const report = await runDoctor("/tmp/callmux.json", {
    config: createEmptyConfig(),
    format: "native",
  });

  assert.equal(report.ok, true);
  assert.equal(report.serverCount, 0);
  assert.deepEqual(report.issues, []);
});

test("runServerTest reports missing executables cleanly", async () => {
  const report = await runServerTest("github", {
    command: "definitely-not-a-real-callmux-command",
  });

  assert.equal(report.status, "error");
  assert.deepEqual(report.tools, []);
  assert.match(report.issues[0], /was not found on PATH/);
});

test("formatServerTestReports summarizes multiple server checks", () => {
  const output = formatServerTestReports([
    {
      name: "github",
      command: "node github.js",
      status: "ok",
      tools: ["get_issue"],
      issues: [],
    },
    {
      name: "linear",
      command: "node linear.js",
      status: "error",
      tools: [],
      issues: ["connect/list-tools failed: boom"],
    },
  ]);

  assert.match(output, /Servers tested: 2/);
  assert.match(output, /Failed: 1/);
  assert.match(output, /linear/);
});

test("formatDoctorReport includes server issues and summary", () => {
  const output = formatDoctorReport({
    ok: false,
    configPath: "/tmp/callmux.json",
    format: "native",
    serverCount: 1,
    cacheTtlSeconds: 60,
    maxConcurrency: 20,
    issues: ['github: command "npx" was not found on PATH'],
    servers: [
      {
        name: "github",
        command: "npx -y @modelcontextprotocol/server-github",
        status: "error",
        issues: ['command "npx" was not found on PATH'],
      },
    ],
  });

  assert.match(output, /Status: issues found/);
  assert.match(output, /\[error\] github/);
  assert.match(output, /issue: command "npx" was not found on PATH/);
});

test("formatServerTestReport includes requested tool status and tools", () => {
  const output = formatServerTestReport({
    name: "github",
    command: "npx -y @modelcontextprotocol/server-github",
    status: "error",
    tools: ["get_issue", "list_issues"],
    issues: ['tool "search" was not exposed by "github"'],
    requestedTool: "search",
    requestedToolFound: false,
  });

  assert.match(output, /Requested tool: search \(missing\)/);
  assert.match(output, /- get_issue/);
  assert.match(output, /Issue: tool "search" was not exposed by "github"/);
});

test("createDoctorFailureReport marks missing config cleanly", () => {
  const report = createDoctorFailureReport(
    "/tmp/callmux.json",
    "missing",
    "config file not found: /tmp/callmux.json"
  );

  assert.equal(report.ok, false);
  assert.equal(report.format, "missing");
  assert.deepEqual(report.issues, ["config file not found: /tmp/callmux.json"]);
});

test("package test script executes compiled test files", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf-8")
  ) as { scripts?: Record<string, string> };

  assert.equal(
    packageJson.scripts?.test,
    "tsc --project tsconfig.test.json && node --test dist-test/*.test.js"
  );
});

test("server hints cannot bypass exposed tool filtering", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: () => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let calls = 0;
  upstream.clients = new Map([
    [
      "github",
      {
        async callTool() {
          calls++;
          return textResult("hidden");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["github__get_issue", { server: "github", tool: { name: "get_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["get_issue"])]]);

  const result = await upstream.callTool("delete_issue", { id: 1 }, "github");

  assert.equal(calls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "tool_resolution_failed",
      message: 'tool "delete_issue" is not exposed on server "github"',
    },
  });
});

test("ambiguous unqualified tool names require explicit server selection", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: () => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let calls = 0;
  upstream.clients = new Map([
    [
      "github",
      {
        async callTool() {
          calls++;
          return textResult("github");
        },
      },
    ],
    [
      "linear",
      {
        async callTool() {
          calls++;
          return textResult("linear");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["github__get_issue", { server: "github", tool: { name: "get_issue" } }],
    ["linear__get_issue", { server: "linear", tool: { name: "get_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([
    ["github", new Set(["get_issue"])],
    ["linear", new Set(["get_issue"])],
  ]);

  const result = await upstream.callTool("get_issue", { id: 1 });

  assert.equal(calls, 0);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "tool_resolution_failed",
      message:
        'tool "get_issue" is ambiguous across multiple servers; specify "server" or use a qualified tool name',
    },
  });
});

test("tool lookup failures return structured error payloads", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: () => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map();
  upstream.toolMap = new Map();
  upstream.exposedToolsByServer = new Map();

  const result = await upstream.callTool("missing_tool");

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "tool_not_found",
      message: 'tool "missing_tool" not found',
      details: { tool: "missing_tool" },
    },
  });
});

test("mapBounded runs work concurrently while preserving input order", async () => {
  let active = 0;
  let maxActive = 0;
  const starts: number[] = [];

  const results = await mapBounded([1, 2, 3, 4], 2, async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    starts.push(value);
    await new Promise((resolve) => setTimeout(resolve, value === 1 ? 30 : 5));
    active--;
    return value * 10;
  });

  assert.deepEqual(results, [10, 20, 30, 40]);
  assert.equal(maxActive, 2);
  assert.deepEqual(starts.slice(0, 2), [1, 2]);
});

test("UpstreamManager degraded startup keeps successful servers and records failures", async () => {
  const upstream = new UpstreamManager();
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    if (name === "bad") throw new Error("boom");
    const tool = mockTool("get_issue");
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult("ok");
        },
        async close() {},
      },
      transport: { async close() {} },
      allTools: [tool],
      tools: [tool],
    };
  };

  const connections = await upstream.connect({
    good: { command: "good" },
    bad: { command: "bad" },
  });

  assert.deepEqual(connections.map((connection) => connection.name), ["good"]);
  assert.deepEqual(upstream.getServerNames(), ["good"]);
  assert.deepEqual(upstream.getFailedServers().map((failure) => failure.name), ["bad"]);
});

test("UpstreamManager strict startup fails when any server fails", async () => {
  let closed = false;
  const upstream = new UpstreamManager();
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    if (name === "bad") throw new Error("boom");
    const tool = mockTool("get_issue");
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult("ok");
        },
        async close() {
          closed = true;
        },
      },
      transport: { async close() {} },
      allTools: [tool],
      tools: [tool],
    };
  };

  await assert.rejects(
    upstream.connect(
      {
        good: { command: "good" },
        bad: { command: "bad" },
      },
      { strictStartup: true }
    ),
    /downstream startup failed/
  );
  assert.equal(closed, true);
});

test("UpstreamManager call timeout returns a structured tool error", async () => {
  const upstream = new UpstreamManager(5) as unknown as {
    clients: Map<string, { callTool: () => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map([
    [
      "github",
      {
        async callTool() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return textResult("late");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["get_issue", { server: "github", tool: { name: "get_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["get_issue"])]]);

  const result = await upstream.callTool("get_issue", { id: 1 });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "tool_call_failed",
      message: 'tool "get_issue" timed out after 5ms',
      details: { tool: "get_issue" },
    },
  });
});

test("fake MCP fixture supports real stdio listTools and callTool", async () => {
  const upstream = new UpstreamManager();

  try {
    const connections = await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([
          { name: "get_item", description: "Get a fake item" },
        ]),
      }),
    });

    assert.equal(connections.length, 1);
    assert.deepEqual(connections[0].tools.map((tool) => tool.name), ["get_item"]);

    const result = await upstream.callTool("get_item", { id: 42 });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      server: string;
      tool: string;
      arguments: { id: number };
    };
    assert.deepEqual(payload, {
      server: "fake",
      tool: "get_item",
      arguments: { id: 42 },
    });
  } finally {
    await upstream.close();
  }
});

test("fake MCP fixture verifies degraded startup with a failed server", async () => {
  const upstream = new UpstreamManager();

  try {
    const connections = await upstream.connect(
      {
        good: fakeMcpServer("good", {
          FAKE_MCP_TOOLS: JSON.stringify([{ name: "get_item" }]),
        }),
        bad: fakeMcpServer("bad", {
          FAKE_MCP_FAIL_START: "1",
        }),
      },
      { maxConcurrency: 2 }
    );

    assert.deepEqual(connections.map((connection) => connection.name), ["good"]);
    assert.deepEqual(upstream.getServerNames(), ["good"]);
    assert.deepEqual(upstream.getFailedServers().map((failure) => failure.name), ["bad"]);

    const result = await upstream.callTool("get_item", { id: 1 }, "good");
    assert.equal(result.isError, undefined);
  } finally {
    await upstream.close();
  }
});

test("fake MCP fixture verifies startup timeout", async () => {
  const upstream = new UpstreamManager();

  try {
    const connections = await upstream.connect(
      {
        slow: fakeMcpServer("slow", {
          FAKE_MCP_START_DELAY_MS: "250",
        }),
      },
      { connectTimeoutMs: 50 }
    );

    assert.deepEqual(connections, []);
    assert.equal(upstream.getFailedServers()[0].name, "slow");
    assert.match(upstream.getFailedServers()[0].error, /connect.*timed out/);
  } finally {
    await upstream.close();
  }
});

// ─── HTTP/SSE transport config tests ──────────────────────────

test("configFromArgs parses --url for HTTP transport", () => {
  const config = configFromArgs(["--url", "https://mcp.example.com/mcp", "--cache", "30"]);

  assert.deepEqual(config.servers.default, { url: "https://mcp.example.com/mcp" });
  assert.equal(config.cacheTtlSeconds, 30);
});

test("configFromArgs parses --url with --transport and --header", () => {
  const config = configFromArgs([
    "--url", "https://mcp.example.com/sse",
    "--transport", "sse",
    "--header", "Authorization:Bearer token123",
    "--tools", "read,write",
  ]);

  assert.deepEqual(config.servers.default, {
    url: "https://mcp.example.com/sse",
    transport: "sse",
    headers: { Authorization: "Bearer token123" },
    tools: ["read", "write"],
  });
});

test("configFromArgs rejects --url combined with -- command", () => {
  assert.throws(
    () => configFromArgs(["--url", "https://example.com", "--", "node", "server.js"]),
    /Cannot use both --url and -- command/
  );
});

test("configFromArgs rejects invalid --transport value", () => {
  assert.throws(
    () => configFromArgs(["--url", "https://example.com", "--transport", "websocket"]),
    /must be "streamable-http" or "sse"/
  );
});

test("loadConfig parses HTTP server config from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-http-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          remote: {
            url: "https://mcp.example.com/mcp",
            transport: "streamable-http",
            headers: { "X-Api-Key": "secret" },
            tools: ["search"],
          },
        },
        cacheTtlSeconds: 60,
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.servers.remote, {
      url: "https://mcp.example.com/mcp",
      transport: "streamable-http",
      headers: { "X-Api-Key": "secret" },
      tools: ["search"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects server with both command and url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-both-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          bad: { command: "node", url: "https://example.com" },
        },
      })
    );

    await assert.rejects(loadConfig(configPath), /cannot have both/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects server with neither command nor url", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-none-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          bad: { args: ["--flag"] },
        },
      })
    );

    await assert.rejects(loadConfig(configPath), /must have either/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatServerList handles mixed stdio and http servers", () => {
  const config: import("./types.js").CallmuxConfig = {
    servers: {
      local: { command: "node", args: ["server.js"], env: { TOKEN: "x" } },
      remote: { url: "https://mcp.example.com/sse", transport: "sse" },
    },
  };

  const output = formatServerList(config);
  assert.match(output, /local/);
  assert.match(output, /command: node server\.js/);
  assert.match(output, /remote/);
  assert.match(output, /url: https:\/\/mcp\.example\.com\/sse/);
  assert.match(output, /transport: sse/);
});

// ─── Config detection tests ───────────────────────────────────

test("detectExistingConfigs finds servers from .mcp.json in cwd", async () => {
  const { detectExistingConfigs: detect } = await import("./detect.js");
  const dir = await mkdtemp(join(tmpdir(), "callmux-detect-"));
  const originalCwd = process.cwd();

  try {
    process.chdir(dir);
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
          remote: { url: "https://api.example.com/mcp" },
        },
      })
    );

    const result = await detect();
    const names = result.servers.map((s) => s.name);
    assert.ok(names.includes("github"));
    assert.ok(names.includes("remote"));

    const github = result.servers.find((s) => s.name === "github")!;
    assert.equal((github.config as StdioServerConfig).command, "npx");

    const remote = result.servers.find((s) => s.name === "remote")!;
    assert.equal((remote.config as import("./types.js").HttpServerConfig).url, "https://api.example.com/mcp");
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Meta-only mode tests ────────────────────────────────────

function createMockUpstream(tools: Array<{ server: string; tool: Tool }>) {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (req: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: Tool }>;
    exposedToolsByServer: Map<string, Set<string>>;
    serverInfoMap: Map<string, { transport: string; state: string; connectDurationMs: number; totalTools: number; exposedTools: number; toolFilter?: string[]; maxConcurrency?: number; error?: string }>;
    serverConcurrency: Map<string, number>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
    resolveServer: (toolName: string, serverHint?: string) => { client: unknown; actualName: string } | { error: CallToolResult } | null;
    getServerNames: () => string[];
    getServerTools: (server: string) => string[];
    getServerInfo: (server: string) => { transport: string; state: string; connectDurationMs: number; totalTools: number; exposedTools: number; toolFilter?: string[]; maxConcurrency?: number } | undefined;
    getServerConcurrency: (server: string) => number | undefined;
    getToolsWithDescriptions: (server: string) => Array<{ name: string; description?: string }>;
  };

  upstream.clients = new Map();
  upstream.toolMap = new Map();
  upstream.exposedToolsByServer = new Map();
  upstream.serverInfoMap = new Map();
  upstream.serverConcurrency = new Map();

  const servers = new Set(tools.map((t) => t.server));
  for (const server of servers) {
    upstream.clients.set(server, {
      async callTool(req) {
        return textResult(`${server}:${req.name}:${JSON.stringify(req.arguments)}`);
      },
    });
    const serverTools = tools.filter((t) => t.server === server);
    upstream.exposedToolsByServer.set(
      server,
      new Set(serverTools.map((t) => t.tool.name))
    );
    upstream.serverInfoMap.set(server, {
      transport: "stdio",
      state: "connected",
      connectDurationMs: 42,
      totalTools: serverTools.length,
      exposedTools: serverTools.length,
    });
  }

  const multiServer = servers.size > 1;
  for (const { server, tool } of tools) {
    const qualified = multiServer ? `${server}__${tool.name}` : tool.name;
    upstream.toolMap.set(qualified, { server, tool });
  }

  return upstream;
}

function mockTool(name: string, description?: string): Tool {
  return {
    name,
    ...(description ? { description } : {}),
    inputSchema: { type: "object" as const },
  };
}

test("handleCall passes through to upstream and caches result", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);

  const cache = new CallCache(60);
  const result = await handleCall(upstream as never, cache, {
    tool: "get_issue",
    arguments: { id: 1 },
  });

  assert.equal(result.isError, undefined);
  assert.equal(cache.size, 1);

  const cached = await handleCall(upstream as never, cache, {
    tool: "get_issue",
    arguments: { id: 1 },
  });
  assert.deepEqual(cached, result);
});

test("handleCall returns tool_not_found with available tools", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
    { server: "github", tool: mockTool("list_issues") },
  ]);

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "missing_tool",
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "tool_not_found",
      message: 'tool "missing_tool" not found',
      details: {
        tool: "missing_tool",
        available: ["get_issue", "list_issues"],
      },
    },
  });
});

test("handleCall validates missing tool name", async () => {
  const upstream = createMockUpstream([]);
  const result = await handleCall(upstream as never, new CallCache(0), {});

  assert.equal(result.isError, true);
  assert.match(
    (result.structuredContent as { error: { message: string } }).error.message,
    /non-empty string/
  );
});

test("handleStatus includes mode field", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);
  const cache = new CallCache(0);

  const standard = handleStatus(upstream as never, cache, 20, false, undefined, {});
  assert.equal(
    (standard.structuredContent as { mode: string }).mode,
    "standard"
  );

  const metaOnly = handleStatus(upstream as never, cache, 20, true, undefined, {});
  assert.equal(
    (metaOnly.structuredContent as { mode: string }).mode,
    "meta-only"
  );
});

test("handleStatus returns descriptions when requested", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue by number") },
    { server: "github", tool: mockTool("list_issues", "List issues in a repository") },
  ]);

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, undefined, {
    descriptions: true,
  });

  const content = result.structuredContent as {
    servers: Array<{
      tools: Array<{ name: string; description: string }>;
    }>;
  };

  assert.equal(content.servers[0].tools[0].name, "get_issue");
  assert.equal(content.servers[0].tools[0].description, "Get a specific issue by number");
});

test("handleStatus truncates descriptions to maxLength", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue by number from the repository") },
  ]);

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, undefined, {
    descriptions: true,
    descriptionMaxLength: 20,
  });

  const content = result.structuredContent as {
    servers: Array<{
      tools: Array<{ name: string; description: string }>;
    }>;
  };

  assert.equal(content.servers[0].tools[0].description, "Get a specific issue...");
});

test("handleStatus uses config default for descriptionMaxLength", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue by number from the repository") },
  ]);

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, 15, {
    descriptions: true,
  });

  const content = result.structuredContent as {
    servers: Array<{
      tools: Array<{ name: string; description: string }>;
    }>;
  };

  assert.equal(content.servers[0].tools[0].description, "Get a specific ...");
});

test("handleStatus per-call descriptionMaxLength overrides config default", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue by number from the repository") },
  ]);

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, 15, {
    descriptions: true,
    descriptionMaxLength: 30,
  });

  const content = result.structuredContent as {
    servers: Array<{
      tools: Array<{ name: string; description: string }>;
    }>;
  };

  assert.equal(content.servers[0].tools[0].description, "Get a specific issue by number...");
});

test("handleStatus includes transport, state, and connectDurationMs per server", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, undefined, {});
  const content = result.structuredContent as {
    servers: Array<{ name: string; transport: string; state: string; connectDurationMs: number }>;
  };

  assert.equal(content.servers[0].transport, "stdio");
  assert.equal(content.servers[0].state, "connected");
  assert.equal(typeof content.servers[0].connectDurationMs, "number");
});

test("handleStatus includes toolFilter when tools are filtered", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);
  upstream.serverInfoMap.set("github", {
    transport: "stdio",
    state: "connected",
    connectDurationMs: 50,
    totalTools: 5,
    exposedTools: 1,
    toolFilter: ["get_issue"],
  });

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, undefined, {});
  const content = result.structuredContent as {
    servers: Array<{ name: string; toolFilter: string[]; totalTools: number }>;
  };

  assert.deepEqual(content.servers[0].toolFilter, ["get_issue"]);
  assert.equal(content.servers[0].totalTools, 5);
});

test("handleStatus returns string array without descriptions flag", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue") },
  ]);

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, undefined, {});

  const content = result.structuredContent as {
    servers: Array<{ tools: string[] }>;
  };

  assert.deepEqual(content.servers[0].tools, ["get_issue"]);
});

test("handleStatus reports degraded startup failures with diagnostics", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]) as unknown as ReturnType<typeof createMockUpstream> & {
    getFailedServers: () => Array<{ name: string; error: string }>;
  };
  upstream.getFailedServers = () => [{ name: "linear", error: "boom" }];
  upstream.serverInfoMap.set("linear", {
    transport: "stdio",
    state: "failed",
    connectDurationMs: 30000,
    totalTools: 0,
    exposedTools: 0,
    error: "boom",
  });

  const result = handleStatus(upstream as never, new CallCache(0), 20, false, undefined, {});
  const content = result.structuredContent as {
    status: string;
    failedServers: Array<{ name: string; error: string; transport: string; connectDurationMs: number }>;
  };

  assert.equal(content.status, "degraded");
  assert.equal(content.failedServers[0].name, "linear");
  assert.equal(content.failedServers[0].error, "boom");
  assert.equal(content.failedServers[0].transport, "stdio");
  assert.equal(content.failedServers[0].connectDurationMs, 30000);
});

test("meta-only proxy exposes only meta-tools", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
    metaOnly: true,
  });

  const allTools = (proxy as unknown as { allTools: Tool[] }).allTools;
  // allTools is empty until start() is called, but META_TOOLS should be the reference
  assert.equal(META_TOOLS.length, 6);
  assert.ok(META_TOOLS.some((t) => t.name === "callmux_call"));
});

test("configFromArgs parses --meta-only flag", () => {
  const config = configFromArgs(["--meta-only", "--", "node", "server.js"]);
  assert.equal(config.metaOnly, true);
});

test("configFromArgs parses --description-max-length", () => {
  const config = configFromArgs(["--description-max-length", "100", "--", "node", "server.js"]);
  assert.equal(config.descriptionMaxLength, 100);
});

test("configFromArgs omits metaOnly when not specified", () => {
  const config = configFromArgs(["--", "node", "server.js"]);
  assert.equal(config.metaOnly, undefined);
});

test("loadConfig parses metaOnly and descriptionMaxLength from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-meta-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        metaOnly: true,
        descriptionMaxLength: 80,
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.metaOnly, true);
    assert.equal(config.descriptionMaxLength, 80);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses startup timeout settings from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-timeout-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        connectTimeoutMs: 1000,
        callTimeoutMs: 2000,
        strictStartup: true,
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.connectTimeoutMs, 1000);
    assert.equal(config.callTimeoutMs, 2000);
    assert.equal(config.strictStartup, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid metaOnly type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-meta-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        metaOnly: "yes",
      })
    );

    await assert.rejects(loadConfig(configPath), /metaOnly must be a boolean/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Pipeline inputMapping tests ─────────────────────────────

test("pipeline $text mapping passes full text from previous step", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      if (tool === "step1") return textResult("hello world");
      capturedArgs = args ?? {};
      return textResult("done");
    },
  };

  await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", inputMapping: { body: "$text" } },
    ],
  });

  assert.equal(capturedArgs.body, "hello world");
});

test("pipeline $json mapping parses JSON from previous step", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      if (tool === "step1") return textResult(JSON.stringify({ id: 42, name: "test" }));
      capturedArgs = args ?? {};
      return textResult("done");
    },
  };

  await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", inputMapping: { data: "$json" } },
    ],
  });

  assert.deepEqual(capturedArgs.data, { id: 42, name: "test" });
});

test("pipeline $json.field.path extracts nested values", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      if (tool === "step1") {
        return textResult(JSON.stringify({ user: { address: { city: "Stockholm" } } }));
      }
      capturedArgs = args ?? {};
      return textResult("done");
    },
  };

  await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", inputMapping: { city: "$json.user.address.city" } },
    ],
  });

  assert.equal(capturedArgs.city, "Stockholm");
});

test("pipeline $json.path returns undefined for missing nested fields", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      if (tool === "step1") return textResult(JSON.stringify({ user: { name: "Edin" } }));
      capturedArgs = args ?? {};
      return textResult("done");
    },
  };

  await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", arguments: { fallback: "default" }, inputMapping: { missing: "$json.user.address.city" } },
    ],
  });

  assert.equal(capturedArgs.missing, undefined);
  assert.equal(capturedArgs.fallback, "default");
});

test("pipeline $json returns undefined for non-JSON text", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      if (tool === "step1") return textResult("not json at all");
      capturedArgs = args ?? {};
      return textResult("done");
    },
  };

  await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", arguments: { keep: "this" }, inputMapping: { data: "$json" } },
    ],
  });

  assert.equal(capturedArgs.data, undefined);
  assert.equal(capturedArgs.keep, "this");
});

test("pipeline literal string mapping passes expression as-is", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      if (tool === "step1") return textResult("ignored");
      capturedArgs = args ?? {};
      return textResult("done");
    },
  };

  await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", inputMapping: { mode: "override_value" } },
    ],
  });

  assert.equal(capturedArgs.mode, "override_value");
});

test("pipeline inputMapping on first step is ignored", async () => {
  let capturedArgs: Record<string, unknown> = {};
  const upstream = {
    async callTool(_tool: string, args?: Record<string, unknown>) {
      capturedArgs = args ?? {};
      return textResult("done");
    },
  };

  await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1", arguments: { id: 1 }, inputMapping: { data: "$text" } },
    ],
  });

  assert.equal(capturedArgs.id, 1);
  assert.equal(capturedArgs.data, undefined);
});

// ─── Pipeline error mid-chain tests ──────────────────────────

test("pipeline stops on step error and returns partial results", async () => {
  const upstream = {
    async callTool(tool: string) {
      if (tool === "step1") return textResult("ok");
      if (tool === "step2") return { content: [{ type: "text" as const, text: "boom" }], isError: true };
      return textResult("should not reach");
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2" },
      { tool: "step3" },
    ],
  });

  const content = result.structuredContent as {
    steps: Array<{ step: number; tool: string; result?: CallToolResult; error?: string }>;
    finalResult?: CallToolResult;
  };

  assert.equal(content.steps.length, 2);
  assert.equal(content.steps[0].tool, "step1");
  assert.equal(content.steps[1].tool, "step2");
  assert.equal(content.steps[1].result?.isError, true);
  assert.equal(content.finalResult, undefined);
});

test("pipeline stops on step exception and returns partial results", async () => {
  const upstream = {
    async callTool(tool: string) {
      if (tool === "step1") return textResult("ok");
      if (tool === "step2") throw new Error("connection refused");
      return textResult("should not reach");
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2" },
      { tool: "step3" },
    ],
  });

  const content = result.structuredContent as {
    steps: Array<{ step: number; tool: string; error?: string }>;
  };

  assert.equal(content.steps.length, 2);
  assert.equal(content.steps[1].error, "connection refused");
});

test("pipeline returns finalResult on full success", async () => {
  const upstream = {
    async callTool(tool: string) {
      return textResult(`result-from-${tool}`);
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2" },
    ],
  });

  const content = result.structuredContent as {
    steps: Array<{ step: number; tool: string }>;
    finalResult: CallToolResult;
  };

  assert.equal(content.steps.length, 2);
  assert.ok(content.finalResult);
});

// ─── Batch mixed results tests ───────────────────────────────

test("batch reports correct succeeded and failed counts", async () => {
  let callIndex = 0;
  const upstream = {
    async callTool() {
      callIndex++;
      if (callIndex === 2) return { content: [{ type: "text" as const, text: "error" }], isError: true };
      if (callIndex === 4) throw new Error("timeout");
      return textResult(`ok-${callIndex}`);
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "process_item",
    items: [
      { arguments: { id: 1 } },
      { arguments: { id: 2 } },
      { arguments: { id: 3 } },
      { arguments: { id: 4 } },
      { arguments: { id: 5 } },
    ],
  }, 1);

  const content = result.structuredContent as {
    succeeded: number;
    failed: number;
    results: Array<{ index: number; result?: CallToolResult; error?: string }>;
  };

  assert.equal(content.succeeded, 3);
  assert.equal(content.failed, 2);
  assert.equal(content.results.length, 5);

  assert.ok(content.results[1].result?.isError);
  assert.equal(content.results[3].error, "timeout");
});

test("batch with all items succeeding reports zero failures", async () => {
  const upstream = {
    async callTool(_tool: string, args?: Record<string, unknown>) {
      return textResult(`done-${(args as { id: number }).id}`);
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "get_item",
    items: [
      { arguments: { id: 1 } },
      { arguments: { id: 2 } },
    ],
  }, 4);

  const content = result.structuredContent as { succeeded: number; failed: number };
  assert.equal(content.succeeded, 2);
  assert.equal(content.failed, 0);
});

// ─── handleCall with server hints and qualified names ─────────

test("handleCall resolves tool with explicit server hint", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
    { server: "linear", tool: mockTool("get_issue") },
  ]);

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "get_issue",
    server: "github",
    arguments: { id: 1 },
  });

  assert.equal(result.isError, undefined);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /^github:/);
});

test("handleCall resolves qualified tool name without server hint", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
    { server: "linear", tool: mockTool("get_issue") },
  ]);

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "github__get_issue",
    arguments: { id: 1 },
  });

  assert.equal(result.isError, undefined);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /^github:/);
});

test("handleCall returns error for ambiguous tool without server hint", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
    { server: "linear", tool: mockTool("get_issue") },
  ]);

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "get_issue",
    arguments: { id: 1 },
  });

  assert.equal(result.isError, true);
  assert.match(
    (result.structuredContent as { error: { message: string } }).error.message,
    /ambiguous/
  );
});

test("handleCall returns error for unknown server", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "get_issue",
    server: "nonexistent",
  });

  assert.equal(result.isError, true);
  assert.match(
    (result.structuredContent as { error: { message: string } }).error.message,
    /not found/
  );
});

// ─── Proxy routing end-to-end tests ──────────────────────────

test("proxy routes callmux_call to handleCall", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  (proxy as unknown as {
    upstream: {
      callTool: () => Promise<CallToolResult>;
      resolveServer: () => null;
      getServerNames: () => string[];
      getServerTools: (s: string) => string[];
      getFailedServers: () => [];
    }
  }).upstream = {
    async callTool() {
      return textResult("proxied");
    },
    resolveServer() { return null; },
    getServerNames() { return ["default"]; },
    getServerTools() { return ["list_items"]; },
    getFailedServers() { return []; },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_call", { tool: "get_issue" });

  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    "tool_not_found"
  );
  assert.deepEqual(
    (result.structuredContent as { error: { details: { available: string[] } } }).error.details.available,
    ["list_items"]
  );
});

test("proxy routes callmux_parallel to handleParallel", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  (proxy as unknown as { upstream: {
    callTool: () => Promise<CallToolResult>;
    getServerConcurrency: () => number | undefined;
  } }).upstream = {
    async callTool() {
      return textResult("parallel-result");
    },
    getServerConcurrency() { return undefined; },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_parallel", {
    calls: [{ tool: "get_issue", arguments: { id: 1 } }],
  });

  const content = result.structuredContent as { results: Array<{ call: { tool: string } }> };
  assert.equal(content.results[0].call.tool, "get_issue");
});

test("proxy routes callmux_batch to handleBatch", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  (proxy as unknown as { upstream: {
    callTool: () => Promise<CallToolResult>;
    getServerConcurrency: () => number | undefined;
  } }).upstream = {
    async callTool() {
      return textResult("batch-result");
    },
    getServerConcurrency() { return undefined; },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_batch", {
    tool: "get_issue",
    items: [{ arguments: { id: 1 } }],
  });

  const content = result.structuredContent as { succeeded: number };
  assert.equal(content.succeeded, 1);
});

test("proxy routes callmux_status to handleStatus", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  (proxy as unknown as {
    upstream: {
      getServerNames: () => string[];
      getServerTools: () => string[];
      getServerInfo: () => { transport: string; state: string; connectDurationMs: number; totalTools: number; exposedTools: number } | undefined;
      getFailedServers: () => [];
    }
  }).upstream = {
    getServerNames: () => ["default"],
    getServerTools: () => ["get_issue"],
    getServerInfo: () => ({ transport: "stdio", state: "connected", connectDurationMs: 42, totalTools: 1, exposedTools: 1 }),
    getFailedServers: () => [],
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_status", {});
  const content = result.structuredContent as { status: string; mode: string };
  assert.equal(content.status, "ok");
  assert.equal(content.mode, "standard");
});

test("proxy routes unrecognized names to proxied tool path", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  let proxiedTool = "";
  (proxy as unknown as { upstream: { callTool: (name: string) => Promise<CallToolResult> } }).upstream = {
    async callTool(name: string) {
      proxiedTool = name;
      return textResult("proxied-result");
    },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("get_issue", { id: 1 });
  assert.equal(proxiedTool, "get_issue");
  assert.equal(result.isError, undefined);
});

// ─── Cache wildcard policy tests ─────────────────────────────

test("cache allowTools wildcard matches tool prefixes", () => {
  const cache = new CallCache(60, { allowTools: ["get_*"] });

  cache.set("get_issue", { id: 1 }, textResult("issue"));
  cache.set("create_issue", { title: "x" }, textResult("created"));

  assert.deepEqual(cache.get("get_issue", { id: 1 }), textResult("issue"));
  assert.equal(cache.get("create_issue", { title: "x" }), null);
});

test("cache denyTools wildcard blocks matching tools", () => {
  const cache = new CallCache(60, { denyTools: ["get_secret*"] });

  cache.set("get_issue", { id: 1 }, textResult("issue"));
  cache.set("get_secret_key", { id: 1 }, textResult("secret"));

  assert.deepEqual(cache.get("get_issue", { id: 1 }), textResult("issue"));
  assert.equal(cache.get("get_secret_key", { id: 1 }), null);
});

test("cache denyTools takes precedence over allowTools", () => {
  const cache = new CallCache(60, {
    allowTools: ["get_*"],
    denyTools: ["get_secret"],
  });

  cache.set("get_issue", { id: 1 }, textResult("issue"));
  cache.set("get_secret", { id: 1 }, textResult("secret"));

  assert.deepEqual(cache.get("get_issue", { id: 1 }), textResult("issue"));
  assert.equal(cache.get("get_secret", { id: 1 }), null);
});

test("per-server cache policy allows tools that would be skipped by default", () => {
  const cache = new CallCache(
    60,
    undefined,
    { github: { allowTools: ["submit_review"] } }
  );

  cache.set("submit_review", { body: "lgtm" }, textResult("submitted"), "github");
  cache.set("submit_review", { body: "lgtm" }, textResult("submitted"));

  assert.deepEqual(
    cache.get("submit_review", { body: "lgtm" }, "github"),
    textResult("submitted")
  );
  assert.equal(
    cache.get("submit_review", { body: "lgtm" }),
    null
  );
});

test("cache skips mutating tools by default without policy", () => {
  const cache = new CallCache(60);

  cache.set("create_issue", { title: "x" }, textResult("created"));
  cache.set("delete_issue", { id: 1 }, textResult("deleted"));
  cache.set("get_issue", { id: 1 }, textResult("issue"));

  assert.equal(cache.get("create_issue", { title: "x" }), null);
  assert.equal(cache.get("delete_issue", { id: 1 }), null);
  assert.deepEqual(cache.get("get_issue", { id: 1 }), textResult("issue"));
});

test("cache does not store error results", () => {
  const cache = new CallCache(60);

  cache.set("get_issue", { id: 1 }, {
    content: [{ type: "text", text: "not found" }],
    isError: true,
  });

  assert.equal(cache.get("get_issue", { id: 1 }), null);
  assert.equal(cache.size, 0);
});

test("cache wildcard matches qualified tool names across servers", () => {
  const cache = new CallCache(60, { allowTools: ["list_*"] });

  cache.set("github__list_issues", { page: 1 }, textResult("issues"), "github");

  assert.deepEqual(
    cache.get("github__list_issues", { page: 1 }, "github"),
    textResult("issues")
  );
});
