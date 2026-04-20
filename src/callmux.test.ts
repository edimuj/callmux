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
import { handleBatch, handleCacheClear, handleParallel, handlePipeline } from "./handlers.js";
import { CallmuxProxy } from "./proxy.js";
import { UpstreamManager } from "./upstream.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
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

  assert.deepEqual(config.servers.default.env, {
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
    "tsc --project tsconfig.test.json && node --test dist-test/**/*.test.js"
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
