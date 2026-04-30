import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
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
import { handleBatch, handleCall, handleCacheClear, handleDryRun, handleParallel, handlePipeline, handleStatus } from "./handlers.js";
import { CallmuxProxy } from "./proxy.js";
import { mapBounded, UpstreamManager } from "./upstream.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, StdioServerConfig } from "./types.js";
import { META_TOOLS } from "./meta-tools.js";
import { errorResult } from "./results.js";
import { formatCommandForDisplay, redactUrl } from "./redact.js";
import { hashBearerToken } from "./auth.js";
import { evaluateToolAuthorization } from "./authorization.js";

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

interface JwtKeyPair {
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  jwk: Record<string, unknown>;
}

function createJwtKeyPair(kid: string): JwtKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const exported = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    privateKey,
    jwk: {
      ...exported,
      kid,
      use: "sig",
      alg: "RS256",
    },
  };
}

function encodeBase64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function signJwtRs256(
  key: JwtKeyPair,
  payload: Record<string, unknown>
): string {
  const header = encodeBase64UrlJson({ alg: "RS256", typ: "JWT", kid: key.jwk.kid as string });
  const payloadSegment = encodeBase64UrlJson(payload);
  const signingInput = `${header}.${payloadSegment}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function createEs256JwtKeyPair(kid: string): JwtKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const exported = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    privateKey,
    jwk: {
      ...exported,
      kid,
      use: "sig",
      alg: "ES256",
    },
  };
}

function signJwtEs256(
  key: JwtKeyPair,
  payload: Record<string, unknown>
): string {
  const header = encodeBase64UrlJson({ alg: "ES256", typ: "JWT", kid: key.jwk.kid as string });
  const payloadSegment = encodeBase64UrlJson(payload);
  const signingInput = `${header}.${payloadSegment}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function startJwksServer(initialKeys: Record<string, unknown>[]): Promise<{
  url: string;
  setKeys: (keys: Record<string, unknown>[]) => void;
  getRequestCount: () => number;
  close: () => Promise<void>;
}> {
  let keys = initialKeys;
  let requestCount = 0;
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    requestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind JWKS test server");
  }

  return {
    url: `http://127.0.0.1:${address.port}/jwks`,
    setKeys(nextKeys: Record<string, unknown>[]) {
      keys = nextKeys;
    },
    getRequestCount() {
      return requestCount;
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function parseMcpResponseBody(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text
      .split("\n")
      .find((line: string) => line.startsWith("data: "));
    if (!dataLine) return undefined;
    return JSON.parse(dataLine.slice(6));
  }
  return res.json();
}

async function captureStderr<T>(
  fn: () => Promise<T>
): Promise<{ result: T; output: string }> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let output = "";

  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (
    chunk: unknown
  ) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
    return true;
  };

  try {
    const result = await fn();
    return { result, output };
  } finally {
    (process.stderr as unknown as { write: typeof process.stderr.write }).write =
      originalWrite;
  }
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

test("per-server concurrency limits qualified parallel tool calls without server hint", async () => {
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
        { tool: "fragile__a", arguments: {} },
        { tool: "fragile__b", arguments: {} },
        { tool: "fragile__c", arguments: {} },
      ],
    },
    10
  );

  assert.equal(maxConcurrent, 1);
});

test("per-server concurrency limits unique unqualified parallel tool calls", async () => {
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
    resolveServer(toolName: string) {
      return { client: {}, actualName: toolName, server: "fragile" };
    },
  };

  await handleParallel(
    upstream as never,
    new CallCache(0),
    {
      calls: [
        { tool: "a", arguments: {} },
        { tool: "b", arguments: {} },
        { tool: "c", arguments: {} },
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

test("batch respects per-server concurrency limit for qualified tool without server hint", async () => {
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
      return server === "limited" ? 2 : undefined;
    },
  };

  await handleBatch(
    upstream as never,
    new CallCache(0),
    {
      tool: "limited__process",
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

test("batch respects per-server concurrency limit for unique unqualified tool", async () => {
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
      return server === "limited" ? 2 : undefined;
    },
    resolveServer(toolName: string) {
      return { client: {}, actualName: toolName, server: "limited" };
    },
  };

  await handleBatch(
    upstream as never,
    new CallCache(0),
    {
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

test("configFromArgs parses request body limit flags", () => {
  const config = configFromArgs([
    "--request-body-max-bytes",
    "2097152",
    "--allow-request-body-override",
    "--",
    "node",
    "server.js",
  ]);

  assert.equal(config.requestBodyMaxBytes, 2_097_152);
  assert.equal(config.allowRequestBodyMaxOverride, true);
});

test("configFromArgs parses insecure remote listener override flag", () => {
  const config = configFromArgs([
    "--allow-insecure-remote-listener",
    "--",
    "node",
    "server.js",
  ]);
  assert.equal(config.allowInsecureRemoteListener, true);
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
    "--request-body-max-bytes",
    "2048",
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
    requestBodyMaxBytes: 2048,
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
    "--request-body-max-bytes",
    "4096",
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
    requestBodyMaxBytes: 4096,
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
      requestBodyMaxBytes: 1024,
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
      requestBodyMaxBytes: 2048,
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
    requestBodyMaxBytes: 2048,
  });
});

test("serializeServers redacts env values and preserves cache policy", () => {
  const config = createEmptyConfig();
  config.servers.github = {
    command: "npx",
    args: ["server.js"],
    env: { B_TOKEN: "b", A_TOKEN: "a" },
    cachePolicy: { allowTools: ["get_*"] },
    requestBodyMaxBytes: 2048,
  };

  assert.deepEqual(serializeServers(config), [
    {
      name: "github",
      command: "npx",
      args: ["server.js"],
      envKeys: ["A_TOKEN", "B_TOKEN"],
      cachePolicy: { allowTools: ["get_*"] },
      requestBodyMaxBytes: 2048,
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
    requestBodyMaxBytes: 2048,
  };

  const output = formatServerList(config);

  assert.match(output, /^github/m);
  assert.match(output, /command: npx -y @modelcontextprotocol\/server-github/);
  assert.match(output, /tools: get_issue/);
  assert.match(output, /env keys: GITHUB_TOKEN/);
  assert.match(output, /request body max bytes: 2048/);
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

test("runDoctor flags insecure plaintext auth tokens", async () => {
  const report = await runDoctor("/tmp/callmux.json", {
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "legacy-secret" }],
      },
    },
    format: "native",
  });

  assert.equal(report.ok, false);
  assert.match(report.issues[0], /plaintext token/);
});

test("runDoctor flags insecure oidc_jwt endpoints", async () => {
  const report = await runDoctor("/tmp/callmux.json", {
    config: {
      servers: {},
      auth: {
        mode: "oidc_jwt",
        issuer: "http://id.example.com",
        audience: "callmux",
        jwksUri: "http://id.example.com/jwks.json",
      },
    },
    format: "native",
  });

  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.includes("auth.issuer should use https://")));
  assert.ok(report.issues.some((issue) => issue.includes("auth.jwksUri should use https://")));
});

test("authorization policy supports deny-by-default with allow rule", () => {
  const decision = evaluateToolAuthorization(
    {
      defaultEffect: "deny",
      rules: [
        {
          id: "allow-github-read",
          effect: "allow",
          principals: ["bearer:ops"],
          tools: ["github__get_*"],
        },
      ],
    },
    { kind: "bearer", id: "ops", scopes: [], groups: [] },
    ["github__get_issue"]
  );

  assert.equal(decision.allowed, true);
});

test("authorization policy denies conflicting allow and deny rules", () => {
  const decision = evaluateToolAuthorization(
    {
      rules: [
        {
          id: "allow-all",
          effect: "allow",
          principals: ["bearer:ops"],
          tools: ["github__*"],
        },
        {
          id: "deny-secret",
          effect: "deny",
          principals: ["bearer:ops"],
          tools: ["github__get_secret"],
        },
      ],
    },
    { kind: "bearer", id: "ops", scopes: [], groups: [] },
    ["github__get_secret"]
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "authorization_ambiguous");
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

test("UpstreamManager connect resets prior clients and tool mappings", async () => {
  const upstream = new UpstreamManager();
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  let firstClosed = false;

  harness.connectOne = async (name: string, config: ServerConfig) => {
    const tool = mockTool(`${name}_tool`);
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult("ok");
        },
        async close() {
          if (name === "first") firstClosed = true;
        },
      },
      transport: { async close() {} },
      allTools: [tool],
      tools: [tool],
    };
  };

  await upstream.connect({ first: { command: "first" } });
  assert.deepEqual(upstream.getServerNames(), ["first"]);
  assert.equal(firstClosed, false);

  await upstream.connect({ second: { command: "second" } });
  assert.equal(firstClosed, true);
  assert.deepEqual(upstream.getServerNames(), ["second"]);

  const oldTool = await upstream.callTool("first_tool");
  assert.equal(oldTool.isError, true);
  assert.deepEqual(oldTool.structuredContent, {
    error: {
      code: "tool_not_found",
      message: 'tool "first_tool" not found',
      details: { tool: "first_tool" },
    },
  });
});

test("UpstreamManager reconnect rebuilds unqualified tool resolution index", async () => {
  const upstream = new UpstreamManager();
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    const toolName =
      "command" in config && config.command === "shared"
        ? "shared_tool"
        : `${name}_tool`;
    const tool = mockTool(toolName);
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult(`${name}:${toolName}`);
        },
        async close() {},
      },
      transport: { async close() {} },
      allTools: [tool],
      tools: [tool],
    };
  };

  await upstream.connect({
    alpha: { command: "shared" },
    beta: { command: "shared" },
  });

  const ambiguous = await upstream.callTool("shared_tool");
  assert.equal(ambiguous.isError, true);
  assert.deepEqual(ambiguous.structuredContent, {
    error: {
      code: "tool_resolution_failed",
      message:
        'tool "shared_tool" is ambiguous across multiple servers; specify "server" or use a qualified tool name',
    },
  });

  await upstream.connect({
    gamma: { command: "shared" },
  });

  const resolved = await upstream.callTool("shared_tool");
  assert.equal(resolved.isError, undefined);
  assert.deepEqual(resolved.content, [{ type: "text", text: "gamma:shared_tool" }]);
});

test("UpstreamManager call timeout returns a structured tool error", async () => {
  const upstream = new UpstreamManager(5) as unknown as {
    clients: Map<string, { callTool: (_params: unknown, _schema?: unknown, _options?: { timeout?: number }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };
  let observedTimeout: number | undefined;

  upstream.clients = new Map([
    [
      "github",
      {
        async callTool(_params: unknown, _schema?: unknown, options?: { timeout?: number }) {
          observedTimeout = options?.timeout;
          const timeout = options?.timeout ?? 1;
          await new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error(`timed out after ${timeout}ms`)), timeout)
          );
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

  assert.equal(observedTimeout, 5);
  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  assert.equal(structured.error.code, "tool_call_failed");
  assert.equal(structured.error.message, "timed out after 5ms");
  assert.equal(structured.error.details?.tool, "get_issue");
  assert.equal(structured.error.details?.category, "timeout");
  assert.equal(structured.error.details?.retryable, true);
  assert.match(String(structured.error.details?.rootCause ?? ""), /timed out after 5ms/i);
});

test("UpstreamManager normalizes noisy transport/protocol tool-call failures", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (_params: unknown, _schema?: unknown, _options?: { timeout?: number }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map([
    [
      "tokenlean",
      {
        async callTool() {
          throw new Error(
            "tool call error: tool call failed for `callmux/tokenlean__tl_advise` " +
            "Caused by: Transport send error: Transport " +
            "[rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker>] " +
            "error: Deserialize error: data did not match any variant of untagged enum JsonRpcMessage"
          );
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["tokenlean__tl_advise", { server: "tokenlean", tool: { name: "tl_advise" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["tokenlean", new Set(["tl_advise"])]]);

  const result = await upstream.callTool("tokenlean__tl_advise", { goal: "x" });
  const structured = result.structuredContent as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  assert.equal(result.isError, true);
  assert.equal(structured.error.code, "tool_call_failed");
  assert.match(structured.error.message, /downstream protocol error/i);
  assert.match(structured.error.message, /JsonRpcMessage/i);
  assert.equal(structured.error.details?.category, "protocol");
  assert.equal(structured.error.details?.retryable, true);
  assert.match(String(structured.error.details?.rootCause ?? ""), /JsonRpcMessage/i);
});

test("UpstreamManager classifies downstream authorization failures", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (_params: unknown, _schema?: unknown, _options?: { timeout?: number }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map([
    [
      "remote",
      {
        async callTool() {
          throw new Error("Transport send error: unauthorized (401) from downstream");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["read_secure_doc", { server: "remote", tool: { name: "read_secure_doc" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["remote", new Set(["read_secure_doc"])]]);

  const result = await upstream.callTool("read_secure_doc", {});
  const structured = result.structuredContent as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  assert.equal(result.isError, true);
  assert.equal(structured.error.code, "tool_call_failed");
  assert.match(structured.error.message, /downstream authorization error/i);
  assert.equal(structured.error.details?.category, "authorization");
  assert.equal(structured.error.details?.retryable, false);
});

test("UpstreamManager classifies downstream session failures as retryable", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (_params: unknown, _schema?: unknown, _options?: { timeout?: number }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map([
    [
      "remote",
      {
        async callTool() {
          throw new Error("unknown session: 6ba7b810-9dad-11d1-80b4-00c04fd430c8");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["resume", { server: "remote", tool: { name: "resume" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["remote", new Set(["resume"])]]);

  const result = await upstream.callTool("resume");
  const structured = result.structuredContent as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  assert.equal(result.isError, true);
  assert.equal(structured.error.code, "tool_call_failed");
  assert.match(structured.error.message, /downstream session error/i);
  assert.equal(structured.error.details?.category, "session");
  assert.equal(structured.error.details?.retryable, true);
});

test("UpstreamManager resolves $file references before forwarding tool arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-file-ref-ok-"));
  const bodyPath = join(dir, "body.md");
  await writeFile(bodyPath, "# Hello\n\nFrom file.\n", "utf8");

  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let capturedArguments: Record<string, unknown> | undefined;
  upstream.clients = new Map([
    [
      "github",
      {
        async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
          capturedArguments = params.arguments;
          return textResult("ok");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  try {
    const result = await upstream.callTool("create_issue", {
      title: "Issue title",
      body: { $file: bodyPath },
      nested: {
        template: { $file: bodyPath },
      },
    });

    assert.equal(result.isError, undefined);
    assert.equal(capturedArguments?.title, "Issue title");
    assert.equal(capturedArguments?.body, "# Hello\n\nFrom file.\n");
    assert.equal(
      (capturedArguments?.nested as { template: string }).template,
      "# Hello\n\nFrom file.\n"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UpstreamManager returns structured error when $file path is missing", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map([
    [
      "github",
      {
        async callTool() {
          return textResult("unexpected");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  const result = await upstream.callTool("create_issue", {
    body: { $file: "/tmp/definitely-does-not-exist-callmux.md" },
  });

  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    "argument_resolution_failed"
  );
  assert.match(
    (result.structuredContent as { error: { message: string } }).error.message,
    /ENOENT|no such file/i
  );
});

test("UpstreamManager enforces $file maxBytes with optional override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-file-ref-max-"));
  const bodyPath = join(dir, "big.md");
  await writeFile(bodyPath, "0123456789", "utf8");

  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let capturedArguments: Record<string, unknown> | undefined;
  upstream.clients = new Map([
    [
      "github",
      {
        async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
          capturedArguments = params.arguments;
          return textResult("ok");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  try {
    const tooSmall = await upstream.callTool("create_issue", {
      body: { $file: bodyPath, maxBytes: 4 },
    });
    assert.equal(tooSmall.isError, true);
    assert.equal(
      (tooSmall.structuredContent as { error: { code: string } }).error.code,
      "argument_resolution_failed"
    );
    assert.match(
      (tooSmall.structuredContent as { error: { message: string } }).error.message,
      /exceeds maxBytes/
    );

    const success = await upstream.callTool("create_issue", {
      body: { $file: bodyPath, maxBytes: 16 },
    });
    assert.equal(success.isError, undefined);
    assert.equal(capturedArguments?.body, "0123456789");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UpstreamManager resolves $text line composition with default newline join", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let capturedArguments: Record<string, unknown> | undefined;
  upstream.clients = new Map([
    [
      "github",
      {
        async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
          capturedArguments = params.arguments;
          return textResult("ok");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  const result = await upstream.callTool("create_issue", {
    title: "Inline text",
    body: {
      $text: {
        lines: ["## Summary", "", "- first", "- second"],
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(capturedArguments?.title, "Inline text");
  assert.equal(capturedArguments?.body, "## Summary\n\n- first\n- second");
});

test("UpstreamManager resolves $text line composition with custom join", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let capturedArguments: Record<string, unknown> | undefined;
  upstream.clients = new Map([
    [
      "github",
      {
        async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
          capturedArguments = params.arguments;
          return textResult("ok");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  const result = await upstream.callTool("create_issue", {
    body: {
      $text: {
        lines: ["a", "b", "c"],
        join: " | ",
      },
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(capturedArguments?.body, "a | b | c");
});

test("UpstreamManager validates $text reference shape and returns structured errors", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map([
    [
      "github",
      {
        async callTool() {
          return textResult("unexpected");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  const result = await upstream.callTool("create_issue", {
    body: {
      $text: {
        lines: ["ok", 42],
      },
    },
  });

  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    "argument_resolution_failed"
  );
  assert.match(
    (result.structuredContent as { error: { message: string } }).error.message,
    /\$text\.lines.*only strings/
  );
});

test("UpstreamManager resolves $jsonFile and $yamlFile references to structured arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-structured-file-ref-"));
  const jsonPath = join(dir, "payload.json");
  const yamlPath = join(dir, "payload.yaml");
  await writeFile(
    jsonPath,
    JSON.stringify({ labels: ["bug", "security"], metadata: { risk: "high" } }),
    "utf8"
  );
  await writeFile(
    yamlPath,
    "owner: ops\nreviewers:\n  - sec\n  - platform\n",
    "utf8"
  );

  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let capturedArguments: Record<string, unknown> | undefined;
  upstream.clients = new Map([
    [
      "github",
      {
        async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
          capturedArguments = params.arguments;
          return textResult("ok");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  try {
    const result = await upstream.callTool("create_issue", {
      title: "Structured refs",
      body: { $text: { lines: ["hello", "world"] } },
      metadata: { $jsonFile: jsonPath },
      routing: { $yamlFile: yamlPath },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(capturedArguments?.metadata, {
      labels: ["bug", "security"],
      metadata: { risk: "high" },
    });
    assert.deepEqual(capturedArguments?.routing, {
      owner: "ops",
      reviewers: ["sec", "platform"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UpstreamManager reports argument resolution errors for invalid $jsonFile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-json-file-ref-invalid-"));
  const jsonPath = join(dir, "broken.json");
  await writeFile(jsonPath, "{ invalid json", "utf8");

  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (_params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.clients = new Map([
    [
      "github",
      {
        async callTool() {
          return textResult("unexpected");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  try {
    const result = await upstream.callTool("create_issue", {
      metadata: { $jsonFile: jsonPath },
    });
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { error: { code: string } }).error.code,
      "argument_resolution_failed"
    );
    assert.match(
      (result.structuredContent as { error: { message: string } }).error.message,
      /failed to parse \$jsonFile/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("fake MCP fixture can return downstream tool errors without transport failure", async () => {
  const upstream = new UpstreamManager();

  try {
    const connections = await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([{ name: "get_item" }]),
        FAKE_MCP_CALL_MODE: "tool_error",
        FAKE_MCP_TOOL_ERROR_MESSAGE: "downstream tool validation failed",
      }),
    });

    assert.equal(connections.length, 1);
    const result = await upstream.callTool("get_item", { id: 1 });
    assert.equal(result.isError, true);
    assert.equal(
      (result.content[0] as { text: string }).text,
      "downstream tool validation failed"
    );
  } finally {
    await upstream.close();
  }
});

test("fake MCP fixture surfaces thrown downstream exceptions as structured callmux errors", async () => {
  const upstream = new UpstreamManager();

  try {
    const connections = await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([{ name: "get_item" }]),
        FAKE_MCP_CALL_MODE: "throw",
      }),
    });

    assert.equal(connections.length, 1);
    const result = await upstream.callTool("get_item", { id: 1 });
    assert.equal(result.isError, true);
    if (result.structuredContent) {
      assert.equal(
        (result.structuredContent as {
          error: { code: string; details?: { tool?: string } };
        }).error.code,
        "tool_call_failed"
      );
      assert.equal(
        (result.structuredContent as {
          error: { code: string; details?: { tool?: string } };
        }).error.details?.tool,
        "get_item"
      );
      assert.match(
        ((result.structuredContent as {
          error: { message: string };
        }).error.message),
        /fake callTool failure/
      );
    } else {
      assert.match((result.content[0] as { text: string }).text, /fake callTool failure/);
    }
  } finally {
    await upstream.close();
  }
});

test("fake MCP fixture hanging calls are converted into timeout errors", async () => {
  const upstream = new UpstreamManager(25);

  try {
    const connections = await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([{ name: "get_item" }]),
        FAKE_MCP_CALL_MODE: "hang",
      }),
    });

    assert.equal(connections.length, 1);
    const result = await upstream.callTool("get_item", { id: 1 });
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { error: { code: string } }).error.code,
      "tool_call_failed"
    );
    assert.match(
      ((result.structuredContent as { error: { message: string } }).error.message),
      /timed out/i
    );
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
    resolveServer: (toolName: string, serverHint?: string) => { client: unknown; actualName: string; server: string } | { error: CallToolResult } | null;
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

test("handleDryRun previews resolved calls and cache-hit candidates", async () => {
  const cache = new CallCache(60);
  cache.set("github__get_issue", { id: 1 }, textResult("cached"), "github");

  const upstream = {
    async prepareToolCall(
      tool: string,
      args?: Record<string, unknown>,
      server?: string
    ) {
      if (tool === "missing_tool") {
        return {
          error: errorResult("tool_not_found", 'tool "missing_tool" not found', {
            tool,
          }),
        };
      }
      return {
        toolName: tool,
        server: server ?? "github",
        actualName: tool.startsWith("github__") ? tool.slice("github__".length) : tool,
        resolvedArguments: args,
      };
    },
  };

  const result = await handleDryRun(upstream as never, cache, {
    mode: "parallel",
    calls: [
      { tool: "github__get_issue", server: "github", arguments: { id: 1 } },
      { tool: "missing_tool", arguments: { title: "B" } },
    ],
  });

  assert.equal(result.isError, undefined);
  const content = result.structuredContent as {
    mode: string;
    valid: boolean;
    items: Array<{ resolved?: { qualifiedTool: string }; cacheHitCandidate?: boolean; error?: { code: string } }>;
    summary: { totalCalls: number; validCalls: number; invalidCalls: number; cacheHitCandidates: number };
  };
  assert.equal(content.mode, "parallel");
  assert.equal(content.valid, false);
  assert.equal(content.summary.totalCalls, 2);
  assert.equal(content.summary.validCalls, 1);
  assert.equal(content.summary.invalidCalls, 1);
  assert.equal(content.summary.cacheHitCandidates, 1);
  assert.equal(content.items[0].resolved?.qualifiedTool, "github__get_issue");
  assert.equal(content.items[0].cacheHitCandidate, true);
  assert.equal(content.items[1].error?.code, "tool_not_found");
});

test("handleDryRun validates mode and shape", async () => {
  const result = await handleDryRun({} as never, new CallCache(0), {
    mode: "invalid",
  });

  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    "invalid_arguments"
  );
  assert.match(
    (result.structuredContent as { error: { message: string } }).error.message,
    /mode/
  );
});

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

const TEST_INSTANCE_IDENTITY = { instanceId: "test-instance" };

test("handleStatus includes mode field", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);
  const cache = new CallCache(0);

  const standard = handleStatus(
    upstream as never,
    cache,
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {}
  );
  assert.equal(
    (standard.structuredContent as { mode: string }).mode,
    "standard"
  );

  const metaOnly = handleStatus(
    upstream as never,
    cache,
    20,
    true,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {}
  );
  assert.equal(
    (metaOnly.structuredContent as { mode: string }).mode,
    "meta-only"
  );
  const standardContent = standard.structuredContent as {
    instanceId: string;
    wrappedServers: string[];
  };
  assert.equal(standardContent.instanceId, "test-instance");
  assert.deepEqual(standardContent.wrappedServers, ["github"]);
});

test("handleStatus includes optional namespace when provided", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    { namespace: "mcp__project_callmux__", instanceId: "project-1" },
    {}
  );
  const content = result.structuredContent as {
    namespace: string;
    instanceId: string;
  };
  assert.equal(content.namespace, "mcp__project_callmux__");
  assert.equal(content.instanceId, "project-1");
});

test("handleStatus returns descriptions when requested", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue by number") },
    { server: "github", tool: mockTool("list_issues", "List issues in a repository") },
  ]);

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {
      descriptions: true,
    }
  );

  const content = result.structuredContent as {
    servers: Array<{
      tools: Array<{ name: string; description: string }>;
    }>;
  };

  assert.equal(content.servers[0].tools[0].name, "get_issue");
  assert.equal(content.servers[0].tools[0].description, "Get a specific issue by number");
});

test("handleStatus includes recommendations by default", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
    { server: "linear", tool: mockTool("get_issue") },
  ]);

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    true,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {}
  );

  const content = result.structuredContent as {
    recommendations?: Array<{ when: string; use: string; note: string }>;
  };
  assert.ok(Array.isArray(content.recommendations));
  assert.ok(content.recommendations!.some((r) => r.use === "callmux_parallel"));
  assert.ok(content.recommendations!.some((r) => r.use === "callmux_batch"));
  assert.ok(content.recommendations!.some((r) => r.use === "callmux_pipeline"));
  assert.ok(content.recommendations!.some((r) => r.use === "callmux_dry_run"));
  assert.ok(content.recommendations!.some((r) => r.use === "callmux_call"));
  assert.ok(
    content.recommendations!.some((r) => r.use === "server hint or qualified tool names")
  );
});

test("handleStatus can disable recommendations", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    { recommendations: false }
  );

  const content = result.structuredContent as {
    recommendations?: Array<{ when: string; use: string; note: string }>;
  };
  assert.equal(content.recommendations, undefined);
});

test("handleStatus truncates descriptions to maxLength", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue by number from the repository") },
  ]);

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {
      descriptions: true,
      descriptionMaxLength: 20,
    }
  );

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

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    15,
    TEST_INSTANCE_IDENTITY,
    {
      descriptions: true,
    }
  );

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

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    15,
    TEST_INSTANCE_IDENTITY,
    {
      descriptions: true,
      descriptionMaxLength: 30,
    }
  );

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

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {}
  );
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

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {}
  );
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

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {}
  );

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

  const result = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    {}
  );
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
  assert.equal(META_TOOLS.length, 7);
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

test("loadConfig parses request body limits from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-body-limit-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"], requestBodyMaxBytes: 4096 },
          linear: { command: "node", args: ["server2.js"] },
        },
        requestBodyMaxBytes: 8192,
        allowRequestBodyMaxOverride: true,
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.requestBodyMaxBytes, 8192);
    assert.equal(config.allowRequestBodyMaxOverride, true);
    assert.equal((config.servers.github as StdioServerConfig).requestBodyMaxBytes, 4096);
    assert.equal((config.servers.linear as StdioServerConfig).requestBodyMaxBytes, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses bearer auth config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-"));
  const configPath = join(dir, "config.json");
  const hash = hashBearerToken("secret-token");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [{ id: "dev", hash }],
          allowUnauthenticatedHealth: true,
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.auth, {
      mode: "bearer",
      tokens: [{ id: "dev", hash }],
      allowUnauthenticatedHealth: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses legacy plaintext bearer auth config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-legacy-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [{ id: "dev", token: "secret-token" }],
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.auth, {
      mode: "bearer",
      tokens: [{ id: "dev", token: "secret-token" }],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig resolves bearer auth hashRef from env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-hashref-env-"));
  const configPath = join(dir, "config.json");
  const hash = hashBearerToken("hashref-secret");
  const previous = process.env.CALLMUX_TEST_HASHREF;
  process.env.CALLMUX_TEST_HASHREF = hash;

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [{ id: "dev", hashRef: "env:CALLMUX_TEST_HASHREF" }],
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.auth, {
      mode: "bearer",
      tokens: [{ id: "dev", hash }],
    });
  } finally {
    if (previous === undefined) delete process.env.CALLMUX_TEST_HASHREF;
    else process.env.CALLMUX_TEST_HASHREF = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig resolves bearer auth tokenRef file relative to config and converts to hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-tokenref-file-"));
  const configPath = join(dir, "config.json");
  const tokenFile = join(dir, "ops.token");

  try {
    await writeFile(tokenFile, "tokenref-secret\n", { encoding: "utf-8" });
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [{ id: "ops", tokenRef: "file:./ops.token" }],
        },
      })
    );

    const config = await loadConfig(configPath);
    const parsedAuth = config.auth as { mode: string; tokens: Array<{ id: string; hash?: string; token?: string }> };
    assert.equal(parsedAuth.mode, "bearer");
    assert.equal(parsedAuth.tokens.length, 1);
    assert.equal(parsedAuth.tokens[0].id, "ops");
    assert.equal(typeof parsedAuth.tokens[0].hash, "string");
    assert.equal(parsedAuth.tokens[0].token, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unsupported bearer secret ref scheme", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-ref-invalid-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [{ id: "ops", hashRef: "vault:secret/path" }],
        },
      })
    );

    await assert.rejects(
      loadConfig(configPath),
      /must use supported secret refs: env:<NAME> or file:<PATH>/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects bearer env ref when variable is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-ref-missing-env-"));
  const configPath = join(dir, "config.json");
  const previous = process.env.CALLMUX_TEST_MISSING_REF;
  delete process.env.CALLMUX_TEST_MISSING_REF;

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [{ id: "ops", hashRef: "env:CALLMUX_TEST_MISSING_REF" }],
        },
      })
    );

    await assert.rejects(
      loadConfig(configPath),
      /references missing or empty environment variable/
    );
  } finally {
    if (previous !== undefined) process.env.CALLMUX_TEST_MISSING_REF = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses oidc_jwt auth config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-oidc-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "oidc_jwt",
          issuer: "https://id.example.com",
          audience: ["callmux", "agents"],
          jwksUri: "https://id.example.com/jwks.json",
          algorithms: ["RS256"],
          clockSkewSeconds: 45,
          jwksCacheTtlSeconds: 120,
          jwksFetchTimeoutMs: 3500,
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.auth, {
      mode: "oidc_jwt",
      issuer: "https://id.example.com",
      audience: ["callmux", "agents"],
      jwksUri: "https://id.example.com/jwks.json",
      algorithms: ["RS256"],
      clockSkewSeconds: 45,
      jwksCacheTtlSeconds: 120,
      jwksFetchTimeoutMs: 3500,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses authorization policy config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-authz-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        authorization: {
          defaultEffect: "deny",
          rules: [
            {
              id: "ops-all",
              effect: "allow",
              principals: ["bearer:ops"],
              tools: ["*"],
            },
          ],
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.authorization, {
      defaultEffect: "deny",
      rules: [
        {
          id: "ops-all",
          effect: "allow",
          principals: ["bearer:ops"],
          tools: ["*"],
        },
      ],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses abuse controls config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-abuse-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        abuseControls: {
          globalRequestsPerMinute: 1000,
          principalRequestsPerMinute: 100,
          principalMaxInFlight: 10,
          cidrAllowlist: ["127.0.0.1/32", "::1/128"],
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.abuseControls, {
      globalRequestsPerMinute: 1000,
      principalRequestsPerMinute: 100,
      principalMaxInFlight: 10,
      cidrAllowlist: ["127.0.0.1/32", "::1/128"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses audit and metrics config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-observability-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auditLog: {
          enabled: true,
          includeRequestBody: true,
          maxPayloadChars: 2048,
          redactKeys: ["session_token"],
        },
        metrics: {
          enabled: true,
          path: "prom-metrics",
          allowUnauthenticated: true,
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(config.auditLog, {
      enabled: true,
      includeRequestBody: true,
      maxPayloadChars: 2048,
      redactKeys: ["session_token"],
    });
    assert.deepEqual(config.metrics, {
      enabled: true,
      path: "/prom-metrics",
      allowUnauthenticated: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid bearer auth config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-invalid-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [],
        },
      })
    );

    await assert.rejects(loadConfig(configPath), /auth\.tokens must contain at least one token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects oidc_jwt auth with unsupported algorithms", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-oidc-invalid-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "oidc_jwt",
          issuer: "https://id.example.com",
          audience: "callmux",
          jwksUri: "https://id.example.com/jwks.json",
          algorithms: ["HS256"],
        },
      })
    );

    await assert.rejects(
      loadConfig(configPath),
      /auth\.algorithms must contain only RS256, RS384, RS512, ES256, ES384, or ES512/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects authorization policy with empty rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-authz-invalid-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        authorization: {
          rules: [],
        },
      })
    );

    await assert.rejects(
      loadConfig(configPath),
      /authorization\.rules must contain at least one rule/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects abuse controls with invalid CIDR entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-abuse-invalid-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        abuseControls: {
          cidrAllowlist: ["not-a-cidr"],
        },
      })
    );

    await assert.rejects(
      loadConfig(configPath),
      /abuseControls\.cidrAllowlist entries must be valid CIDR or IP values/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid metrics path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-metrics-invalid-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        metrics: {
          path: "",
        },
      })
    );

    await assert.rejects(
      loadConfig(configPath),
      /metrics\.path must be a non-empty string/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects bearer auth tokens with both hash and token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-auth-invalid-both-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: { command: "node", args: ["server.js"] },
        },
        auth: {
          mode: "bearer",
          tokens: [{ id: "dev", hash: hashBearerToken("secret"), token: "secret" }],
        },
      })
    );

    await assert.rejects(
      loadConfig(configPath),
      /must include exactly one of "hash", "hashRef", "token", or "tokenRef"/
    );
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
  const error = (result.structuredContent as {
    error: {
      message: string;
      details: {
        availableServers: string[];
        instanceId: string;
      };
    };
  }).error;
  assert.match(error.message, /not found in this callmux instance/);
  assert.deepEqual(error.details.availableServers, ["github"]);
  assert.equal(error.details.instanceId, "unknown");
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

test("proxy routes callmux_dry_run to handleDryRun", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  (proxy as unknown as {
    upstream: {
      prepareToolCall: (
        tool: string,
        args?: Record<string, unknown>,
        serverHint?: string
      ) => Promise<{ toolName: string; server: string; actualName: string; resolvedArguments?: Record<string, unknown> }>;
    }
  }).upstream = {
    async prepareToolCall(tool: string, args?: Record<string, unknown>, serverHint?: string) {
      return {
        toolName: tool,
        server: serverHint ?? "default",
        actualName: tool,
        resolvedArguments: args,
      };
    },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_dry_run", {
    tool: "get_issue",
    arguments: { id: 1 },
  });

  const content = result.structuredContent as {
    mode: string;
    summary: { totalCalls: number };
  };
  assert.equal(content.mode, "call");
  assert.equal(content.summary.totalCalls, 1);
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
  const content = result.structuredContent as {
    status: string;
    mode: string;
    instanceId: string;
  };
  assert.equal(content.status, "ok");
  assert.equal(content.mode, "standard");
  assert.equal(typeof content.instanceId, "string");
  assert.ok(content.instanceId.length > 0);
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

// ── Result unwrapping ─────────────────────────────────────────────

test("batch unwraps JSON content from upstream results", async () => {
  const upstream = {
    async callTool() {
      return textResult(JSON.stringify({ nodes: ["a", "b"], count: 2 }));
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "ms_list",
    items: [{ arguments: { story: "test" } }],
  }, 4);

  const content = result.structuredContent as {
    results: Array<{ index: number; result: { nodes: string[]; count: number } }>;
  };
  assert.deepEqual(content.results[0].result, { nodes: ["a", "b"], count: 2 });
});

test("parallel unwraps JSON content from upstream results", async () => {
  const upstream = {
    async callTool() {
      return textResult(JSON.stringify({ id: 42, name: "test" }));
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleParallel(upstream as never, new CallCache(0), {
    calls: [{ tool: "ms_get", arguments: { nodeId: "ch1_001" } }],
  }, 4);

  const content = result.structuredContent as {
    results: Array<{ result: { id: number; name: string } }>;
  };
  assert.deepEqual(content.results[0].result, { id: 42, name: "test" });
});

test("pipeline unwraps JSON content in steps and finalResult", async () => {
  const upstream = {
    async callTool() {
      return textResult(JSON.stringify({ value: "done" }));
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [{ tool: "ms_get", arguments: { nodeId: "ch1_001" } }],
  });

  const content = result.structuredContent as {
    steps: Array<{ result: { value: string } }>;
    finalResult: { value: string };
  };
  assert.deepEqual(content.steps[0].result, { value: "done" });
  assert.deepEqual(content.finalResult, { value: "done" });
});

test("unwrap keeps plain text when content is not JSON", async () => {
  const upstream = {
    async callTool() {
      return textResult("not json");
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "echo",
    items: [{ arguments: {} }],
  }, 4);

  const content = result.structuredContent as {
    results: Array<{ result: string }>;
  };
  assert.equal(content.results[0].result, "not json");
});

test("unwrap preserves error info from upstream", async () => {
  const upstream = {
    async callTool() {
      return { content: [{ type: "text" as const, text: "something broke" }], isError: true };
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "fail",
    items: [{ arguments: {} }],
  }, 4);

  const content = result.structuredContent as {
    results: Array<{ result: { error: string; isError: boolean } }>;
    failed: number;
  };
  assert.equal(content.failed, 1);
  assert.deepEqual(content.results[0].result, { error: "something broke", isError: true });
});

// ─── Listener tests ─────────────────────────────────────────────

import { CallmuxListener } from "./listener.js";

test("listener applyRuntimeConfig updates runtime security settings", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const tools: Tool[] = [{ name: "test_tool", description: "A test", inputSchema: { type: "object", properties: {} } }];
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {}, requestBodyMaxBytes: 1024 },
    upstream,
    cache,
    allTools: tools,
    maxConcurrency: 10,
  });

  listener.applyRuntimeConfig({
    servers: {},
    requestBodyMaxBytes: 2048,
    allowRequestBodyMaxOverride: true,
    auth: {
      mode: "bearer",
      tokens: [{ id: "ops", hash: hashBearerToken("ops-secret") }],
    },
    metrics: {
      enabled: true,
      path: "/metrics-secure",
      allowUnauthenticated: false,
    },
  });

  const internals = listener as unknown as {
    authConfig: { mode: string } | undefined;
    globalRequestBodyMaxBytes: number;
    allowRequestBodyMaxOverride: boolean;
    metrics: { getPath: () => string };
  };
  assert.equal(internals.authConfig?.mode, "bearer");
  assert.equal(internals.globalRequestBodyMaxBytes, 2048);
  assert.equal(internals.allowRequestBodyMaxOverride, true);
  assert.equal(internals.metrics.getPath(), "/metrics-secure");
});

test("listener applyRuntimeConfig rejects insecure remote runtime config", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const tools: Tool[] = [{ name: "test_tool", description: "A test", inputSchema: { type: "object", properties: {} } }];
  const listener = new CallmuxListener({
    port: 0,
    host: "0.0.0.0",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", hash: hashBearerToken("ops-secret") }],
      },
    },
    upstream,
    cache,
    allTools: tools,
    maxConcurrency: 10,
  });

  assert.throws(
    () =>
      listener.applyRuntimeConfig({
        servers: {},
      }),
    /Refusing insecure remote listener/
  );
});

test("listener /health returns ok with session count", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const tools: Tool[] = [{ name: "test_tool", description: "A test", inputSchema: { type: "object", properties: {} } }];

  const listener = new CallmuxListener({
    port: 0, // will bind to any free port — override below
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: tools,
    maxConcurrency: 10,
  });

  // Use a random port
  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.sessions, 0);
  } finally {
    await listener.close();
  }
});

test("listener requires bearer auth for /health by default when auth is configured", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "top-secret" }],
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: "Bearer top-secret" },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json();
    assert.equal(body.status, "ok");
  } finally {
    await listener.close();
  }
});

test("listener accepts hashed bearer auth tokens", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", hash: hashBearerToken("top-secret") }],
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: "Bearer top-secret" },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await listener.close();
  }
});

test("listener accepts valid oidc_jwt bearer tokens", async () => {
  const issuer = "https://issuer.example.test";
  const audience = "callmux";
  const key = createJwtKeyPair("kid-1");
  const jwks = await startJwksServer([key.jwk]);
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "oidc_jwt",
        issuer,
        audience,
        jwksUri: jwks.url,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = signJwtRs256(key, {
    sub: "user-1",
    iss: issuer,
    aud: audience,
    exp: nowSeconds + 300,
    nbf: nowSeconds - 30,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await listener.close();
    await jwks.close();
  }
});

test("listener accepts valid ES256 oidc_jwt bearer tokens", async () => {
  const issuer = "https://issuer.example.test";
  const audience = "callmux";
  const key = createEs256JwtKeyPair("kid-es-1");
  const jwks = await startJwksServer([key.jwk]);
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "oidc_jwt",
        issuer,
        audience,
        jwksUri: jwks.url,
        algorithms: ["ES256"],
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = signJwtEs256(key, {
    sub: "user-es-1",
    iss: issuer,
    aud: audience,
    exp: nowSeconds + 300,
    nbf: nowSeconds - 30,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const authorized = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await listener.close();
    await jwks.close();
  }
});

test("listener rejects oidc_jwt token with invalid signature", async () => {
  const issuer = "https://issuer.example.test";
  const audience = "callmux";
  const trusted = createJwtKeyPair("kid-1");
  const untrusted = createJwtKeyPair("kid-1");
  const jwks = await startJwksServer([trusted.jwk]);
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "oidc_jwt",
        issuer,
        audience,
        jwksUri: jwks.url,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const badToken = signJwtRs256(untrusted, {
    sub: "user-2",
    iss: issuer,
    aud: audience,
    exp: nowSeconds + 300,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${badToken}` },
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await listener.close();
    await jwks.close();
  }
});

test("listener rejects expired oidc_jwt token", async () => {
  const issuer = "https://issuer.example.test";
  const audience = "callmux";
  const key = createJwtKeyPair("kid-1");
  const jwks = await startJwksServer([key.jwk]);
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "oidc_jwt",
        issuer,
        audience,
        jwksUri: jwks.url,
        clockSkewSeconds: 0,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredToken = signJwtRs256(key, {
    sub: "user-3",
    iss: issuer,
    aud: audience,
    exp: nowSeconds - 5,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await listener.close();
    await jwks.close();
  }
});

test("listener refreshes JWKS on kid rotation for oidc_jwt tokens", async () => {
  const issuer = "https://issuer.example.test";
  const audience = "callmux";
  const keyOne = createJwtKeyPair("kid-old");
  const keyTwo = createJwtKeyPair("kid-new");
  const jwks = await startJwksServer([keyOne.jwk]);
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "oidc_jwt",
        issuer,
        audience,
        jwksUri: jwks.url,
        jwksCacheTtlSeconds: 3600,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const tokenOne = signJwtRs256(keyOne, {
    sub: "user-4",
    iss: issuer,
    aud: audience,
    exp: nowSeconds + 300,
  });
  const tokenTwo = signJwtRs256(keyTwo, {
    sub: "user-4",
    iss: issuer,
    aud: audience,
    exp: nowSeconds + 300,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const first = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${tokenOne}` },
    });
    assert.equal(first.status, 200);

    jwks.setKeys([keyTwo.jwk]);

    const second = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${tokenTwo}` },
    });
    assert.equal(second.status, 200);
  } finally {
    await listener.close();
    await jwks.close();
  }
});

test("listener throttles forced JWKS refreshes on repeated unknown kid misses", async () => {
  const issuer = "https://issuer.example.test";
  const audience = "callmux";
  const trusted = createJwtKeyPair("kid-trusted");
  const unknown = createJwtKeyPair("kid-unknown");
  const jwks = await startJwksServer([trusted.jwk]);
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "oidc_jwt",
        issuer,
        audience,
        jwksUri: jwks.url,
        jwksCacheTtlSeconds: 3600,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const badToken = signJwtRs256(unknown, {
    sub: "user-unknown",
    iss: issuer,
    aud: audience,
    exp: nowSeconds + 300,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const first = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${badToken}` },
    });
    assert.equal(first.status, 401);

    const second = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${badToken}` },
    });
    assert.equal(second.status, 401);

    const jwksRequests = jwks.getRequestCount();
    assert.ok(jwksRequests <= 2, `expected <= 2 JWKS fetches, got ${jwksRequests}`);
  } finally {
    await listener.close();
    await jwks.close();
  }
});

test("listener allows unauthenticated /health when configured", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "top-secret" }],
        allowUnauthenticatedHealth: true,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  } finally {
    await listener.close();
  }
});

test("listener /mcp returns 400 for non-initialize request without session", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as {
      error?: { message?: string };
      id?: unknown;
    };
    assert.equal(body.id, 1);
    assert.equal(
      body.error?.message,
      "Bad Request: No valid session. Send initialize first, then include MCP-Session-Id."
    );
  } finally {
    await listener.close();
  }
});

test("listener /mcp returns JSON-RPC parse error for invalid JSON", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: "{ invalid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as {
      error?: { code?: number; message?: string };
      id?: unknown;
    };
    assert.equal(body.error?.code, -32700);
    assert.equal(body.error?.message, "Parse error");
    assert.equal(body.id, null);
  } finally {
    await listener.close();
  }
});

test("listener requires bearer auth for /mcp", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "top-secret" }],
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: "Bearer top-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(authorized.status, 400);
  } finally {
    await listener.close();
  }
});

test("listener enforces authorization policy for direct and meta-routed tool calls", async () => {
  const upstream = new UpstreamManager() as unknown as {
    resolveServer: (toolName: string, serverHint?: string) => { client: unknown; actualName: string; server: string } | null;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  upstream.resolveServer = (toolName: string, serverHint?: string) => {
    if (serverHint === "github" || toolName === "github__get_issue" || toolName === "get_issue") {
      return { client: {}, actualName: "get_issue", server: "github" };
    }
    return null;
  };
  upstream.callTool = async (toolName: string) => textResult(`ok:${toolName}`);

  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [
          { id: "ops", token: "ops-secret" },
          { id: "viewer", token: "viewer-secret" },
        ],
      },
      authorization: {
        defaultEffect: "deny",
        rules: [
          {
            id: "ops-read",
            effect: "allow",
            principals: ["bearer:ops"],
            tools: ["github__get_*"],
          },
        ],
      },
    },
    upstream: upstream as unknown as UpstreamManager,
    cache,
    allTools: [{ name: "github__get_issue", description: "test", inputSchema: { type: "object", properties: {} } }],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const mcpHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      Authorization: "Bearer viewer-secret",
    };

    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        id: 1,
      }),
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const deniedDirect = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "github__get_issue",
          arguments: { number: 1 },
        },
        id: 2,
      }),
    });
    assert.equal(deniedDirect.status, 200);
    const deniedDirectBody = await parseMcpResponseBody(deniedDirect);
    assert.equal(deniedDirectBody.result.isError, true);
    assert.equal(
      deniedDirectBody.result.structuredContent.error.code,
      "authorization_denied"
    );
    assert.equal(
      deniedDirectBody.result.structuredContent.error.details.code,
      "authorization_default_deny"
    );

    const deniedMeta = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "callmux_call",
          arguments: { tool: "github__get_issue", arguments: { number: 1 } },
        },
        id: 3,
      }),
    });
    assert.equal(deniedMeta.status, 200);
    const deniedMetaBody = await parseMcpResponseBody(deniedMeta);
    assert.equal(deniedMetaBody.result.isError, true);
    assert.equal(
      deniedMetaBody.result.structuredContent.error.code,
      "authorization_denied"
    );

    const allowedDirect = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        ...mcpHeaders,
        "mcp-session-id": sessionId,
        Authorization: "Bearer ops-secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "github__get_issue",
          arguments: { number: 1 },
        },
        id: 4,
      }),
    });
    assert.equal(allowedDirect.status, 200);
    const allowedDirectBody = await parseMcpResponseBody(allowedDirect);
    assert.equal(allowedDirectBody.result.isError, undefined);
  } finally {
    await listener.close();
  }
});

test("listener includes request IDs in error responses and headers", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "ops-secret" }],
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;
  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-request-id": "req-unauthorized-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("x-request-id"), "req-unauthorized-1");
    const unauthorizedBody = await unauthorized.json();
    assert.equal(unauthorizedBody.requestId, "req-unauthorized-1");

    const badSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: "Bearer ops-secret",
        "x-request-id": "req-bad-session-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    assert.equal(badSession.status, 400);
    assert.equal(badSession.headers.get("x-request-id"), "req-bad-session-1");
    const badSessionBody = await badSession.json() as {
      error: { data: { requestId: string }; message: string };
      id: unknown;
    };
    assert.equal(badSessionBody.error.data.requestId, "req-bad-session-1");
    assert.equal(badSessionBody.id, 2);
    assert.equal(
      badSessionBody.error.message,
      "Bad Request: No valid session. Send initialize first, then include MCP-Session-Id."
    );
  } finally {
    await listener.close();
  }
});

test("listener serves prometheus metrics endpoint and tracks request counters", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      metrics: {
        enabled: true,
        path: "/metrics",
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;
  await listener.start();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(metrics.status, 200);
    assert.ok(
      (metrics.headers.get("content-type") ?? "").includes("text/plain")
    );
    const body = await metrics.text();
    assert.match(body, /callmux_http_requests_total/);
    assert.match(body, /path="\/health"/);
    assert.match(body, /callmux_http_inflight_requests/);
  } finally {
    await listener.close();
  }
});

test("listener can require auth for metrics endpoint", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "ops-secret" }],
      },
      metrics: {
        enabled: true,
        path: "/metrics",
        allowUnauthenticated: false,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;
  await listener.start();
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: "Bearer ops-secret" },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await listener.close();
  }
});

test("listener audit log redacts sensitive payload fields", async () => {
  const { output } = await captureStderr(async () => {
    const upstream = new UpstreamManager();
    const cache = new CallCache(0, undefined, {}, 100);
    const listener = new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      config: {
        servers: {},
        auditLog: {
          enabled: true,
          includeRequestBody: true,
          maxPayloadChars: 4096,
        },
      },
      upstream,
      cache,
      allTools: [],
      maxConcurrency: 10,
    });

    const port = 30000 + Math.floor(Math.random() * 20000);
    (listener as any).options.port = port;
    await listener.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "callmux_call",
            arguments: {
              tool: "github__get_issue",
              arguments: {
                token: "super-secret-token",
                nested: { api_key: "secret-value" },
              },
            },
          },
          id: 1,
        }),
      });
      assert.equal(res.status, 400);
    } finally {
      await listener.close();
    }
  });

  const auditLines = output
    .split("\n")
    .filter((line) => line.includes("\"event\":\"http_request\""));
  assert.ok(auditLines.length > 0, "expected at least one audit request line");
  const parsed = JSON.parse(auditLines[auditLines.length - 1]);
  const serialized = JSON.stringify(parsed);
  assert.ok(serialized.includes("[redacted]"));
  assert.ok(!serialized.includes("super-secret-token"));
  assert.ok(!serialized.includes("secret-value"));
});

test("listener enforces global abuse rate limit", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      abuseControls: {
        globalRequestsPerMinute: 1,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(first.status, 400);

    const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "60");
  } finally {
    await listener.close();
  }
});

test("listener applies global abuse rate limits before authentication work", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "ops-secret" }],
      },
      abuseControls: {
        globalRequestsPerMinute: 1,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: "Bearer definitely-invalid-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(first.status, 401);

    const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        Authorization: "Bearer definitely-invalid-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    assert.equal(second.status, 429);
  } finally {
    await listener.close();
  }
});

test("listener enforces principal abuse rate limit independently per principal", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [
          { id: "ops", token: "ops-secret" },
          { id: "viewer", token: "viewer-secret" },
        ],
      },
      abuseControls: {
        principalRequestsPerMinute: 1,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const request = (token: string, id: number) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id }),
      });

    const firstOps = await request("ops-secret", 1);
    assert.equal(firstOps.status, 400);

    const secondOps = await request("ops-secret", 2);
    assert.equal(secondOps.status, 429);

    const viewer = await request("viewer-secret", 3);
    assert.equal(viewer.status, 400);
  } finally {
    await listener.close();
  }
});

test("listener enforces source IP CIDR allowlist", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const deniedListener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      abuseControls: {
        cidrAllowlist: ["10.0.0.0/8"],
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const deniedPort = 30000 + Math.floor(Math.random() * 20000);
  (deniedListener as any).options.port = deniedPort;
  await deniedListener.start();
  try {
    const denied = await fetch(`http://127.0.0.1:${deniedPort}/health`);
    assert.equal(denied.status, 403);
  } finally {
    await deniedListener.close();
  }

  const allowedListener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      abuseControls: {
        cidrAllowlist: ["127.0.0.1/32"],
      },
    },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  const allowedPort = 30000 + Math.floor(Math.random() * 20000);
  (allowedListener as any).options.port = allowedPort;
  await allowedListener.start();
  try {
    const allowed = await fetch(`http://127.0.0.1:${allowedPort}/health`);
    assert.equal(allowed.status, 200);
  } finally {
    await allowedListener.close();
  }
});

test("listener enforces principal in-flight abuse limit with backpressure", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "ops-secret" }],
      },
      abuseControls: {
        principalMaxInFlight: 1,
      },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const controller = new AbortController();
    const first = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer ops-secret",
      },
      signal: controller.signal,
    });
    assert.equal(first.status, 200);

    const second = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer ops-secret",
      },
    });
    assert.equal(second.status, 429);

    controller.abort();
  } finally {
    await listener.close();
  }
});

test("listener refuses insecure remote startup without auth", () => {
  assert.throws(
    () =>
      new CallmuxListener({
        port: 4860,
        host: "0.0.0.0",
        config: { servers: {} },
        upstream: new UpstreamManager(),
        cache: new CallCache(0),
        allTools: [],
        maxConcurrency: 10,
      }),
    /Refusing insecure remote listener/
  );
});

test("listener allows insecure remote startup only when explicitly overridden", () => {
  const listener = new CallmuxListener({
    port: 4860,
    host: "0.0.0.0",
    config: { servers: {}, allowInsecureRemoteListener: true },
    upstream: new UpstreamManager(),
    cache: new CallCache(0),
    allTools: [],
    maxConcurrency: 10,
  });
  assert.ok(listener);
});

test("listener rejects oversized /mcp payloads with 413", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const oversized = "x".repeat(1024 * 1024 + 256);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: oversized,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error, "Payload too large");
  } finally {
    await listener.close();
  }
});

test("listener allows per-request payload override when enabled", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      requestBodyMaxBytes: 1024,
      allowRequestBodyMaxOverride: true,
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      params: { payload: "x".repeat(32_000) },
      id: 1,
    });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-callmux-max-body-bytes": "0",
      },
      body,
    });
    assert.equal(res.status, 400);
  } finally {
    await listener.close();
  }
});

test("listener rejects per-request payload override when disabled", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      requestBodyMaxBytes: 1024,
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-callmux-max-body-bytes": "2048",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.match(payload.error, /not allowed/);
  } finally {
    await listener.close();
  }
});

test("listener applies per-server payload limit for targeted tools", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {
        github: { command: "node", args: ["server.js"], requestBodyMaxBytes: 1024 },
      },
      requestBodyMaxBytes: 100_000,
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "github__get_issue",
          arguments: { payload: "x".repeat(6_000) },
        },
        id: 1,
      }),
    });
    assert.equal(res.status, 413);
  } finally {
    await listener.close();
  }
});

test("listener applies per-server payload limit for unique unqualified callmux_call tool", async () => {
  const upstream = new UpstreamManager();
  (upstream as unknown as {
    resolveServer: (
      toolName: string
    ) => { client: unknown; actualName: string; server: string } | null;
  }).resolveServer = (toolName: string) => {
    if (toolName === "get_issue") {
      return { client: {}, actualName: "get_issue", server: "github" };
    }
    return null;
  };
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {
        github: { command: "node", args: ["server.js"], requestBodyMaxBytes: 1024 },
      },
      requestBodyMaxBytes: 100_000,
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "callmux_call",
          arguments: {
            tool: "get_issue",
            arguments: { payload: "x".repeat(6_000) },
          },
        },
        id: 1,
      }),
    });
    assert.equal(res.status, 413);
  } finally {
    await listener.close();
  }
});

test("listener accepts streamable HTTP initialize and lists tools", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const tools: Tool[] = [{ name: "my_tool", description: "Test", inputSchema: { type: "object", properties: {} } }];

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: tools,
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const mcpHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };

    // Initialize
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        id: 1,
      }),
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId, "should return session ID");

    // List tools — response may be SSE or JSON depending on transport
    const listRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    assert.equal(listRes.status, 200);

    const contentType = listRes.headers.get("content-type") ?? "";
    let listBody: any;
    if (contentType.includes("text/event-stream")) {
      const text = await listRes.text();
      const dataLine = text.split("\n").find((l: string) => l.startsWith("data: "));
      assert.ok(dataLine, "SSE response should contain data line");
      listBody = JSON.parse(dataLine.slice(6));
    } else {
      listBody = await listRes.json();
    }
    assert.equal(listBody.result.tools.length, 1);
    assert.equal(listBody.result.tools[0].name, "my_tool");
  } finally {
    await listener.close();
  }
});

test("listener SSE endpoint establishes connection", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  const port = 30000 + Math.floor(Math.random() * 20000);
  (listener as any).options.port = port;

  await listener.start();
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/sse`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));
    controller.abort();
  } finally {
    await listener.close();
  }
});
