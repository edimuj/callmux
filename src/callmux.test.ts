import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { createSign, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
  formatListenerDoctorReport,
  formatDoctorReport,
  formatServerTestReports,
  formatServerTestReport,
  runListenerDoctor,
  runDoctor,
  runServerTest,
} from "./doctor.js";
import { handleBatch, handleCall, handleCacheClear, handleDryRun, handleParallel, handlePipeline, handleRecipeDryRun, handleRecipeRun, handleSearchTools, handleStatus } from "./handlers.js";
import { CallmuxProxy } from "./proxy.js";
import { mapBounded, UpstreamManager } from "./upstream.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, StdioServerConfig } from "./types.js";
import { META_TOOLS } from "./meta-tools.js";
import { errorResult } from "./results.js";
import { formatToolText } from "./output-format.js";
import { VERSION } from "./version.js";
import { OidcJwtVerifier } from "./oidc.js";
import { AbuseController } from "./abuse.js";
import { PrometheusMetrics } from "./metrics.js";
import { formatCommandForDisplay, redactUrl } from "./redact.js";
import { hashBearerToken } from "./auth.js";
import { evaluateToolAuthorization } from "./authorization.js";
import { listenerClientUrl, renderSharedListenerStartCommand } from "./setup.js";
import { createResponseStore } from "./response-store.js";
import {
  compressToolForExposure,
  resolveSchemaCompressionConfig,
} from "./schema-compression.js";
import { createDaemonPlan, formatDaemonPlan } from "./daemon.js";
import { classifyDashboardToolStatus, renderDashboardHtml, RuntimeEventStore } from "./dashboard.js";
import { CallmuxBridge, deriveBridgeCallOptions } from "./bridge.js";
import { renderAgentInstructions } from "./instructions.js";
import { shutdownAfterFatalListenerError } from "./fatal.js";
import {
  applyManagementOverlay,
  loadManagementOverlay,
  saveManagementOverlay,
} from "./management.js";
import { ManagementClient } from "./management-client.js";

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

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate test port");
  }
  return address.port;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50
): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`condition not met within ${timeoutMs}ms${detail}`);
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

test("CallCache tracks hit/miss counters and hit rate", () => {
  const cache = new CallCache(60);
  cache.set("get_item", { id: 1 }, textResult("one"));

  assert.deepEqual(cache.get("get_item", { id: 1 }), textResult("one")); // hit
  assert.equal(cache.get("get_item", { id: 2 }), null); // miss
  assert.equal(cache.get("get_item", { id: 3 }), null); // miss

  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 2);
  assert.ok(Math.abs(stats.hitRate - 1 / 3) < 1e-9);
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

test("CallCache safe retry classification does not require active caching", () => {
  const cache = new CallCache(0);

  assert.equal(cache.canCache("get_issue"), false);
  assert.equal(cache.isSafeToRetry("get_issue"), true);
  assert.equal(cache.isSafeToRetry("create_issue"), false);
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

test("batch coerces string arguments from downstream tool schema", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: Tool }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
    getServerConcurrency: (server: string) => number | undefined;
  };

  const received: Record<string, unknown>[] = [];
  upstream.clients = new Map([
    [
      "memory",
      {
        async callTool(params) {
          received.push(params.arguments ?? {});
          return textResult("ok");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    [
      "memory__ms_set",
      {
        server: "memory",
        tool: {
          name: "ms_set",
          description: "Set memory",
          inputSchema: {
            type: "object",
            properties: {
              feedback: { type: "boolean" },
              score: { type: "number" },
              count: { type: "integer" },
              nested: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    ],
  ]);
  upstream.exposedToolsByServer = new Map([["memory", new Set(["ms_set"])]]);
  upstream.getServerConcurrency = () => undefined;

  const result = await handleBatch(
    upstream as never,
    new CallCache(0),
    {
      server: "memory",
      tool: "ms_set",
      items: [
        {
          arguments: {
            feedback: "false",
            score: "4.5",
            count: "2",
            untouched: "123",
            nested: { enabled: "true" },
          },
        },
      ],
    },
    4
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(received, [
    {
      feedback: false,
      score: 4.5,
      count: 2,
      untouched: "123",
      nested: { enabled: true },
    },
  ]);
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

test("loadConfig parses reconnect policy configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-reconnect-config-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({
    servers: { fake: { command: "fake" } },
    reconnectPolicy: {
      initialDelayMs: 100,
      maxDelayMs: 5000,
      jitterRatio: 0.1,
      maxAttempts: null,
      fastFailDuringBackoff: true,
    },
  }));
  try {
    const config = await loadConfig(path);
    assert.deepEqual(config.reconnectPolicy, {
      initialDelayMs: 100,
      maxDelayMs: 5000,
      jitterRatio: 0.1,
      maxAttempts: null,
      fastFailDuringBackoff: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    "--call-timeout",
    "60000",
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
    callTimeoutMs: 60000,
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
    "--call-timeout",
    "70000",
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
    callTimeoutMs: 70000,
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
      callTimeoutMs: 50000,
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
      callTimeoutMs: 80000,
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
    callTimeoutMs: 80000,
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
    callTimeoutMs: 90000,
    requestBodyMaxBytes: 2048,
  };

  assert.deepEqual(serializeServers(config), [
    {
      name: "github",
      command: "npx",
      args: ["server.js"],
      envKeys: ["A_TOKEN", "B_TOKEN"],
      cachePolicy: { allowTools: ["get_*"] },
      callTimeoutMs: 90000,
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
    callTimeoutMs: 90000,
    requestBodyMaxBytes: 2048,
  };

  const output = formatServerList(config);

  assert.match(output, /^github/m);
  assert.match(output, /command: npx -y @modelcontextprotocol\/server-github/);
  assert.match(output, /tools: get_issue/);
  assert.match(output, /env keys: GITHUB_TOKEN/);
  assert.match(output, /call timeout ms: 90000/);
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
    formatCommandForDisplay("server", ["--cookie", "session=abc", "--safe", "ok"]),
    "server --cookie [redacted] --safe ok"
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

test("attachClaudeConfig can write shared listener URL entries", () => {
  const result = attachClaudeConfig({
    source: JSON.stringify({}),
    serverName: "callmux",
    url: "http://localhost:4860/sse",
  });

  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.content), {
    mcpServers: {
      callmux: {
        url: "http://localhost:4860/sse",
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

test("attachCodexConfig can write shared listener URL entries", () => {
  const result = attachCodexConfig({
    source: "",
    serverName: "callmux",
    url: "http://localhost:4860/mcp",
  });

  assert.equal(result.changed, true);
  assert.match(result.content, /\[mcp_servers\.callmux\]/);
  assert.match(result.content, /url = "http:\/\/localhost:4860\/mcp"/);
  assert.doesNotMatch(result.content, /command = "callmux"/);
});

test("attachCodexConfig can write shared listener bridge entries", () => {
  const result = attachCodexConfig({
    source: "",
    serverName: "callmux",
    url: "http://localhost:4860/mcp",
    bridge: true,
  });

  assert.equal(result.changed, true);
  assert.match(result.content, /\[mcp_servers\.callmux\]/);
  assert.match(result.content, /command = "callmux"/);
  assert.match(result.content, /args = \["bridge","--url","http:\/\/localhost:4860\/mcp"\]/);
  assert.doesNotMatch(result.content, /^url = /m);
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

test("renderClientSnippet emits shared listener URL snippets", () => {
  assert.deepEqual(
    JSON.parse(renderClientSnippet("claude", {
      serverName: "callmux",
      url: "http://localhost:4860/sse",
    })),
    {
      mcpServers: {
        callmux: {
          url: "http://localhost:4860/sse",
        },
      },
    }
  );

  assert.equal(
    renderClientSnippet("codex", {
      serverName: "callmux",
      url: "http://localhost:4860/mcp",
    }),
    [
      "[mcp_servers.callmux]",
      'url = "http://localhost:4860/mcp"',
    ].join("\n")
  );
});

test("renderClientSnippet emits shared listener bridge snippets", () => {
  assert.deepEqual(
    JSON.parse(renderClientSnippet("claude", {
      serverName: "callmux",
      url: "http://localhost:4860/mcp",
      bridge: true,
    })),
    {
      mcpServers: {
        callmux: {
          command: "callmux",
          args: ["bridge", "--url", "http://localhost:4860/mcp"],
        },
      },
    }
  );

  assert.equal(
    renderClientSnippet("codex", {
      serverName: "callmux",
      url: "http://localhost:4860/mcp",
      bridge: true,
    }),
    [
      "[mcp_servers.callmux]",
      'command = "callmux"',
      'args = ["bridge","--url","http://localhost:4860/mcp"]',
    ].join("\n")
  );
});

test("shared listener setup helpers derive client URLs and start command", () => {
  assert.equal(
    listenerClientUrl("http://localhost:4860", "codex"),
    "http://localhost:4860/mcp"
  );
  assert.equal(
    listenerClientUrl("http://localhost:4860/mcp", "claude"),
    "http://localhost:4860/sse"
  );
  assert.equal(
    renderSharedListenerStartCommand("http://localhost:4860/mcp", "/tmp/callmux.json"),
    "callmux --listen 4860 --config /tmp/callmux.json"
  );
  assert.equal(
    renderSharedListenerStartCommand("http://0.0.0.0:4860", "/tmp/callmux.json"),
    "callmux --listen 4860 --host 0.0.0.0 --config /tmp/callmux.json"
  );
});

test("renderAgentInstructions includes compact safety guidance without local paths", () => {
  const output = renderAgentInstructions({ profile: "codex", mode: "meta-only" });

  assert.match(output, /callmux Agent Instructions/);
  assert.match(output, /callmux_dry_run/);
  assert.match(output, /onMappingMissing: "fail"/);
  assert.match(output, /failedIndexes/);
  assert.match(output, /failedStep/);
  assert.match(output, /\$file/);
  assert.match(output, /\$jsonFile/);
  assert.match(output, /\$json` and `\$json\.path` are pipeline `inputMapping` expressions only/);
  assert.match(output, /_callmux\.retrieval/);
  assert.match(output, /outputFormat: "toon"/);
  assert.match(output, /meta-only mode/);
  assert.doesNotMatch(output, /\/home\/edimuj|Tailscale|Exelerus|Stockholm/);
  assert.ok(output.split("\n").length < 40);
});

test("shutdownAfterFatalListenerError closes resources and exits non-zero", async () => {
  const logs: string[] = [];
  let closed = false;
  let exitCode: number | undefined;

  await shutdownAfterFatalListenerError(
    "uncaughtException",
    new Error("boom"),
    {
      close: async () => {
        closed = true;
      },
      log: (message) => logs.push(message),
      exit: (code) => {
        exitCode = code;
      },
      timeoutMs: 100,
    }
  );

  assert.equal(closed, true);
  assert.equal(exitCode, 1);
  assert.match(logs.join(""), /uncaughtException/);
  assert.match(logs.join(""), /Fatal listener error/);
});

test("shutdownAfterFatalListenerError exits after bounded cleanup timeout", async () => {
  const logs: string[] = [];
  let exitCode: number | undefined;

  await shutdownAfterFatalListenerError(
    "unhandledRejection",
    "stuck",
    {
      close: async () => {
        await new Promise(() => {});
      },
      log: (message) => logs.push(message),
      exit: (code) => {
        exitCode = code;
      },
      timeoutMs: 5,
    }
  );

  assert.equal(exitCode, 1);
  assert.match(logs.join(""), /cleanup timed out/);
});

test("daemon plan renders user systemd install safely by default", () => {
  const plan = createDaemonPlan(
    {
      action: "install",
      configPath: "/tmp/callmux.json",
      binaryPath: "/usr/local/bin/callmux",
      start: true,
      enable: true,
    },
    {
      platform: "linux",
      homeDir: "/home/alice",
      uid: 1000,
      hasSystemctl: true,
    }
  );

  assert.equal(plan.kind, "systemd");
  assert.equal(plan.scope, "user");
  assert.equal(plan.serviceFilePath, "/home/alice/.config/systemd/user/callmux.service");
  assert.ok(plan.file?.content.includes("callmux-managed-daemon"));
  assert.ok(plan.file?.content.includes('ExecStart="/usr/local/bin/callmux" --config "/tmp/callmux.json" --listen 4860'));
  assert.deepEqual(plan.commands, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "callmux.service"],
    ["systemctl", "--user", "start", "callmux.service"],
  ]);
});

test("daemon plan supports system scope and explicit host", () => {
  const plan = createDaemonPlan(
    {
      action: "install",
      configPath: "/etc/callmux/config.json",
      binaryPath: "/usr/bin/callmux",
      scope: "system",
      host: "0.0.0.0",
      port: 4870,
    },
    {
      platform: "linux",
      homeDir: "/root",
      uid: 1000,
      hasSystemctl: true,
    }
  );

  assert.equal(plan.scope, "system");
  assert.equal(plan.serviceFilePath, "/etc/systemd/system/callmux.service");
  assert.ok(plan.file?.content.includes("WantedBy=multi-user.target"));
  assert.ok(plan.file?.content.includes('--host "0.0.0.0"'));
  assert.deepEqual(plan.commands, [["systemctl", "daemon-reload"]]);
});

test("daemon plan runs JavaScript entrypoints through node", () => {
  const plan = createDaemonPlan(
    {
      action: "install",
      configPath: "/tmp/callmux.json",
      binaryPath: "/opt/callmux/dist/bin/callmux.js",
    },
    {
      platform: "linux",
      homeDir: "/home/alice",
      uid: 1000,
      hasSystemctl: true,
    }
  );

  assert.ok(
    plan.file?.content.includes(`ExecStart="${process.execPath}" "/opt/callmux/dist/bin/callmux.js" --config "/tmp/callmux.json" --listen 4860`)
  );
});

test("daemon plan renders macOS LaunchAgent", () => {
  const plan = createDaemonPlan(
    {
      action: "install",
      configPath: "/Users/alice/.config/callmux/config.json",
      binaryPath: "/opt/homebrew/bin/callmux",
      start: true,
    },
    {
      platform: "darwin",
      homeDir: "/Users/alice",
      uid: 501,
    }
  );

  assert.equal(plan.kind, "launchd");
  assert.equal(plan.scope, "user");
  assert.equal(plan.label, "dev.callmux.callmux");
  assert.equal(plan.serviceFilePath, "/Users/alice/Library/LaunchAgents/dev.callmux.callmux.plist");
  assert.ok(plan.file?.content.includes("<string>/opt/homebrew/bin/callmux</string>"));
  assert.deepEqual(plan.commands, [
    ["launchctl", "bootstrap", "gui/501", "/Users/alice/Library/LaunchAgents/dev.callmux.callmux.plist"],
    ["launchctl", "kickstart", "-k", "gui/501/dev.callmux.callmux"],
  ]);
});

test("daemon plan falls back to manual command on unsupported platforms", () => {
  const plan = createDaemonPlan(
    {
      action: "install",
      configPath: "/tmp/callmux.json",
      binaryPath: "/usr/local/bin/callmux",
    },
    {
      platform: "win32",
      homeDir: "C:\\Users\\alice",
    }
  );

  assert.equal(plan.supported, false);
  assert.equal(plan.kind, "unsupported");
  assert.equal(plan.commands.length, 0);
  assert.match(formatDaemonPlan(plan), /Manual command:/);
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

test("formatListenerDoctorReport summarizes listener smoke checks", () => {
  const output = formatListenerDoctorReport({
    ok: true,
    url: "http://127.0.0.1:4860/mcp",
    mcpUrl: "http://127.0.0.1:4860/mcp",
    healthUrl: "http://127.0.0.1:4860/health",
    cwd: "/repo",
    health: { status: 200, ok: true },
    initialize: { status: 200, ok: true, sessionId: "session-1" },
    status: { ok: true },
    issues: [],
  });

  assert.match(output, /Status: ok/);
  assert.match(output, /Initialize: HTTP 200 session=session-1/);
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

test("UpstreamManager reconnects a disconnected stdio server before the next call", async () => {
  const upstream = new UpstreamManager();
  const clients: Array<{ onclose?: () => void; callTool: () => Promise<CallToolResult>; close: () => Promise<void> }> = [];
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    connectCount++;
    const tool = mockTool("get_issue");
    const client = {
      onclose: undefined as undefined | (() => void),
      async callTool() {
        return textResult(`client-${connectCount}`);
      },
      async close() {},
    };
    clients.push(client);
    return {
      name,
      config,
      client,
      transport: { async close() {} },
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };

  await upstream.connect({ github: { command: "github-mcp" } });
  clients[0].onclose?.();

  const infoAfterClose = upstream.getServerInfo("github");
  assert.equal(infoAfterClose?.state, "reconnecting");
  assert.equal(upstream.getServerTools("github")[0], "get_issue");

  const result = await upstream.callTool("get_issue", { id: 1 }, "github");

  assert.equal(connectCount, 2);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "client-2" }]);
  assert.equal(upstream.getServerInfo("github")?.state, "connected");

  await upstream.close();
});

test("UpstreamManager coalesces concurrent reconnects for a disconnected server", async () => {
  const upstream = new UpstreamManager();
  const clients: Array<{ onclose?: () => void; callTool: () => Promise<CallToolResult>; close: () => Promise<void> }> = [];
  let connectCount = 0;
  let releaseReconnect: (() => void) | undefined;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    connectCount++;
    if (connectCount === 2) {
      await new Promise<void>((resolve) => {
        releaseReconnect = resolve;
      });
    }
    const tool = mockTool("get_issue");
    const client = {
      onclose: undefined as undefined | (() => void),
      async callTool() {
        return textResult(`client-${connectCount}`);
      },
      async close() {},
    };
    clients.push(client);
    return {
      name,
      config,
      client,
      transport: { async close() {} },
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };

  await upstream.connect({ github: { command: "github-mcp" } });
  clients[0].onclose?.();

  const first = upstream.callTool("get_issue", { id: 1 }, "github");
  const second = upstream.callTool("get_issue", { id: 2 }, "github");
  while (!releaseReconnect) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  releaseReconnect?.();
  const results = await Promise.all([first, second]);

  assert.equal(connectCount, 2);
  assert.deepEqual(results.map((result) => (result.content?.[0] as { text: string }).text), [
    "client-2",
    "client-2",
  ]);

  await upstream.close();
});

test("UpstreamManager returns a retryable downstream error when reconnect fails", async () => {
  const upstream = new UpstreamManager();
  const clients: Array<{ onclose?: () => void; callTool: () => Promise<CallToolResult>; close: () => Promise<void> }> = [];
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    connectCount++;
    if (connectCount > 1) throw new Error("spawn failed");
    const tool = mockTool("get_issue");
    const client = {
      onclose: undefined as undefined | (() => void),
      async callTool() {
        return textResult("old");
      },
      async close() {},
    };
    clients.push(client);
    return {
      name,
      config,
      client,
      transport: { async close() {} },
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };

  await upstream.connect({ github: { command: "github-mcp" } });
  clients[0].onclose?.();

  const result = await upstream.callTool("get_issue", { id: 1 }, "github");
  const structured = result.structuredContent as {
    error: { code: string; details?: Record<string, unknown> };
  };

  assert.equal(result.isError, true);
  assert.equal(structured.error.code, "downstream_unavailable");
  assert.equal(structured.error.details?.server, "github");
  assert.equal(structured.error.details?.retryable, true);
  assert.equal(structured.error.details?.lastError, "spawn failed");
  assert.equal(upstream.getServerInfo("github")?.state, "reconnecting");

  await upstream.close();
});

test("UpstreamManager treats configured but down servers as downstream unavailable", async () => {
  const upstream = new UpstreamManager();
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async () => {
    connectCount++;
    throw new Error("server offline");
  };

  await upstream.connect(
    { github: { command: "github-mcp" } },
    { reconnectPolicy: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 } }
  );

  const result = await upstream.callTool("get_issue", { id: 1 }, "github");
  const structured = result.structuredContent as {
    error: { code: string; details?: Record<string, unknown> };
  };

  assert.equal(result.isError, true);
  assert.equal(structured.error.code, "downstream_unavailable");
  assert.equal(structured.error.details?.server, "github");
  assert.equal(structured.error.details?.tool, "get_issue");
  assert.equal(structured.error.details?.retryable, true);
  assert.equal(structured.error.details?.lastError, "server offline");

  const qualified = await upstream.callTool("github__get_issue", { id: 1 });
  assert.equal(qualified.isError, true);
  assert.equal(
    (qualified.structuredContent as { error: { code: string } }).error.code,
    "downstream_unavailable"
  );
  assert.equal(connectCount, 1);

  await upstream.close();
});

test("UpstreamManager keeps retrying beyond the old finite reconnect limit", async () => {
  const upstream = new UpstreamManager();
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async () => {
    connectCount++;
    throw new Error(`offline-${connectCount}`);
  };

  await upstream.connect(
    { github: { command: "github-mcp" } },
    { reconnectPolicy: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0, maxAttempts: null } }
  );

  for (let i = 0; i < 6; i += 1) {
    await upstream.callTool("get_issue", { id: i }, "github", { forceReconnect: true });
  }

  assert.equal(connectCount, 7);
  const info = upstream.getServerInfo("github");
  assert.notEqual(info?.state, "failed");
  assert.equal(info?.lastError, "offline-7");
  assert.equal(info?.consecutiveFailures, 7);

  await upstream.close();
});

test("UpstreamManager honors finite reconnect maxAttempts for background retries", async () => {
  const upstream = new UpstreamManager();
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async () => {
    connectCount++;
    throw new Error(`offline-${connectCount}`);
  };

  await upstream.connect(
    { github: { command: "github-mcp" } },
    { reconnectPolicy: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, maxAttempts: 2 } }
  );

  await waitFor(async () => upstream.getServerInfo("github")?.state === "failed", 1000, 10);

  assert.equal(connectCount, 3);
  const info = upstream.getServerInfo("github");
  assert.equal(info?.state, "failed");
  assert.equal(info?.reconnectAttempts, 2);
  assert.equal(info?.lastError, "offline-3");

  await upstream.close();
});

test("UpstreamManager can attempt reconnect during backoff when fast-fail is disabled", async () => {
  const upstream = new UpstreamManager();
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async (name: string, config: ServerConfig) => {
    connectCount++;
    if (connectCount === 1) {
      throw new Error("offline");
    }
    const tool = mockTool("get_issue");
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult("recovered");
        },
        async close() {},
      },
      transport: { async close() {} },
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };

  await upstream.connect(
    { github: { command: "github-mcp" } },
    {
      reconnectPolicy: {
        initialDelayMs: 60_000,
        maxDelayMs: 60_000,
        jitterRatio: 0,
        fastFailDuringBackoff: false,
      },
    }
  );

  const result = await upstream.callTool("get_issue", { id: 1 }, "github");

  assert.equal(connectCount, 2);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{ type: "text", text: "recovered" }]);
  assert.equal(upstream.getServerInfo("github")?.state, "connected");

  await upstream.close();
});

test("UpstreamManager records tool suite changes and removed tools after reconnect", async () => {
  const upstream = new UpstreamManager();
  const clients: Array<{ onclose?: () => void; callTool: () => Promise<CallToolResult>; close: () => Promise<void> }> = [];
  const events: Array<{ server: string; addedTools: string[]; removedTools: string[]; generation: number }> = [];
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async (name: string, config: ServerConfig) => {
    connectCount++;
    const toolNames = connectCount === 1 ? ["get_issue", "old_tool"] : ["get_issue", "new_tool"];
    const tools = toolNames.map((tool) => mockTool(tool));
    const client = {
      onclose: undefined as undefined | (() => void),
      async callTool() {
        return textResult(`client-${connectCount}`);
      },
      async close() {},
    };
    clients.push(client);
    return {
      name,
      config,
      client,
      transport: { async close() {} },
      resolvedTransport: "stdio",
      allTools: tools,
      tools,
      connectDurationMs: 1,
    };
  };
  upstream.subscribeToolSuiteChanges((event) => events.push(event));

  await upstream.connect({ github: { command: "github-mcp" } });
  clients[0].onclose?.();
  await upstream.callTool("get_issue", { id: 1 }, "github", { forceReconnect: true });

  assert.deepEqual(upstream.getServerTools("github"), ["get_issue", "new_tool"]);
  assert.ok(events.some((event) =>
    event.server === "github" &&
    event.addedTools.includes("new_tool") &&
    event.removedTools.includes("old_tool")
  ));
  const removed = await upstream.callTool("old_tool", {}, "github");
  assert.equal(removed.isError, true);
  assert.equal(
    (removed.structuredContent as { error: { code: string } }).error.code,
    "tool_removed_after_reconnect"
  );
  const removedQualified = await upstream.callTool("github__old_tool", {});
  assert.equal(removedQualified.isError, true);
  assert.equal(
    (removedQualified.structuredContent as { error: { code: string } }).error.code,
    "tool_removed_after_reconnect"
  );

  await upstream.close();
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
  assert.match(structured.error.message, /timed out after 5ms/);
  assert.equal(structured.error.details?.tool, "get_issue");
  assert.equal(structured.error.details?.category, "timeout");
  assert.equal(structured.error.details?.retryable, true);
  assert.match(String(structured.error.details?.rootCause ?? ""), /timed out after 5ms/i);
});

test("UpstreamManager defaults tool calls to 180s timeout", async () => {
  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (_params: unknown, _schema?: unknown, _options?: { timeout?: number }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };
  let observedTimeout: number | undefined;

  upstream.clients = new Map([
    ["github", {
      async callTool(_params: unknown, _schema?: unknown, options?: { timeout?: number }) {
        observedTimeout = options?.timeout;
        return textResult("ok");
      },
    }],
  ]);
  upstream.toolMap = new Map([
    ["get_issue", { server: "github", tool: { name: "get_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["get_issue"])]]);

  await upstream.callTool("get_issue", { id: 1 });

  assert.equal(observedTimeout, 180_000);
});

test("UpstreamManager applies server and per-call timeout overrides", async () => {
  const upstream = new UpstreamManager(180_000) as unknown as {
    clients: Map<string, { callTool: (_params: unknown, _schema?: unknown, _options?: { timeout?: number }) => Promise<CallToolResult> }>;
    serverConfigs: Map<string, ServerConfig>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string, context?: { timeoutMs?: number }) => Promise<CallToolResult>;
  };
  const observedTimeouts: Array<number | undefined> = [];

  upstream.clients = new Map([
    ["github", {
      async callTool(_params: unknown, _schema?: unknown, options?: { timeout?: number }) {
        observedTimeouts.push(options?.timeout);
        return textResult("ok");
      },
    }],
  ]);
  upstream.serverConfigs = new Map([
    ["github", { command: "node", callTimeoutMs: 60_000 }],
  ]);
  upstream.toolMap = new Map([
    ["get_issue", { server: "github", tool: { name: "get_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["get_issue"])]]);

  await upstream.callTool("get_issue", { id: 1 }, "github");
  await upstream.callTool("get_issue", { id: 2 }, "github", { timeoutMs: 5_000 });

  assert.deepEqual(observedTimeouts, [60_000, 5_000]);
});

test("UpstreamManager enforces hard call timeout when client ignores SDK timeout", async () => {
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
          await new Promise(() => {});
          return textResult("late");
        },
      },
    ],
  ]);
  upstream.toolMap = new Map([
    ["add_issue_comment", { server: "github", tool: { name: "add_issue_comment" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["add_issue_comment"])]]);

  const result = await upstream.callTool("add_issue_comment", { body: "markdown" }, "github");

  assert.equal(observedTimeout, 5);
  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    error: { code: string; message: string; details?: Record<string, unknown> };
  };
  assert.equal(structured.error.code, "tool_call_failed");
  assert.match(structured.error.message, /github.+add_issue_comment.+timed out after 5ms/i);
  assert.equal(structured.error.details?.tool, "add_issue_comment");
  assert.equal(structured.error.details?.server, "github");
  assert.equal(structured.error.details?.category, "timeout");
  assert.equal(structured.error.details?.retryable, true);
});

test("UpstreamManager retires and reconnects a client after hard call timeout", async () => {
  const upstream = new UpstreamManager(5);
  let connectCount = 0;
  let firstClosed = false;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    connectCount++;
    const tool = mockTool("add_issue_comment");
    const currentConnect = connectCount;
    return {
      name,
      config,
      client: {
        async callTool() {
          if (currentConnect === 1) {
            await new Promise(() => {});
          }
          return textResult(`client-${currentConnect}`);
        },
        async close() {
          if (currentConnect === 1) firstClosed = true;
        },
      },
      transport: { async close() {} },
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };

  await upstream.connect({ github: { command: "github-mcp" } });

  const timedOut = await upstream.callTool(
    "add_issue_comment",
    { body: "markdown" },
    "github"
  );

  assert.equal(timedOut.isError, true);
  assert.equal(firstClosed, true);
  assert.equal(upstream.getServerInfo("github")?.state, "reconnecting");

  const recovered = await upstream.callTool(
    "add_issue_comment",
    { body: "markdown" },
    "github"
  );

  assert.equal(connectCount, 2);
  assert.equal(recovered.isError, undefined);
  assert.deepEqual(recovered.content, [{ type: "text", text: "client-2" }]);
  assert.equal(upstream.getServerInfo("github")?.state, "connected");

  await upstream.close();
});

test("handleCall retries safe tools once after reconnect but not mutating tools", async () => {
  async function run(toolName: string): Promise<{ result: CallToolResult; connectCount: number }> {
    const upstream = new UpstreamManager();
    const cache = new CallCache(0);
    let connectCount = 0;
    const harness = upstream as unknown as {
      connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
    };
    harness.connectOne = async (name: string, config: ServerConfig) => {
      connectCount++;
      const currentConnect = connectCount;
      const tool = mockTool(toolName);
      return {
        name,
        config,
        client: {
          async callTool() {
            if (currentConnect === 1) {
              throw new Error("transport send error: broken pipe");
            }
            return textResult(`client-${currentConnect}`);
          },
          async close() {},
        },
        transport: { async close() {} },
        resolvedTransport: "stdio",
        allTools: [tool],
        tools: [tool],
        connectDurationMs: 1,
      };
    };

    await upstream.connect({ github: { command: "github-mcp" } });
    try {
      const result = await handleCall(upstream, cache, {
        server: "github",
        tool: toolName,
        arguments: {},
      });
      return { result, connectCount };
    } finally {
      await upstream.close();
    }
  }

  const safe = await run("get_issue");
  assert.equal(safe.connectCount, 2);
  assert.equal(safe.result.isError, undefined);
  assert.deepEqual(safe.result.content, [{ type: "text", text: "client-2" }]);

  const mutating = await run("create_issue");
  assert.equal(mutating.connectCount, 1);
  assert.equal(mutating.result.isError, true);
  assert.equal(
    (mutating.result.structuredContent as { error: { code: string } }).error.code,
    "tool_call_failed"
  );
});

test("fan-out meta-tools retry safe child calls once after reconnect", async () => {
  async function run(
    mode: "parallel" | "batch" | "pipeline"
  ): Promise<{ result: CallToolResult; connectCount: number }> {
    const upstream = new UpstreamManager();
    const cache = new CallCache(0);
    let connectCount = 0;
    const harness = upstream as unknown as {
      connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
    };
    harness.connectOne = async (name: string, config: ServerConfig) => {
      connectCount++;
      const currentConnect = connectCount;
      const tool = mockTool("get_issue");
      return {
        name,
        config,
        client: {
          async callTool() {
            if (currentConnect === 1) {
              throw new Error("transport send error: broken pipe");
            }
            return textResult(`client-${currentConnect}`);
          },
          async close() {},
        },
        transport: { async close() {} },
        resolvedTransport: "stdio",
        allTools: [tool],
        tools: [tool],
        connectDurationMs: 1,
      };
    };

    await upstream.connect({ github: { command: "github-mcp" } });
    try {
      if (mode === "parallel") {
        const result = await handleParallel(
          upstream,
          cache,
          { calls: [{ server: "github", tool: "get_issue", arguments: {} }] },
          4
        );
        return { result, connectCount };
      }

      if (mode === "batch") {
        const result = await handleBatch(
          upstream,
          cache,
          {
            server: "github",
            tool: "get_issue",
            items: [{ arguments: {} }],
          },
          4
        );
        return { result, connectCount };
      }

      const result = await handlePipeline(
        upstream,
        cache,
        { steps: [{ server: "github", tool: "get_issue", arguments: {} }] }
      );
      return { result, connectCount };
    } finally {
      await upstream.close();
    }
  }

  const parallel = await run("parallel");
  assert.equal(parallel.connectCount, 2);
  assert.equal(
    (parallel.result.structuredContent as {
      results: Array<{ result: string }>;
    }).results[0].result,
    "client-2"
  );

  const batch = await run("batch");
  assert.equal(batch.connectCount, 2);
  assert.equal(
    (batch.result.structuredContent as {
      results: Array<{ result: string }>;
    }).results[0].result,
    "client-2"
  );

  const pipeline = await run("pipeline");
  assert.equal(pipeline.connectCount, 2);
  assert.equal(
    (pipeline.result.structuredContent as {
      steps: Array<{ result: string }>;
    }).steps[0].result,
    "client-2"
  );
});

test("cached file-reference calls key on resolved file content", async () => {
  async function run(
    mode: "call" | "parallel" | "batch" | "pipeline" | "proxy"
  ): Promise<{ first: string; second: string; downstreamCalls: number }> {
    const dir = await mkdtemp(join(tmpdir(), `callmux-file-ref-cache-${mode}-`));
    const queryPath = join(dir, "query.txt");
    const upstream = new UpstreamManager();
    const cache = new CallCache(60);
    let downstreamCalls = 0;
    const harness = upstream as unknown as {
      connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
    };
    harness.connectOne = async (name: string, config: ServerConfig) => {
      const tool = mockTool("get_issue");
      return {
        name,
        config,
        client: {
          async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
            downstreamCalls++;
            return textResult(String(params.arguments?.query));
          },
          async close() {},
        },
        transport: { async close() {} },
        resolvedTransport: "stdio",
        allTools: [tool],
        tools: [tool],
        connectDurationMs: 1,
      };
    };

    const args = { query: { $file: queryPath } };
    const proxy = mode === "proxy"
      ? new CallmuxProxy({
        servers: {},
        cacheTtlSeconds: 60,
      })
      : undefined;
    if (proxy) {
      (proxy as unknown as { upstream: UpstreamManager }).upstream = upstream;
    }

    const invoke = async (): Promise<string> => {
      let result: CallToolResult;
      if (mode === "call") {
        result = await handleCall(upstream, cache, {
          server: "github",
          tool: "get_issue",
          arguments: args,
        });
      } else if (mode === "parallel") {
        result = await handleParallel(upstream, cache, {
          calls: [{ server: "github", tool: "get_issue", arguments: args }],
        }, 4);
        return ((result.structuredContent as {
          results: Array<{ result: string }>;
        }).results[0].result);
      } else if (mode === "batch") {
        result = await handleBatch(upstream, cache, {
          server: "github",
          tool: "get_issue",
          items: [{ arguments: args }],
        }, 4);
        return ((result.structuredContent as {
          results: Array<{ result: string }>;
        }).results[0].result);
      } else if (mode === "pipeline") {
        result = await handlePipeline(upstream, cache, {
          steps: [{ server: "github", tool: "get_issue", arguments: args }],
        });
        return ((result.structuredContent as {
          steps: Array<{ result: string }>;
        }).steps[0].result);
      } else {
        result = await (proxy as unknown as {
          handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
        }).handleToolCall("get_issue", args);
        return result.content[0].type === "text" ? result.content[0].text : "";
      }
      return result.content[0].type === "text" ? result.content[0].text : "";
    };

    await upstream.connect({ github: { command: "github-mcp" } });
    try {
      await writeFile(queryPath, "first", "utf8");
      const first = await invoke();
      await writeFile(queryPath, "second", "utf8");
      const second = await invoke();
      return { first, second, downstreamCalls };
    } finally {
      await upstream.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  for (const mode of ["call", "parallel", "batch", "pipeline", "proxy"] as const) {
    const result = await run(mode);
    assert.equal(result.first, "first", mode);
    assert.equal(result.second, "second", mode);
    assert.equal(result.downstreamCalls, 2, mode);
  }
});

test("UpstreamManager close falls back to transport close when client close hangs", async () => {
  const upstream = new UpstreamManager();
  let transportClosed = false;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async (name: string, config: ServerConfig) => {
    const tool = mockTool("get_issue");
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult("ok");
        },
        async close() {
          await new Promise(() => {});
        },
      },
      transport: {
        async close() {
          transportClosed = true;
        },
      },
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };

  await upstream.connect({ github: { command: "github-mcp" } });

  const startedAt = Date.now();
  await upstream.close();
  const durationMs = Date.now() - startedAt;

  assert.equal(transportClosed, true);
  assert.ok(durationMs < 1800, `close took ${durationMs}ms`);
});

test("UpstreamManager close force-kills stdio child when SDK close stalls", async () => {
  const upstream = new UpstreamManager();
  const signals: string[] = [];
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdin: { end: () => void };
    kill: (signal: NodeJS.Signals) => boolean;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = { end() {} };
  child.kill = (signal: NodeJS.Signals) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      child.signalCode = signal;
      child.emit("close", null, signal);
    }
    return true;
  };

  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async (name: string, config: ServerConfig) => {
    const tool = mockTool("get_issue");
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult("ok");
        },
        async close() {
          await new Promise(() => {});
        },
      },
      transport: {
        _process: child,
        async close() {},
      },
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };

  await upstream.connect({ github: { command: "github-mcp" } });
  const startedAt = Date.now();
  await upstream.close();
  const durationMs = Date.now() - startedAt;

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(durationMs < 1800, `close took ${durationMs}ms`);
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

test("UpstreamManager resolves a file reference coerced to a JSON string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-stringified-ref-"));
  const bodyPath = join(dir, "body.md");
  await writeFile(bodyPath, "# Real Body\n\nResolved from a stringified ref.\n");

  const upstream = new UpstreamManager() as unknown as {
    clients: Map<string, { callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<CallToolResult> }>;
    toolMap: Map<string, { server: string; tool: { name: string } }>;
    exposedToolsByServer: Map<string, Set<string>>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
  };

  let forwarded: Record<string, unknown> | undefined;
  upstream.clients = new Map([
    ["github", { async callTool(params) { forwarded = params.arguments; return textResult("ok"); } }],
  ]);
  upstream.toolMap = new Map([
    ["create_issue", { server: "github", tool: { name: "create_issue" } }],
  ]);
  upstream.exposedToolsByServer = new Map([["github", new Set(["create_issue"])]]);

  try {
    // The client stringifies a {$file} object onto a string-typed field; callmux
    // must still resolve it to the file content, not forward the literal.
    const result = await upstream.callTool("create_issue", {
      body: JSON.stringify({ $file: bodyPath }),
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(forwarded, { body: "# Real Body\n\nResolved from a stringified ref.\n" });

    // A normal string that merely mentions "$file", or non-lone-ref JSON, is left alone.
    forwarded = undefined;
    const ok = await upstream.callTool("create_issue", {
      title: "see the $file convention",
      body: JSON.stringify({ $file: "/tmp/x", title: "keep me" }),
    });
    assert.equal(ok.isError, undefined);
    assert.deepEqual(forwarded, {
      title: "see the $file convention",
      body: '{"$file":"/tmp/x","title":"keep me"}',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
      cwd: string;
    };
    assert.equal(payload.server, "fake");
    assert.equal(payload.tool, "get_item");
    assert.deepEqual(payload.arguments, { id: 42 });
    assert.equal(typeof payload.cwd, "string");
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

test("UpstreamManager retires session-scoped stdio clients when idle TTL is zero", async () => {
  const upstream = new UpstreamManager();
  const cwd = await mkdtemp(join(tmpdir(), "callmux-session-idle-"));

  try {
    await upstream.connect(
      {
        fake: fakeMcpServer("fake", {
          FAKE_MCP_TOOLS: JSON.stringify([
            { name: "get_item", description: "Get a fake item" },
          ]),
        }),
      },
      { sessionCwdIdleTtlSeconds: 0 }
    );

    const result = await upstream.callTool(
      "get_item",
      { id: 1 },
      undefined,
      { cwd, sessionId: "session-1" }
    );
    assert.equal(result.isError, undefined);
    assert.equal((upstream as any).sessionClients.size, 0);
  } finally {
    await upstream.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("UpstreamManager rejects cwd-scoped stdio servers with mismatched tool surface", async () => {
  const upstream = new UpstreamManager();
  const cwd = await mkdtemp(join(tmpdir(), "callmux-session-surface-"));

  try {
    await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([
          { name: "get_item", description: "Get a fake item" },
        ]),
      }),
    });
    const configs = (upstream as any).serverConfigs as Map<string, StdioServerConfig>;
    configs.set("fake", fakeMcpServer("fake", {
      FAKE_MCP_TOOLS: JSON.stringify([
        { name: "other_item", description: "Wrong surface" },
      ]),
    }));

    const result = await upstream.callTool(
      "get_item",
      { id: 1 },
      undefined,
      { cwd, sessionId: "session-1" }
    );

    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /did not expose expected tool/);
  } finally {
    await upstream.close();
    await rm(cwd, { recursive: true, force: true });
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

test("loadConfig parses reusable recipes from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-recipes-"));
  const configPath = join(dir, "callmux.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        recipes: {
          open_bug: {
            description: "Create a labeled bug",
            mode: "call",
            server: "github",
            tool: "create_issue",
            cwd: "/tmp/callmux-recipe",
            arguments: {
              title: { $param: "title" },
              labels: ["bug"],
            },
          },
          analyze_issue: {
            mode: "pipeline",
            steps: [
              { tool: "search_issues", arguments: { query: "bug" } },
              {
                tool: "get_issue",
                inputMapping: { issue_number: "$json.items.0.number" },
                onMappingMissing: "fail",
              },
            ],
          },
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.recipes?.open_bug.mode, "call");
    assert.equal(config.recipes?.open_bug.tool, "create_issue");
    assert.equal(config.recipes?.open_bug.cwd, "/tmp/callmux-recipe");
    assert.deepEqual(config.recipes?.open_bug.arguments?.labels, ["bug"]);
    assert.equal(config.recipes?.analyze_issue.steps?.[1].onMappingMissing, "fail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid recipe shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-recipes-invalid-"));
  const configPath = join(dir, "callmux.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        recipes: {
          broken: { mode: "batch", tool: "create_issue" },
        },
      })
    );

    await assert.rejects(loadConfig(configPath), /recipes\.broken\.items must be an array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    serverInfoMap: Map<string, { transport: string; state: string; connectDurationMs: number; totalTools: number; exposedTools: number; toolFilter?: string[]; maxConcurrency?: number; error?: string; reconnectAttempts?: number; nextRetryAt?: string }>;
    serverConcurrency: Map<string, number>;
    callTool: (toolName: string, args?: Record<string, unknown>, serverHint?: string) => Promise<CallToolResult>;
    resolveServer: (toolName: string, serverHint?: string) => { client: unknown; actualName: string; server: string } | { error: CallToolResult } | null;
    getServerNames: () => string[];
    getServerTools: (server: string) => string[];
    getServerInfo: (server: string) => { transport: string; state: string; connectDurationMs: number; totalTools: number; exposedTools: number; toolFilter?: string[]; maxConcurrency?: number; error?: string; reconnectAttempts?: number; nextRetryAt?: string } | undefined;
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

function mockTool(name: string, description?: string, inputFields: string[] = []): Tool {
  return {
    name,
    ...(description ? { description } : {}),
    inputSchema: {
      type: "object" as const,
      ...(inputFields.length > 0
        ? {
          properties: Object.fromEntries(
            inputFields.map((field) => [field, { type: "string" }])
          ),
        }
        : {}),
    },
  };
}

test("schema compression preserves input contracts while trimming descriptions", () => {
  const tool: Tool = {
    name: "get_issue",
    description: "Get a specific issue by number from the selected repository with all available metadata and comments",
    inputSchema: {
      type: "object",
      required: ["repo", "ref", "state_reason"],
      properties: {
        repo: {
          type: "string",
          description: "Repository name",
        },
        ref: {
          type: "string",
          description: "Git ref such as a branch, tag, pull request head, or full commit SHA",
          default: "main",
        },
        state_reason: {
          type: "string",
          description: "Reason for closing the issue",
          enum: ["completed", "not_planned", "duplicate"],
        },
        limit: {
          type: "integer",
          description: "Limit",
          minimum: 1,
          maximum: 100,
          default: 20,
        },
      },
    },
  };

  const compressed = compressToolForExposure(tool, {
    mode: "balanced",
    maxDescriptionChars: 32,
  });
  const properties = compressed.inputSchema.properties as Record<string, Record<string, unknown>>;

  assert.equal(compressed.description, "Get a specific issue by numbe...");
  assert.equal(properties.repo.description, undefined);
  assert.equal(properties.limit.description, undefined);
  assert.equal(properties.ref.description, "Git ref such as a branch, tag...");
  assert.equal(properties.ref.default, "main");
  assert.deepEqual(compressed.inputSchema.required, ["repo", "ref", "state_reason"]);
  assert.deepEqual(properties.state_reason.enum, ["completed", "not_planned", "duplicate"]);
  assert.equal(properties.limit.minimum, 1);
  assert.equal(properties.limit.maximum, 100);
  assert.equal(properties.limit.default, 20);
});

test("schema compression supports aggressive and disabled modes", () => {
  const tool = mockTool(
    "list_issues",
    "List issues with verbose routing guidance that can be removed in aggressive mode",
    ["repo", "ref"]
  );
  tool.inputSchema.properties = {
    repo: { type: "string", description: "Repository name" },
    ref: { type: "string", description: "Git ref to query" },
  };

  const aggressive = compressToolForExposure(tool, { mode: "aggressive" });
  const aggressiveProperties = aggressive.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(aggressive.description, undefined);
  assert.equal(aggressiveProperties.repo.description, undefined);
  assert.equal(aggressiveProperties.ref.description, "Git ref to query");

  const disabled = compressToolForExposure(tool, { enabled: false });
  assert.equal(disabled.description, tool.description);
  assert.deepEqual(disabled.inputSchema, tool.inputSchema);
  assert.deepEqual(resolveSchemaCompressionConfig().mode, "balanced");
  assert.equal(resolveSchemaCompressionConfig().enabled, true);
});

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

test("handleDryRun warns about literal $json downstream arguments", async () => {
  const upstream = {
    async prepareToolCall(
      tool: string,
      args?: Record<string, unknown>,
      server?: string
    ) {
      return {
        toolName: tool,
        server: server ?? "github",
        actualName: tool,
        resolvedArguments: args,
      };
    },
  };

  const result = await handleDryRun(upstream as never, new CallCache(0), {
    tool: "create_issue",
    arguments: {
      title: "Bug",
      body: "$json",
      labels: ["P1", "$json.labels"],
    },
  });

  assert.equal(result.isError, undefined);
  const content = result.structuredContent as {
    items: Array<{ warnings?: Array<{ code: string; path: string }> }>;
    summary: { warningCount: number };
  };
  assert.equal(content.summary.warningCount, 2);
  assert.deepEqual(
    content.items[0].warnings?.map((warning) => [warning.code, warning.path]),
    [
      ["literal_json_mapping", "arguments.body"],
      ["literal_json_mapping", "arguments.labels[1]"],
    ]
  );
});

test("handleDryRun warns when text fields resolve to structured values", async () => {
  const upstream = {
    async prepareToolCall(tool: string) {
      return {
        toolName: tool,
        server: "github",
        actualName: tool,
        resolvedArguments: {
          title: "Bug",
          body: { summary: "wrong shape" },
          metadata: { ok: true },
        },
      };
    },
  };

  const result = await handleDryRun(upstream as never, new CallCache(0), {
    tool: "create_issue",
    arguments: {
      body: { $jsonFile: "/tmp/body.json" },
    },
  });

  assert.equal(result.isError, undefined);
  const content = result.structuredContent as {
    items: Array<{ warnings?: Array<{ code: string; path: string }> }>;
    summary: { warningCount: number };
  };
  assert.equal(content.summary.warningCount, 1);
  assert.deepEqual(content.items[0].warnings?.[0], {
    code: "structured_text_field",
    canonicalCode: "structured_value_for_likely_text_field",
    path: "arguments.body",
    message:
      'Argument field "body" resolved to an object, but this field usually expects a string.',
    recommendation:
      "Use `$file` or `$text` for markdown/text bodies. Reserve `$jsonFile`/`$yamlFile` for structured payload fields.",
  });
});

test("handleDryRun warns that pipeline inputMapping is not evaluated", async () => {
  const upstream = {
    async prepareToolCall(
      tool: string,
      args?: Record<string, unknown>,
      server?: string
    ) {
      return {
        toolName: tool,
        server: server ?? "github",
        actualName: tool,
        resolvedArguments: args,
      };
    },
  };

  const result = await handleDryRun(upstream as never, new CallCache(0), {
    steps: [
      { tool: "search", arguments: { q: "bug" } },
      {
        tool: "read",
        inputMapping: { issue_number: "$json.items.0.number" },
        onMappingMissing: "fail",
      },
    ],
  });

  assert.equal(result.isError, undefined);
  const content = result.structuredContent as {
    items: Array<{ warnings?: Array<{ code: string; path: string; recommendation: string }> }>;
    summary: { warningCount: number };
  };
  assert.equal(content.summary.warningCount, 1);
  assert.deepEqual(content.items[1].warnings?.[0], {
    code: "pipeline_mapping_not_evaluated_in_dry_run",
    path: "steps[1].inputMapping",
    message:
      "Pipeline inputMapping depends on the previous step output and is not evaluated in dry run.",
    recommendation:
      "Live execution will stop before this step if a mapping is missing.",
  });
});

test("handleRecipeRun expands params and delegates to configured mode", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("create_issue") },
  ]);
  const cache = new CallCache(0);

  const result = await handleRecipeRun(
    upstream as never,
    cache,
    {
      open_bug: {
        mode: "call",
        server: "github",
        tool: "create_issue",
        arguments: {
          title: { $param: "title" },
          body: { $param: "body" },
          labels: ["bug"],
        },
      },
    },
    {
      recipe: "open_bug",
      arguments: { title: "Crash", body: "Steps" },
    },
    20
  );

  assert.equal(result.isError, undefined);
  assert.equal(
    result.content[0].type === "text" ? result.content[0].text : "",
    'github:create_issue:{"title":"Crash","body":"Steps","labels":["bug"]}'
  );
});

test("handleRecipeRun reports missing recipe parameters", async () => {
  const result = await handleRecipeRun(
    createMockUpstream([]) as never,
    new CallCache(0),
    {
      open_bug: {
        mode: "call",
        tool: "create_issue",
        arguments: { title: { $param: "title" } },
      },
    },
    { recipe: "open_bug", arguments: {} },
    20
  );

  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    "invalid_arguments"
  );
  assert.match(
    (result.structuredContent as { error: { message: string } }).error.message,
    /title/
  );
});

test("handleRecipeDryRun previews expanded recipe calls", async () => {
  const upstream = {
    async prepareToolCall(
      tool: string,
      args?: Record<string, unknown>,
      server?: string
    ) {
      return {
        toolName: tool,
        server: server ?? "github",
        actualName: tool,
        resolvedArguments: args,
      };
    },
  };

  const result = await handleRecipeDryRun(
    upstream as never,
    new CallCache(0),
    {
      pair: {
        mode: "parallel",
        calls: [
          { server: "github", tool: "get_issue", arguments: { issue_number: { $param: "first" } } },
          { server: "github", tool: "get_issue", arguments: { issue_number: { $param: "second" } } },
        ],
      },
    },
    { recipe: "pair", arguments: { first: 1, second: 2 } }
  );

  const content = result.structuredContent as {
    recipe: string;
    mode: string;
    summary: { totalCalls: number };
    items: Array<{ resolvedArguments?: Record<string, unknown> }>;
  };
  assert.equal(content.recipe, "pair");
  assert.equal(content.mode, "parallel");
  assert.equal(content.summary.totalCalls, 2);
  assert.deepEqual(content.items[0].resolvedArguments, { issue_number: 1 });
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

test("handleCall resolves the call once instead of preparing twice", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]) as unknown as UpstreamManager;

  let prepareCalls = 0;
  const original = upstream.prepareToolCall.bind(upstream);
  (upstream as unknown as { prepareToolCall: UpstreamManager["prepareToolCall"] }).prepareToolCall =
    ((tool, args, server) => {
      prepareCalls += 1;
      return original(tool, args, server);
    }) as UpstreamManager["prepareToolCall"];

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "get_issue",
    arguments: { id: 1 },
  });

  assert.equal(result.isError, undefined);
  // prepareResolvedCacheKey prepares once; the call must reuse that result via
  // callPrepared rather than re-running prepareToolCall inside callTool.
  assert.equal(prepareCalls, 1);
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
        totalAvailable: 2,
        available: ["get_issue", "list_issues"],
      },
    },
  });
});

test("handleCall truncates the available tool list and points to search", async () => {
  const tools = Array.from({ length: 40 }, (_v, i) => ({
    server: "github",
    tool: mockTool(`tool_${i}`),
  }));
  const upstream = createMockUpstream(tools);

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "missing_tool",
  });

  assert.equal(result.isError, true);
  const details = (result.structuredContent as {
    error: { details: { totalAvailable: number; available: string[]; hint: string } };
  }).error.details;
  assert.equal(details.totalAvailable, 40);
  assert.equal(details.available.length, 25);
  assert.match(details.hint, /callmux_search_tools/);
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

test("handleSearchTools ranks matching tools and returns input field hints", () => {
  const upstream = createMockUpstream([
    {
      server: "github",
      tool: mockTool(
        "get_issue",
        "Get a specific issue by number",
        ["owner", "repo", "issue_number"]
      ),
    },
    {
      server: "browser",
      tool: mockTool("browser_navigate", "Navigate to a URL", ["url"]),
    },
    {
      server: "github",
      tool: mockTool("list_pull_requests", "List pull requests", ["owner", "repo"]),
    },
  ]);

  const result = handleSearchTools(upstream as never, undefined, {
    query: "issue number",
    limit: 5,
  });

  assert.equal(result.isError, undefined);
  const content = result.structuredContent as {
    query: string;
    found: number;
    results: Array<{
      tool: string;
      name: string;
      server: string;
      inputFields?: string[];
      score: number;
    }>;
  };
  assert.equal(content.query, "issue number");
  assert.equal(content.results[0].tool, "github__get_issue");
  assert.equal(content.results[0].name, "get_issue");
  assert.equal(content.results[0].server, "github");
  assert.deepEqual(content.results[0].inputFields, ["issue_number", "owner", "repo"]);
  assert.ok(content.results[0].score > 0);
});

test("handleSearchTools supports server filter and description truncation", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get a specific issue by number") },
    { server: "browser", tool: mockTool("browser_navigate", "Navigate to a URL") },
  ]);

  const result = handleSearchTools(upstream as never, 12, {
    query: "",
    server: "github",
  });

  assert.equal(result.isError, undefined);
  const content = result.structuredContent as {
    totalTools: number;
    results: Array<{ name: string; description?: string }>;
  };
  assert.equal(content.totalTools, 1);
  assert.deepEqual(content.results.map((tool) => tool.name), ["get_issue"]);
  assert.equal(content.results[0].description, "Get a specif...");
});

test("handleSearchTools validates limit and unknown server", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);

  const invalidLimit = handleSearchTools(upstream as never, undefined, {
    query: "issue",
    limit: 51,
  });
  assert.equal(invalidLimit.isError, true);
  assert.equal(
    (invalidLimit.structuredContent as { error: { code: string } }).error.code,
    "invalid_arguments"
  );

  const unknownServer = handleSearchTools(upstream as never, undefined, {
    server: "linear",
  });
  assert.equal(unknownServer.isError, true);
  assert.equal(
    (unknownServer.structuredContent as { error: { code: string } }).error.code,
    "server_not_found"
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

test("handleStatus reports schema compression diagnostics when provided", () => {
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
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    {
      enabled: true,
      mode: "balanced",
      maxDescriptionChars: 160,
      tools: 1,
      compressedTools: 1,
      originalBytes: 500,
      compressedBytes: 300,
      savedBytes: 200,
      savedPercent: 40,
    }
  );

  const content = result.structuredContent as {
    schemaCompression: { mode: string; savedBytes: number };
  };
  assert.equal(content.schemaCompression.mode, "balanced");
  assert.equal(content.schemaCompression.savedBytes, 200);
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
  assert.ok(content.recommendations!.some((r) => r.use === "callmux_search_tools"));
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

test("handleStatus includes listener diagnostics only when requested", () => {
  const upstream = createMockUpstream([]);
  const diagnostics = {
    activeSessions: 1,
    sessions: [
      {
        id: "session-1",
        transport: "streamable-http" as const,
        cwd: "/repo",
        cwdSource: "header" as const,
        rootsAttempted: false,
      },
    ],
    scopedStdioClients: {
      total: 1,
      byServer: { tokenlean: 1 },
      items: [{ server: "tokenlean", cwd: "/repo", activeCalls: 0, idle: true }],
    },
  };

  const omitted = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    { recommendations: false },
    diagnostics
  ).structuredContent as { listener?: unknown };
  assert.equal(omitted.listener, undefined);

  const included = handleStatus(
    upstream as never,
    new CallCache(0),
    20,
    false,
    undefined,
    TEST_INSTANCE_IDENTITY,
    { sessions: true, recommendations: false },
    diagnostics
  ).structuredContent as {
    listener: { activeSessions: number; sessions: Array<{ cwd?: string }> };
  };
  assert.equal(included.listener.activeSessions, 1);
  assert.equal(included.listener.sessions[0].cwd, "/repo");
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

test("handleStatus reports reconnecting downstreams as degraded", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]);
  upstream.serverInfoMap.set("github", {
    transport: "stdio",
    state: "reconnecting",
    connectDurationMs: 42,
    totalTools: 1,
    exposedTools: 1,
    error: "transport closed",
    reconnectAttempts: 1,
    nextRetryAt: "2026-05-04T20:00:00.000Z",
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
    servers: Array<{
      state: string;
      error: string;
      reconnectAttempts: number;
      nextRetryAt: string;
    }>;
  };

  assert.equal(content.status, "degraded");
  assert.equal(content.servers[0].state, "reconnecting");
  assert.equal(content.servers[0].error, "transport closed");
  assert.equal(content.servers[0].reconnectAttempts, 1);
  assert.equal(content.servers[0].nextRetryAt, "2026-05-04T20:00:00.000Z");
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
  assert.equal(META_TOOLS.length, 11);
  assert.ok(META_TOOLS.some((t) => t.name === "callmux_search_tools"));
  assert.ok(META_TOOLS.some((t) => t.name === "callmux_get_result"));
  assert.ok(META_TOOLS.some((t) => t.name === "callmux_call"));
  assert.ok(META_TOOLS.some((t) => t.name === "callmux_recipe_run"));
});

test("configFromArgs parses --meta-only flag", () => {
  const config = configFromArgs(["--meta-only", "--", "node", "server.js"]);
  assert.equal(config.metaOnly, true);
});

test("configFromArgs parses --description-max-length", () => {
  const config = configFromArgs(["--description-max-length", "100", "--", "node", "server.js"]);
  assert.equal(config.descriptionMaxLength, 100);
});

test("configFromArgs parses --output-format", () => {
  const config = configFromArgs(["--output-format", "toon", "--", "node", "server.js"]);
  assert.equal(config.outputFormat, "toon");
});

test("configFromArgs rejects invalid --output-format", () => {
  assert.throws(
    () => configFromArgs(["--output-format", "yaml", "--", "node", "server.js"]),
    /--output-format must be "json", "toon", or "auto"/
  );
});

test("configFromArgs omits metaOnly when not specified", () => {
  const config = configFromArgs(["--", "node", "server.js"]);
  assert.equal(config.metaOnly, undefined);
});

test("loadConfig parses metaOnly, descriptionMaxLength, and outputFormat from file", async () => {
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
        outputFormat: "auto",
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.metaOnly, true);
    assert.equal(config.descriptionMaxLength, 80);
    assert.equal(config.outputFormat, "auto");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses schema compression settings from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-schema-compression-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: {
            command: "node",
            args: ["server.js"],
            schemaCompression: {
              mode: "aggressive",
              maxDescriptionChars: 80,
            },
          },
        },
        schemaCompression: {
          enabled: true,
          mode: "balanced",
          maxDescriptionChars: 120,
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.schemaCompression?.enabled, true);
    assert.equal(config.schemaCompression?.mode, "balanced");
    assert.equal(config.schemaCompression?.maxDescriptionChars, 120);
    assert.equal(
      (config.servers.github as StdioServerConfig).schemaCompression?.mode,
      "aggressive"
    );
    assert.equal(
      (config.servers.github as StdioServerConfig).schemaCompression?.maxDescriptionChars,
      80
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses per-server alwaysLoad from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-alwaysload-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          tokenlean: {
            command: "node",
            args: ["server.js"],
            alwaysLoad: ["tl_symbols", "tl_pack"],
          },
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.deepEqual(
      (config.servers.tokenlean as StdioServerConfig).alwaysLoad,
      ["tl_symbols", "tl_pack"]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("alwaysLoad sets _meta anthropic/alwaysLoad on matching tools", () => {
  const upstream = createMockUpstream([
    { server: "tokenlean", tool: mockTool("tl_symbols", "Find symbols") },
    { server: "tokenlean", tool: mockTool("tl_run", "Run command") },
    { server: "tokenlean", tool: mockTool("tl_pack", "Pack context") },
  ]) as unknown as UpstreamManager;
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {
        tokenlean: {
          command: "tokenlean-mcp",
          alwaysLoad: ["tl_symbols", "tl_pack"],
        },
      },
    },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  const tools = (listener as any).currentTools() as Tool[];
  const symbols = tools.find((t) => t.name === "tl_symbols")!;
  const run = tools.find((t) => t.name === "tl_run")!;
  const pack = tools.find((t) => t.name === "tl_pack")!;

  assert.equal(symbols._meta?.["anthropic/alwaysLoad"], true);
  assert.equal(pack._meta?.["anthropic/alwaysLoad"], true);
  assert.equal(run._meta?.["anthropic/alwaysLoad"], undefined);
});

test("alwaysLoad preserves existing _meta fields on tools", () => {
  const toolWithMeta: Tool = {
    name: "tl_symbols",
    description: "Find symbols",
    inputSchema: { type: "object" },
    _meta: { "custom/flag": "hello" },
  };
  const upstream = createMockUpstream([
    { server: "tokenlean", tool: toolWithMeta },
  ]) as unknown as UpstreamManager;
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {
        tokenlean: {
          command: "tokenlean-mcp",
          alwaysLoad: ["tl_symbols"],
        },
      },
    },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  const tools = (listener as any).currentTools() as Tool[];
  const symbols = tools.find((t) => t.name === "tl_symbols")!;
  assert.equal(symbols._meta?.["anthropic/alwaysLoad"], true);
  assert.equal(symbols._meta?.["custom/flag"], "hello");
});

test("loadConfig parses per-server prefix override including empty string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-prefix-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          tokenlean: { command: "tokenlean-mcp", prefix: "" },
          github: { command: "gh-mcp", prefix: "gh" },
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.equal((config.servers.tokenlean as StdioServerConfig).prefix, "");
    assert.equal((config.servers.github as StdioServerConfig).prefix, "gh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects prefixes with non-identifier characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-prefix-bad-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({ servers: { x: { command: "x", prefix: "no spaces" } } })
    );
    await assert.rejects(
      loadConfig(configPath),
      /prefix must contain only letters, digits, and underscores/
    );

    await writeFile(
      configPath,
      JSON.stringify({ servers: { x: { command: "x", prefix: 5 } } })
    );
    await assert.rejects(loadConfig(configPath), /prefix must be a string/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("per-server prefix shortens and drops flattened tool names", async () => {
  const upstream = new UpstreamManager();
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    const toolName = name === "tokenlean" ? "tl_diff" : "search_code";
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
    tokenlean: { command: "tokenlean-mcp", prefix: "" },
    github: { command: "gh-mcp", prefix: "gh" },
  });

  const names = upstream.getTools().map((t) => t.qualifiedName).sort();
  assert.deepEqual(names, ["gh__search_code", "tl_diff"]);

  // Emitted (aliased) names resolve.
  assert.deepEqual((await upstream.callTool("tl_diff")).content, [
    { type: "text", text: "tokenlean:tl_diff" },
  ]);
  assert.deepEqual((await upstream.callTool("gh__search_code")).content, [
    { type: "text", text: "github:search_code" },
  ]);
  // Original server-name-qualified form still resolves (forgiving fallback).
  assert.deepEqual((await upstream.callTool("github__search_code")).content, [
    { type: "text", text: "github:search_code" },
  ]);
});

test("colliding dropped prefixes fall back to full server names", async () => {
  const upstream = new UpstreamManager();
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    const tool = mockTool("status");
    return {
      name,
      config,
      client: {
        async callTool() {
          return textResult(`${name}:status`);
        },
        async close() {},
      },
      transport: { async close() {} },
      allTools: [tool],
      tools: [tool],
    };
  };

  await upstream.connect({
    alpha: { command: "alpha", prefix: "" },
    beta: { command: "beta", prefix: "" },
  });

  // Both wanted bare "status"; collision forces both back to full prefixes.
  const names = upstream.getTools().map((t) => t.qualifiedName).sort();
  assert.deepEqual(names, ["alpha__status", "beta__status"]);

  assert.deepEqual((await upstream.callTool("alpha__status")).content, [
    { type: "text", text: "alpha:status" },
  ]);
});

test("prefix alias cannot bypass an authorization rule on the real server name", async () => {
  const upstream = new UpstreamManager();
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };

  harness.connectOne = async (name: string, config: ServerConfig) => {
    const toolName = name === "github" ? "search_code" : "ping";
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
    github: { command: "gh-mcp", prefix: "gh" },
    other: { command: "other-mcp" },
  });

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {
        github: { command: "gh-mcp", prefix: "gh" },
        other: { command: "other-mcp" },
      },
      authorization: {
        defaultEffect: "allow",
        rules: [
          {
            id: "deny-search",
            effect: "deny",
            tools: ["github__search_code"],
          },
        ],
      },
    },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  const principal = { kind: "bearer", id: "ops", scopes: [], groups: [] };
  // The aliased name must canonicalize to github__search_code and be denied.
  const aliased = (listener as any).authorizeToolCall("gh__search_code", {}, principal);
  assert.equal(aliased.allowed, false);
  // The original qualified form is denied too.
  const original = (listener as any).authorizeToolCall("github__search_code", {}, principal);
  assert.equal(original.allowed, false);
  // An unrelated tool stays allowed.
  const allowed = (listener as any).authorizeToolCall("other__ping", {}, principal);
  assert.equal(allowed.allowed, true);
});

test("loadConfig parses startup timeout settings from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-timeout-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"], callTimeoutMs: 3000 } },
        connectTimeoutMs: 1000,
        callTimeoutMs: 2000,
        sessionCwdIdleTtlSeconds: 300,
        strictStartup: true,
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.connectTimeoutMs, 1000);
    assert.equal(config.callTimeoutMs, 2000);
    assert.equal((config.servers.github as StdioServerConfig).callTimeoutMs, 3000);
    assert.equal(config.sessionCwdIdleTtlSeconds, 300);
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

test("loadConfig parses response shield settings from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-response-shield-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: {
            command: "node",
            args: ["server.js"],
            responseShield: {
              enabled: false,
              denyTools: ["get_secret"],
            },
          },
        },
        responseShield: {
          enabled: true,
          maxResultBytes: 1000,
          maxStringChars: 200,
          maxArrayItems: 10,
          maxStoredResults: 5,
          allowTools: ["get_*", "list_*"],
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.responseShield?.enabled, true);
    assert.equal(config.responseShield?.maxResultBytes, 1000);
    assert.equal(config.responseShield?.maxStringChars, 200);
    assert.equal(config.responseShield?.maxArrayItems, 10);
    assert.equal(config.responseShield?.maxStoredResults, 5);
    assert.deepEqual(config.responseShield?.allowTools, ["get_*", "list_*"]);
    assert.equal(
      (config.servers.github as StdioServerConfig).responseShield?.enabled,
      false
    );
    assert.deepEqual(
      (config.servers.github as StdioServerConfig).responseShield?.denyTools,
      ["get_secret"]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses dashboard settings from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-dashboard-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {},
        dashboard: {
          enabled: true,
          path: "ops",
          maxEvents: 25,
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.equal(config.dashboard?.enabled, true);
    assert.equal(config.dashboard?.path, "/ops");
    assert.equal(config.dashboard?.maxEvents, 25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects per-server response shield maxStoredResults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-response-shield-invalid-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          github: {
            command: "node",
            args: ["server.js"],
            responseShield: { maxStoredResults: 5 },
          },
        },
      })
    );

    await assert.rejects(
      () => loadConfig(configPath),
      /maxStoredResults is only supported in global responseShield/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses stdio cwdMode from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-cwd-mode-"));
  const configPath = join(dir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          tokenlean: { command: "tokenlean-mcp", cwdMode: "session" },
          github: { command: "github-mcp", cwdMode: "global" },
        },
      })
    );

    const config = await loadConfig(configPath);
    assert.equal((config.servers.tokenlean as StdioServerConfig).cwdMode, "session");
    assert.equal((config.servers.github as StdioServerConfig).cwdMode, "global");
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

test("loadConfig rejects a document with both servers and mcpServers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-both-keys-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { a: { command: "node", args: ["a.js"] } },
        mcpServers: { b: { command: "node", args: ["b.js"] } },
      })
    );
    await assert.rejects(loadConfig(configPath), /not both/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects oidc_jwt jwksUri over plaintext http", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-jwks-http-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        auth: {
          mode: "oidc_jwt",
          issuer: "https://id.example.com",
          audience: "callmux",
          jwksUri: "http://id.example.com/jwks.json",
        },
      })
    );
    await assert.rejects(loadConfig(configPath), /jwksUri must use https/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig allows insecure jwksUri for localhost and via explicit override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-jwks-local-"));
  try {
    const localhostPath = join(dir, "localhost.json");
    await writeFile(
      localhostPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        auth: {
          mode: "oidc_jwt",
          issuer: "https://id.example.com",
          audience: "callmux",
          jwksUri: "http://localhost:8080/jwks.json",
        },
      })
    );
    const localhostConfig = await loadConfig(localhostPath);
    assert.equal(localhostConfig.auth?.mode, "oidc_jwt");

    const overridePath = join(dir, "override.json");
    await writeFile(
      overridePath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        auth: {
          mode: "oidc_jwt",
          issuer: "https://id.example.com",
          audience: "callmux",
          jwksUri: "http://internal.lan/jwks.json",
          allowInsecureJwksUri: true,
        },
      })
    );
    const overrideConfig = await loadConfig(overridePath);
    assert.equal(overrideConfig.auth?.mode, "oidc_jwt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig resolves bearer tokenRef from a file: secret reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-secret-file-"));
  try {
    const secretPath = join(dir, "token.txt");
    await writeFile(secretPath, "  s3cr3t-token\n");
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        auth: {
          mode: "bearer",
          tokens: [{ id: "ops", tokenRef: "file:token.txt" }],
        },
      })
    );
    const config = await loadConfig(configPath);
    assert.equal(config.auth?.mode, "bearer");
    // Plaintext tokenRef is hashed on load; the raw value must not leak.
    const token = config.auth?.mode === "bearer" ? config.auth.tokens[0] : undefined;
    assert.equal(token?.id, "ops");
    assert.ok(token && "hash" in token && typeof token.hash === "string");
    assert.ok(!JSON.stringify(config.auth).includes("s3cr3t-token"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig surfaces a clear error for a missing file: secret reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-secret-missing-"));
  try {
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        servers: { github: { command: "node", args: ["server.js"] } },
        auth: {
          mode: "bearer",
          tokens: [{ id: "ops", tokenRef: "file:does-not-exist.txt" }],
        },
      })
    );
    await assert.rejects(loadConfig(configPath), /could not read secret file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OidcJwtVerifier rejects an oversized JWKS response body", async () => {
  const key = createJwtKeyPair("cap-key");
  // Serve a multi-megabyte JWKS body that nonetheless contains the real key.
  const filler = "x".repeat(2_000_000);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [key.jwk], filler }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const verifier = new OidcJwtVerifier({
      mode: "oidc_jwt",
      issuer: "https://id.example.com",
      audience: "callmux",
      jwksUri: `http://127.0.0.1:${address.port}/jwks`,
      algorithms: ["RS256"],
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signJwtRs256(key, {
      iss: "https://id.example.com",
      aud: "callmux",
      sub: "user-1",
      iat: now,
      exp: now + 600,
    });
    // The key is present, but the body exceeds the cap, so it can't be loaded.
    assert.equal(await verifier.verify(token), undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OidcJwtVerifier accepts a normal-sized JWKS response body", async () => {
  const key = createJwtKeyPair("ok-key");
  const jwks = await startJwksServer([key.jwk]);
  try {
    const verifier = new OidcJwtVerifier({
      mode: "oidc_jwt",
      issuer: "https://id.example.com",
      audience: "callmux",
      jwksUri: jwks.url,
      algorithms: ["RS256"],
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signJwtRs256(key, {
      iss: "https://id.example.com",
      aud: "callmux",
      sub: "user-1",
      iat: now,
      exp: now + 600,
    });
    const principal = await verifier.verify(token);
    assert.ok(principal);
  } finally {
    await jwks.close();
  }
});

test("AbuseController refunds the global slot when a principal-rate check denies", () => {
  const controller = new AbuseController({
    globalRequestsPerMinute: 2,
    principalRequestsPerMinute: 1,
  });
  const principal = (id: string) => ({
    kind: "bearer" as const,
    id,
    scopes: [],
    groups: [],
  });

  // A consumes 1 global + 1 principal.
  assert.equal(controller.acquire(principal("a")).result.allowed, true);
  // A again: denied by its own per-principal limit; global must be refunded.
  assert.equal(controller.acquire(principal("a")).result.allowed, false);
  // With the refund, B and C should still fit the global budget of 2.
  assert.equal(controller.acquire(principal("b")).result.allowed, true);
  // Now global is genuinely exhausted (a + b = 2).
  assert.equal(controller.acquire(principal("c")).result.code, "abuse_rate_limit");
});

test("PrometheusMetrics escapes newlines in label values", () => {
  const metrics = new PrometheusMetrics({ enabled: true });
  metrics.onRequestStart();
  metrics.onRequestComplete({
    method: "GET",
    path: "/foo\ninjected_metric 1",
    status: 200,
    durationMs: 5,
  });
  const text = metrics.renderPrometheusText();
  // The injected newline must be escaped so it can't forge a metric line.
  assert.ok(!text.includes("\ninjected_metric 1"));
  assert.ok(text.includes("\\ninjected_metric 1"));
});

test("VERSION matches package.json", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf-8")
  ) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
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

  const result = await handlePipeline(upstream as never, new CallCache(0), {
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

  const result = await handlePipeline(upstream as never, new CallCache(0), {
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

  const result = await handlePipeline(upstream as never, new CallCache(0), {
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

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", arguments: { fallback: "default" }, inputMapping: { missing: "$json.user.address.city" } },
    ],
  });

  assert.equal(capturedArgs.missing, undefined);
  assert.equal(capturedArgs.fallback, "default");

  const content = result.structuredContent as {
    steps: Array<{
      skippedMappings?: Array<{ argument: string; expression: string; reason: string }>;
    }>;
  };
  assert.deepEqual(content.steps[1].skippedMappings, [
    {
      argument: "missing",
      expression: "$json.user.address.city",
      reason: "path_not_found",
    },
  ]);
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

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      { tool: "step2", arguments: { keep: "this" }, inputMapping: { data: "$json" } },
    ],
  });

  assert.equal(capturedArgs.data, undefined);
  assert.equal(capturedArgs.keep, "this");

  const content = result.structuredContent as {
    steps: Array<{
      skippedMappings?: Array<{ argument: string; expression: string; reason: string }>;
    }>;
  };
  assert.deepEqual(content.steps[1].skippedMappings, [
    {
      argument: "data",
      expression: "$json",
      reason: "previous_result_not_json",
    },
  ]);
});

test("pipeline onMappingMissing fail stops before executing step", async () => {
  const calledTools: string[] = [];
  const upstream = {
    async callTool(tool: string) {
      calledTools.push(tool);
      if (tool === "step1") return textResult(JSON.stringify({ user: { name: "Edin" } }));
      return textResult("should not run");
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      {
        tool: "step2",
        inputMapping: { issue_number: "$json.issue.number" },
        onMappingMissing: "fail",
      },
    ],
  });

  assert.deepEqual(calledTools, ["step1"]);
  const content = result.structuredContent as {
    status: string;
    failedStep?: number;
    steps: Array<{
      error?: string;
      skippedMappings?: Array<{ argument: string; expression: string; reason: string }>;
    }>;
  };
  assert.equal(content.status, "failed");
  assert.equal(content.failedStep, 1);
  assert.equal(content.steps[1].error, "required inputMapping failed");
  assert.deepEqual(content.steps[1].skippedMappings, [
    {
      argument: "issue_number",
      expression: "$json.issue.number",
      reason: "path_not_found",
    },
  ]);
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

test("meta tools pass timeoutMs and cwd overrides to upstream calls", async () => {
  const observed: Array<{ timeoutMs?: number; cwd?: string }> = [];
  const upstream = {
    resolveServer() {
      return { server: "github", actualName: "get_issue" };
    },
    getServerConcurrency() {
      return undefined;
    },
    getServerNames() {
      return ["github"];
    },
    getServerTools() {
      return ["get_issue"];
    },
    async prepareToolCall(tool: string, args?: Record<string, unknown>, server?: string) {
      return {
        server: server ?? "github",
        actualName: tool,
        resolvedArguments: args,
      };
    },
    async callTool(
      _tool: string,
      _args?: Record<string, unknown>,
      _server?: string,
      context?: { timeoutMs?: number; cwd?: string }
    ) {
      observed.push({
        ...(context?.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
        ...(context?.cwd !== undefined ? { cwd: context.cwd } : {}),
      });
      return textResult("ok");
    },
  };
  const cache = new CallCache(0);

  await handleCall(upstream as never, cache, {
    server: "github",
    tool: "get_issue",
    arguments: { id: 1 },
    timeoutMs: 1_000,
    cwd: "/tmp/callmux-one",
  });
  await handleParallel(upstream as never, cache, {
    calls: [{
      server: "github",
      tool: "get_issue",
      arguments: { id: 2 },
      timeoutMs: 2_000,
      cwd: "/tmp/callmux-two",
    }],
  }, 1);
  await handleBatch(upstream as never, cache, {
    server: "github",
    tool: "get_issue",
    timeoutMs: 3_000,
    cwd: "/tmp/callmux-three",
    items: [
      { arguments: { id: 3 } },
      { arguments: { id: 4 }, timeoutMs: 4_000, cwd: "/tmp/callmux-four" },
    ],
  }, 1);
  await handlePipeline(upstream as never, cache, {
    steps: [{
      server: "github",
      tool: "get_issue",
      arguments: { id: 5 },
      timeoutMs: 5_000,
      cwd: "/tmp/callmux-five",
    }],
  });

  assert.deepEqual(observed, [
    { timeoutMs: 1_000, cwd: "/tmp/callmux-one" },
    { timeoutMs: 2_000, cwd: "/tmp/callmux-two" },
    { timeoutMs: 3_000, cwd: "/tmp/callmux-three" },
    { timeoutMs: 4_000, cwd: "/tmp/callmux-four" },
    { timeoutMs: 5_000, cwd: "/tmp/callmux-five" },
  ]);
});

test("meta tool cwd overrides partition cached session-cwd calls", async () => {
  const observedCwds: string[] = [];
  const upstream = {
    resolveServer() {
      return { server: "github", actualName: "get_issue" };
    },
    getServerNames() {
      return ["github"];
    },
    getServerTools() {
      return ["get_issue"];
    },
    cacheScopeForCall(_tool: string, _server?: string, context?: { cwd?: string }) {
      return context?.cwd;
    },
    async callTool(
      _tool: string,
      _args?: Record<string, unknown>,
      _server?: string,
      context?: { cwd?: string }
    ) {
      observedCwds.push(context?.cwd ?? "");
      return textResult(JSON.stringify({ cwd: context?.cwd }));
    },
  };

  const cache = new CallCache(60);
  await handleCall(upstream as never, cache, {
    server: "github",
    tool: "get_issue",
    arguments: { id: 1 },
    cwd: "/tmp/callmux-cache-a",
  });
  await handleCall(upstream as never, cache, {
    server: "github",
    tool: "get_issue",
    arguments: { id: 1 },
    cwd: "/tmp/callmux-cache-b",
  });

  assert.deepEqual(observedCwds, ["/tmp/callmux-cache-a", "/tmp/callmux-cache-b"]);
});

test("meta tool cwd overrides must be absolute paths", async () => {
  const upstream = {
    resolveServer() {
      return { server: "github", actualName: "get_issue" };
    },
    getServerNames() {
      return ["github"];
    },
    getServerTools() {
      return ["get_issue"];
    },
  };

  const result = await handleCall(upstream as never, new CallCache(0), {
    server: "github",
    tool: "get_issue",
    cwd: "relative/project",
  });

  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /cwd must be an absolute path/);
});

test("stdio bridge derives meta-call request timeout from child timeouts", () => {
  assert.deepEqual(
    deriveBridgeCallOptions(
      "callmux_parallel",
      {
        calls: [
          { tool: "short", timeoutMs: 1_000 },
          { tool: "long", timeoutMs: 300_000 },
        ],
      },
      180_000
    ),
    { timeout: 306_000 }
  );

  assert.deepEqual(
    deriveBridgeCallOptions(
      "callmux_batch",
      {
        tool: "get_issue",
        timeoutMs: 10_000,
        items: [
          { arguments: { id: 1 } },
          { arguments: { id: 2 }, timeoutMs: 20_000 },
        ],
      },
      5_000
    ),
    { timeout: 35_000 }
  );

  assert.deepEqual(
    deriveBridgeCallOptions(
      "callmux_pipeline",
      {
        steps: [
          { tool: "search", timeoutMs: 30_000 },
          { tool: "read" },
        ],
      },
      60_000
    ),
    { timeout: 95_000 }
  );

  assert.deepEqual(
    deriveBridgeCallOptions("get_issue", { id: 1 }, 180_000),
    { timeout: 180_000 }
  );
});

test("listener derives parallel timeout budget from queued child waves", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]) as unknown as UpstreamManager;
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      callTimeoutMs: 180_000,
      servers: { github: { command: "ignored" } },
    },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 1,
  });

  const budget = (listener as unknown as {
    toolCallTimeoutBudgetMs: (tool: string, args: unknown) => number | undefined;
  }).toolCallTimeoutBudgetMs("callmux_parallel", {
    calls: [
      { server: "github", tool: "get_issue", timeoutMs: 1_000 },
      { server: "github", tool: "get_issue", timeoutMs: 300_000 },
    ],
  });

  assert.equal(budget, 301_000);
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
    status: string;
    failedStep: number;
  };

  assert.equal(content.status, "failed");
  assert.equal(content.failedStep, 1);
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
    status: string;
    failedStep: number;
  };

  assert.equal(content.status, "failed");
  assert.equal(content.failedStep, 1);
  assert.equal(content.steps.length, 2);
  assert.equal(content.steps[1].error, "connection refused");
});

test("pipeline failure includes mapped arguments for recovery", async () => {
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      if (tool === "step1") {
        return textResult(JSON.stringify({ issue: { number: 42 } }));
      }
      if (tool === "step2") {
        assert.deepEqual(args, { owner: "edimuj", issue_number: 42 });
        return { content: [{ type: "text" as const, text: "missing repo" }], isError: true };
      }
      return textResult("should not reach");
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "step1" },
      {
        tool: "step2",
        arguments: { owner: "edimuj" },
        inputMapping: { issue_number: "$json.issue.number" },
      },
      { tool: "step3" },
    ],
  });

  const content = result.structuredContent as {
    status: string;
    failedStep: number;
    steps: Array<{
      tool: string;
      mappedArguments?: Record<string, unknown>;
      result?: { isError?: boolean };
    }>;
  };

  assert.equal(content.status, "failed");
  assert.equal(content.failedStep, 1);
  assert.equal(content.steps.length, 2);
  assert.deepEqual(content.steps[1].mappedArguments, { issue_number: 42 });
  assert.equal(content.steps[1].result?.isError, true);
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
    status: string;
  };

  assert.equal(content.status, "completed");
  assert.equal(content.steps.length, 2);
  assert.ok(content.finalResult);
});

// ─── Parallel mixed results tests ────────────────────────────

test("parallel reports partial status, counts, and failed indexes", async () => {
  const upstream = {
    async callTool(tool: string) {
      if (tool === "bad_result") {
        return { content: [{ type: "text" as const, text: "downstream error" }], isError: true };
      }
      if (tool === "bad_throw") {
        throw new Error("connection refused");
      }
      return textResult(`ok-${tool}`);
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleParallel(upstream as never, new CallCache(0), {
    calls: [
      { tool: "good_one" },
      { tool: "bad_result" },
      { tool: "good_two" },
      { tool: "bad_throw" },
    ],
  }, 4);

  const content = result.structuredContent as {
    status: string;
    succeeded: number;
    failed: number;
    failedIndexes: number[];
    results: Array<{ result?: { isError?: boolean }; error?: string }>;
  };

  assert.equal(content.status, "partial");
  assert.equal(content.succeeded, 2);
  assert.equal(content.failed, 2);
  assert.deepEqual(content.failedIndexes, [1, 3]);
  assert.equal(content.results[1].result?.isError, true);
  assert.equal(content.results[3].error, "connection refused");
});

test("parallel with all calls succeeding reports completed status", async () => {
  const upstream = {
    async callTool(tool: string) {
      return textResult(`done-${tool}`);
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleParallel(upstream as never, new CallCache(0), {
    calls: [
      { tool: "one" },
      { tool: "two" },
    ],
  }, 4);

  const content = result.structuredContent as {
    status: string;
    succeeded: number;
    failed: number;
    failedIndexes: number[];
  };

  assert.equal(content.status, "completed");
  assert.equal(content.succeeded, 2);
  assert.equal(content.failed, 0);
  assert.deepEqual(content.failedIndexes, []);
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
    status: string;
    succeeded: number;
    failed: number;
    failedIndexes: number[];
    results: Array<{ index: number; result?: CallToolResult; error?: string }>;
  };

  assert.equal(content.status, "partial");
  assert.equal(content.succeeded, 3);
  assert.equal(content.failed, 2);
  assert.deepEqual(content.failedIndexes, [1, 3]);
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

  const content = result.structuredContent as {
    status: string;
    succeeded: number;
    failed: number;
    failedIndexes: number[];
  };
  assert.equal(content.status, "completed");
  assert.equal(content.succeeded, 2);
  assert.equal(content.failed, 0);
  assert.deepEqual(content.failedIndexes, []);
});

test("batch auto-wraps flat items missing the {arguments} wrapper", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const upstream = {
    async callTool(_tool: string, args?: Record<string, unknown>) {
      seen.push(args ?? {});
      return textResult("ok");
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "write_node",
    items: [
      { story: "s1", nodeId: "n1", messages: ["a"] },
      { story: "s2", nodeId: "n2", messages: ["b"] },
    ],
  }, 4);

  const content = result.structuredContent as {
    status: string;
    succeeded: number;
    warnings?: Array<{ code: string; message: string }>;
  };

  // Both items executed with their flat keys lifted into arguments.
  assert.equal(content.status, "completed");
  assert.equal(content.succeeded, 2);
  assert.deepEqual(seen, [
    { story: "s1", nodeId: "n1", messages: ["a"] },
    { story: "s2", nodeId: "n2", messages: ["b"] },
  ]);

  // A one-line warning teaches the canonical shape.
  assert.ok(content.warnings?.some((w) => w.code === "auto_wrapped_flat_items"));
});

test("batch auto-wrap keeps reserved cwd/timeoutMs at the item level", async () => {
  let seenArgs: Record<string, unknown> | undefined;
  let seenCwd: string | undefined;
  const upstream = {
    async callTool(
      _tool: string,
      args?: Record<string, unknown>,
      _server?: string,
      ctx?: { cwd?: string },
    ) {
      seenArgs = args;
      seenCwd = ctx?.cwd;
      return textResult("ok");
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "run_thing",
    items: [
      { path: "/tmp/x", flag: true, cwd: "/repo", timeoutMs: 5000 },
    ],
  }, 1);

  const content = result.structuredContent as { status: string };
  assert.equal(content.status, "completed");
  // cwd/timeoutMs are stripped from arguments and honored as per-item overrides.
  assert.deepEqual(seenArgs, { path: "/tmp/x", flag: true });
  assert.equal(seenCwd, "/repo");
});

test("batch does not auto-wrap items that already have an arguments key", async () => {
  let seenArgs: Record<string, unknown> | undefined;
  const upstream = {
    async callTool(_tool: string, args?: Record<string, unknown>) {
      seenArgs = args;
      return textResult("ok");
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleBatch(upstream as never, new CallCache(0), {
    tool: "write_node",
    items: [
      { arguments: { id: 1 } },
    ],
  }, 1);

  const content = result.structuredContent as {
    status: string;
    warnings?: Array<{ code: string }>;
  };
  assert.equal(content.status, "completed");
  assert.deepEqual(seenArgs, { id: 1 });
  assert.ok(!content.warnings?.some((w) => w.code === "auto_wrapped_flat_items"));
});

test("parallel auto-wraps flat calls missing the {arguments} wrapper", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const upstream = {
    async callTool(_tool: string, args?: Record<string, unknown>) {
      seen.push(args ?? {});
      return textResult("ok");
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleParallel(upstream as never, new CallCache(0), {
    calls: [
      { tool: "search", query: "foo", limit: 5 },
      { tool: "search", arguments: { query: "bar" } },
    ],
  }, 4);

  const content = result.structuredContent as {
    status: string;
    warnings?: Array<{ code: string }>;
  };
  assert.equal(content.status, "completed");
  // Flat call lifted; canonical call untouched.
  assert.deepEqual(seen[0], { query: "foo", limit: 5 });
  assert.deepEqual(seen[1], { query: "bar" });
  assert.ok(content.warnings?.some((w) => w.code === "auto_wrapped_flat_calls"));
});

test("parallel does not wrap a bare {tool} call into empty arguments", async () => {
  let seenArgs: Record<string, unknown> | undefined = { sentinel: true };
  const upstream = {
    async callTool(_tool: string, args?: Record<string, unknown>) {
      seenArgs = args;
      return textResult("ok");
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleParallel(upstream as never, new CallCache(0), {
    calls: [{ tool: "ping" }],
  }, 1);

  const content = result.structuredContent as {
    status: string;
    warnings?: Array<{ code: string }>;
  };
  assert.equal(content.status, "completed");
  // No spurious empty-object wrap; the tool is called argument-less.
  assert.equal(seenArgs, undefined);
  assert.ok(!content.warnings?.some((w) => w.code === "auto_wrapped_flat_calls"));
});

test("pipeline auto-wraps a flat step but leaves mapping-only steps alone", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      seen.push(args ?? {});
      return tool === "fetch" ? textResult("payload") : textResult("done");
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    steps: [
      { tool: "fetch", url: "http://x", depth: 2 },
      { tool: "store", inputMapping: { body: "$text" } },
    ],
  });

  const content = result.structuredContent as {
    status: string;
    warnings?: Array<{ code: string }>;
  };
  assert.equal(content.status, "completed");
  // Step 1 flat keys lifted; step 2 carries only a mapping, so its args come
  // solely from inputMapping (no spurious wrap).
  assert.deepEqual(seen[0], { url: "http://x", depth: 2 });
  assert.deepEqual(seen[1], { body: "payload" });
  assert.ok(content.warnings?.some((w) => w.code === "auto_wrapped_flat_steps"));
});

test("handleCall auto-wraps a flat call missing the {arguments} wrapper", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("create_issue") },
  ]);

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "create_issue",
    title: "Bug",
    body: "Broken",
  });

  // The mock client echoes the arguments it actually received; the flat fields
  // must arrive as the tool's arguments object end-to-end.
  assert.equal(result.isError, undefined);
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /"title":"Bug"/);
  assert.match(text, /"body":"Broken"/);
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

test("proxy applies configured outputFormat to meta-tool text", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
    outputFormat: "toon",
  });

  (proxy as unknown as { upstream: {
    callTool: () => Promise<CallToolResult>;
    getServerConcurrency: () => number | undefined;
  } }).upstream = {
    async callTool() {
      return textResult(JSON.stringify({ id: 1, title: "issue" }));
    },
    getServerConcurrency() { return undefined; },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_parallel", {
    calls: [{ tool: "get_issue", arguments: { id: 1 } }],
  });
  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.match(text, /results\[1\]/);
  assert.equal(result.structuredContent, undefined);
});

test("proxy explicit TOON batch result is text-first for MCP clients", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  (proxy as unknown as { upstream: {
    callTool: () => Promise<CallToolResult>;
    getServerConcurrency: () => number | undefined;
  } }).upstream = {
    async callTool() {
      return textResult(JSON.stringify({ id: 1, title: "issue" }));
    },
    getServerConcurrency() { return undefined; },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_batch", {
    tool: "get_issue",
    outputFormat: "toon",
    items: [{ arguments: { id: 1 } }],
  });

  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.match(text, /results\[1\]/);
  assert.equal(result.structuredContent, undefined);
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

test("proxy routes callmux_search_tools to handleSearchTools", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  (proxy as unknown as {
    upstream: UpstreamManager;
  }).upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue", "Get an issue") },
  ]) as unknown as UpstreamManager;

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_search_tools", {
    query: "issue",
  });

  const content = result.structuredContent as {
    results: Array<{ tool: string }>;
  };
  assert.equal(content.results[0].tool, "get_issue");
});

test("proxy shields large proxied results and pages stored refs", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  const largeItems = Array.from({ length: 120 }, (_, index) => ({
    id: index + 1,
    name: `item-${index + 1}`,
    body: "x".repeat(200),
  }));

  (proxy as unknown as {
    upstream: {
      callTool: () => Promise<CallToolResult>;
      getServerNames: () => string[];
      getServerTools: () => string[];
      getServerInfo: () => { transport: string; state: string; connectDurationMs: number; totalTools: number; exposedTools: number };
      getFailedServers: () => [];
    };
  }).upstream = {
    async callTool() {
      return textResult(JSON.stringify(largeItems));
    },
    getServerNames: () => ["default"],
    getServerTools: () => ["large_list"],
    getServerInfo: () => ({ transport: "stdio", state: "connected", connectDurationMs: 1, totalTools: 1, exposedTools: 1 }),
    getFailedServers: () => [],
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const shielded = await harness.handleToolCall("large_list", {});
  assert.equal(shielded.isError, undefined);
  const shieldedContent = shielded.structuredContent as {
    _callmux: {
      truncated: boolean;
      ref: string;
      originalBytes: number;
      shape: { type: string; total: number; sampleKeys: string[] };
      retrieval: {
        tool: string;
        arguments: { ref: string; offset: number; limit: number };
        viaCallmuxCall: {
          tool: string;
          arguments: {
            tool: string;
            arguments: { ref: string; offset: number; limit: number };
          };
        };
        supports: { fields: string; search: string };
      };
      message: string;
    };
  };
  assert.equal(shieldedContent._callmux.truncated, true);
  assert.match(shieldedContent._callmux.ref, /^r_/);
  assert.ok(shieldedContent._callmux.originalBytes > 8192);
  assert.equal(shieldedContent._callmux.shape.type, "array");
  assert.equal(shieldedContent._callmux.shape.total, 120);
  assert.deepEqual(shieldedContent._callmux.shape.sampleKeys, ["id", "name", "body"]);
  assert.equal(shieldedContent._callmux.retrieval.tool, "callmux_get_result");
  assert.deepEqual(shieldedContent._callmux.retrieval.arguments, {
    ref: shieldedContent._callmux.ref,
    offset: 0,
    limit: 50,
  });
  assert.equal(
    shieldedContent._callmux.retrieval.viaCallmuxCall.tool,
    "callmux_call"
  );
  assert.deepEqual(shieldedContent._callmux.retrieval.viaCallmuxCall.arguments, {
    tool: "callmux_get_result",
    arguments: {
      ref: shieldedContent._callmux.ref,
      offset: 0,
      limit: 50,
    },
  });
  assert.match(shieldedContent._callmux.retrieval.supports.fields, /projection/);
  assert.match(shieldedContent._callmux.retrieval.supports.search, /filter/);
  assert.match(shieldedContent._callmux.message, /viaCallmuxCall/);

  const page = await harness.handleToolCall("callmux_get_result", {
    ref: shieldedContent._callmux.ref,
    limit: 3,
    fields: ["id"],
  });
  const pageContent = page.structuredContent as {
    type: string;
    total: number;
    count: number;
    hasMore: boolean;
    data: Array<{ id: number; body?: string }>;
  };
  assert.equal(pageContent.type, "array");
  assert.equal(pageContent.total, 120);
  assert.equal(pageContent.count, 3);
  assert.equal(pageContent.hasMore, true);
  assert.deepEqual(pageContent.data, [{ id: 1 }, { id: 2 }, { id: 3 }]);

  const toonPage = await harness.handleToolCall("callmux_get_result", {
    ref: shieldedContent._callmux.ref,
    limit: 3,
    fields: ["id"],
    outputFormat: "toon",
  });
  const toonPageText = toonPage.content[0].type === "text" ? toonPage.content[0].text : "";
  assert.match(toonPageText, /data\[3\]\{id\}:/);
  assert.equal(toonPage.structuredContent, undefined);

  const fallbackPage = await harness.handleToolCall("callmux_call", {
    tool: "callmux_get_result",
    arguments: {
      ref: shieldedContent._callmux.ref,
      offset: 3,
      limit: 2,
      fields: ["id"],
    },
  });
  const fallbackPageContent = fallbackPage.structuredContent as {
    type: string;
    offset: number;
    count: number;
    data: Array<{ id: number }>;
  };
  assert.equal(fallbackPageContent.type, "array");
  assert.equal(fallbackPageContent.offset, 3);
  assert.equal(fallbackPageContent.count, 2);
  assert.deepEqual(fallbackPageContent.data, [{ id: 4 }, { id: 5 }]);

  const status = await harness.handleToolCall("callmux_status", {});
  const statusContent = status.structuredContent as {
    responseStore: { entries: number; totalStored: number; storedBytes: number };
  };
  assert.equal(statusContent.responseStore.entries, 1);
  assert.equal(statusContent.responseStore.totalStored, 1);
  assert.ok(statusContent.responseStore.storedBytes > 0);
});

test("callmux_get_result reports missing refs", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
  });

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_get_result", {
    ref: "r_missing",
  });

  assert.equal(result.isError, true);
  assert.equal(
    (result.structuredContent as { error: { code: string } }).error.code,
    "result_not_found"
  );
});

test("responseShield can be disabled per server", async () => {
  const proxy = new CallmuxProxy({
    servers: {
      github: {
        command: "ignored",
        responseShield: { enabled: false },
      },
    },
  });

  const largeText = "x".repeat(100_000);
  (proxy as unknown as {
    upstream: {
      callTool: () => Promise<CallToolResult>;
      resolveServer: (tool: string) => { server: string; actualName: string } | null;
    };
  }).upstream = {
    async callTool() {
      return textResult(largeText);
    },
    resolveServer(tool: string) {
      return tool === "github__large_result"
        ? { server: "github", actualName: "large_result" }
        : null;
    },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("github__large_result", {});
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content[0].type === "text" ? result.content[0].text : "", largeText);
});

test("responseShield denyTools skips matching tools", async () => {
  const proxy = new CallmuxProxy({
    servers: {
      github: { command: "ignored" },
    },
    responseShield: {
      denyTools: ["github__large_result"],
    },
  });

  const largeText = "x".repeat(100_000);
  (proxy as unknown as {
    upstream: {
      callTool: () => Promise<CallToolResult>;
      resolveServer: (tool: string) => { server: string; actualName: string } | null;
    };
  }).upstream = {
    async callTool() {
      return textResult(largeText);
    },
    resolveServer(tool: string) {
      return tool === "github__large_result"
        ? { server: "github", actualName: "large_result" }
        : null;
    },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("github__large_result", {});
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content[0].type === "text" ? result.content[0].text : "", largeText);
});

test("proxy routes callmux_recipe_run to handleRecipeRun", async () => {
  const proxy = new CallmuxProxy({
    servers: { default: { command: "ignored" } },
    recipes: {
      get_one: {
        mode: "call",
        tool: "get_issue",
        arguments: { id: { $param: "id" } },
      },
    },
  });

  (proxy as unknown as {
    upstream: {
      callTool: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
      resolveServer: () => { server: string; actualName: string };
    }
  }).upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      return textResult(`${tool}:${JSON.stringify(args)}`);
    },
    resolveServer() { return { server: "default", actualName: "get_issue" }; },
  };

  const harness = proxy as unknown as {
    handleToolCall: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  };

  const result = await harness.handleToolCall("callmux_recipe_run", {
    recipe: "get_one",
    arguments: { id: 42 },
  });

  assert.equal(result.content[0].type === "text" ? result.content[0].text : "", 'get_issue:{"id":42}');
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

test("per-server cache policy applies to qualified passthrough tools", () => {
  const cache = new CallCache(
    60,
    undefined,
    { github: { allowTools: ["issue_read"] } }
  );

  cache.set("github__issue_read", { issue_number: 12 }, textResult("issue"));

  assert.deepEqual(
    cache.get("github__issue_read", { issue_number: 12 }),
    textResult("issue")
  );
  assert.equal(cache.size, 1);
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

test("JSON remains the default model-facing output format", async () => {
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

  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.doesNotThrow(() => JSON.parse(text));
});

test("parallel can render TOON text while preserving JSON structuredContent", async () => {
  const upstream = {
    async callTool() {
      return textResult(JSON.stringify({ id: 42, title: "test" }));
    },
    getServerConcurrency() { return undefined; },
  };

  const result = await handleParallel(upstream as never, new CallCache(0), {
    outputFormat: "toon",
    calls: [{ tool: "ms_get", arguments: { nodeId: "ch1_001" } }],
  }, 4);

  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.throws(() => JSON.parse(text));
  assert.match(text, /results\[1\]/);
  const content = result.structuredContent as {
    results: Array<{ result: { id: number; title: string } }>;
  };
  assert.deepEqual(content.results[0].result, { id: 42, title: "test" });
});

test("callmux_call formats raw downstream JSON text as TOON when requested", async () => {
  const upstream = {
    resolveServer() {
      return { server: "github", actualName: "list_issues" };
    },
    async prepareToolCall(
      tool: string,
      args?: Record<string, unknown>,
      server?: string
    ) {
      return { toolName: tool, actualName: tool, server: server ?? "github", resolvedArguments: args };
    },
    cacheScopeForCall() { return undefined; },
    getServerTools() { return ["list_issues"]; },
    getServerNames() { return ["github"]; },
    async callTool() {
      return textResult(JSON.stringify([
        { id: 1, title: "first" },
        { id: 2, title: "second" },
      ]));
    },
  };

  const result = await handleCall(upstream as never, new CallCache(0), {
    tool: "list_issues",
    outputFormat: "toon",
  });

  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.match(text, /\[2\]\{id,title\}:/);
  assert.equal(result.structuredContent, undefined);
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

test("pipeline JSON mapping still works when final text is TOON", async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const upstream = {
    async callTool(tool: string, args?: Record<string, unknown>) {
      calls.push(args);
      if (tool === "first") return textResult(JSON.stringify({ id: 42 }));
      return textResult(JSON.stringify({ received: args?.issueId }));
    },
  };

  const result = await handlePipeline(upstream as never, new CallCache(0), {
    outputFormat: "toon",
    steps: [
      { tool: "first" },
      {
        tool: "second",
        inputMapping: { issueId: "$json.id" },
        onMappingMissing: "fail",
      },
    ],
  });

  assert.deepEqual(calls[1], { issueId: 42 });
  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.throws(() => JSON.parse(text));
  const content = result.structuredContent as { finalResult: { received: number } };
  assert.deepEqual(content.finalResult, { received: 42 });
});

test("auto output format stays JSON for small or non-tabular payloads", () => {
  const text = formatToolText(
    { issue: { id: 1, title: "nested", labels: [{ name: "bug" }] } },
    { format: "auto" }
  );

  assert.doesNotThrow(() => JSON.parse(text));
});

test("auto output format uses TOON for large uniform tabular payloads", () => {
  const payload = {
    data: Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      title: `issue-${index + 1}`,
      state: "open",
    })),
  };
  const text = formatToolText(payload, { format: "auto" });

  assert.match(text, /data\[40\]\{id,title,state\}:/);
  assert.throws(() => JSON.parse(text));
});

test("TOON encoder failures fall back to JSON text", () => {
  const payload = { data: [{ id: 1, title: "issue" }] };
  const text = formatToolText(payload, {
    format: "toon",
    encoder: () => {
      throw new Error("encoder unavailable");
    },
  });

  assert.deepEqual(JSON.parse(text), payload);
});

test("errors stay JSON even when outputFormat requests TOON", async () => {
  const result = await handleBatch(
    {
      async callTool() {
        return textResult("ok");
      },
      getServerConcurrency() { return undefined; },
    } as never,
    new CallCache(0),
    { tool: "get_issue", items: [], outputFormat: "yaml" },
    4
  );

  assert.equal(result.isError, true);
  const text = result.content[0].type === "text" ? result.content[0].text : "";
  assert.doesNotThrow(() => JSON.parse(text));
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

import { CallmuxListener, readBody } from "./listener.js";

function listenerPort(listener: CallmuxListener): number {
  const address = (listener as any).httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("listener is not bound to a TCP port");
  }
  return address.port;
}

test("readBody rejects and removes listeners when request aborts mid-body", async () => {
  for (const eventName of ["aborted", "close"] as const) {
    const req = new EventEmitter() as IncomingMessage & EventEmitter & { complete: boolean };
    req.complete = false;

    const body = readBody(req);
    req.emit("data", Buffer.from("partial"));
    req.emit(eventName);

    await assert.rejects(body, { name: "RequestBodyAbortedError" });
    assert.equal(req.listenerCount("data"), 0);
    assert.equal(req.listenerCount("end"), 0);
    assert.equal(req.listenerCount("error"), 0);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(req.listenerCount("close"), 0);
  }
});

test("listener settles aborted /mcp body reads from real HTTP clients", async () => {
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

  await listener.start();
  try {
    const port = listenerPort(listener);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.write(
          "POST /mcp HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Content-Type: application/json\r\n" +
          "Accept: application/json, text/event-stream\r\n" +
          "Content-Length: 1000\r\n" +
          "\r\n" +
          "{\"jsonrpc\":\"2.0\""
        );
        setTimeout(() => socket.destroy(), 10);
      });
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });

    await waitFor(async () => {
      const events = (listener as any).runtimeEvents.list() as Array<{
        type: string;
        path?: string;
        status?: number;
      }>;
      return events.some((event) =>
        event.type === "http_request" &&
        event.path === "/mcp" &&
        event.status === 499
      );
    }, 1000, 10);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  } finally {
    await listener.close();
  }
});

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

test("listener applyReloadedState swaps structural listener state", () => {
  const upstreamA = new UpstreamManager();
  const upstreamB = new UpstreamManager();
  const cacheA = new CallCache(0, undefined, {}, 100);
  const cacheB = new CallCache(30, undefined, {}, 50);
  const responseStore = createResponseStore({
    servers: {},
    responseShield: { maxStoredResults: 4 },
  });
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {}, maxConcurrency: 10 },
    upstream: upstreamA,
    cache: cacheA,
    responseStore,
    allTools: [
      { name: "old_tool", description: "Old tool", inputSchema: { type: "object" } },
    ],
    maxConcurrency: 10,
  });

  listener.applyReloadedState({
    config: {
      servers: {},
      maxConcurrency: 3,
      metaOnly: true,
      descriptionMaxLength: 12,
      responseShield: { maxStoredResults: 2 },
    },
    upstream: upstreamB,
    cache: cacheB,
    allTools: [
      { name: "new_tool", description: "New tool", inputSchema: { type: "object" } },
    ],
    maxConcurrency: 3,
  });

  const internals = listener as unknown as {
    options: {
      config: { metaOnly?: boolean; descriptionMaxLength?: number };
      upstream: UpstreamManager;
      cache: CallCache;
      allTools: Tool[];
      maxConcurrency: number;
      responseStore: unknown;
    };
    responseStore: unknown;
  };
  assert.equal(internals.options.upstream, upstreamB);
  assert.equal(internals.options.cache, cacheB);
  assert.equal(internals.options.responseStore, responseStore);
  assert.equal(internals.responseStore, responseStore);
  assert.equal(responseStore.stats().maxEntries, 2);
  assert.equal(internals.options.allTools[0].name, "new_tool");
  assert.equal(internals.options.maxConcurrency, 3);
  assert.equal(internals.options.config.metaOnly, true);
  assert.equal(internals.options.config.descriptionMaxLength, 12);

  listener.recordConfigReload({ ok: false, error: "bad config" });
  let diagnostics = listener.getRuntimeDiagnostics();
  assert.ok(diagnostics.configReload?.lastReloadAt);
  assert.equal(diagnostics.configReload?.lastReloadError, "bad config");

  listener.recordConfigReload({ ok: true });
  diagnostics = listener.getRuntimeDiagnostics();
  assert.ok(diagnostics.configReload?.lastReloadAt);
  assert.equal(diagnostics.configReload?.lastReloadError, undefined);
});

test("standalone listener hot-reloads config file changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-hot-reload-"));
  const configPath = join(dir, "callmux.json");
  const port = await getFreePort();
  const fixture = join(process.cwd(), "dist-test", "test-fixtures", "fake-mcp-server.js");

  const writeConfig = async (toolName: string) => {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          fake: {
            command: process.execPath,
            args: [fixture],
            env: {
              FAKE_MCP_NAME: "fake",
              FAKE_MCP_TOOLS: JSON.stringify([
                { name: toolName, description: `Tool ${toolName}` },
              ]),
            },
          },
        },
        strictStartup: true,
      })
    );
  };

  await writeConfig("old_tool");
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist-test", "bin", "callmux.js"),
      "--config",
      configPath,
      "--listen",
      String(port),
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const mcpHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };

  const initialize = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      }),
    });
    assert.equal(res.status, 200);
    const sessionId = res.headers.get("mcp-session-id");
    assert.ok(sessionId);
    return sessionId;
  };

  const listTools = async (sessionId: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    assert.equal(res.status, 200);
    const body = await parseMcpResponseBody(res);
    return body.result.tools as Tool[];
  };

  const callStatus = async (sessionId: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "callmux_status",
          arguments: { sessions: true, recommendations: false },
        },
        id: 3,
      }),
    });
    assert.equal(res.status, 200);
    const body = await parseMcpResponseBody(res);
    return JSON.parse(body.result.content[0].text) as {
      listener?: { configReload?: { lastReloadAt?: string; lastReloadError?: string } };
    };
  };

  try {
    await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.status === 200;
    });
    const sessionId = await initialize();
    assert.ok((await listTools(sessionId)).some((tool) => tool.name === "old_tool"));

    await writeConfig("new_tool");
    await waitFor(async () =>
      (await listTools(sessionId)).some((tool) => tool.name === "new_tool")
    );

    const status = await callStatus(sessionId);
    assert.ok(status.listener?.configReload?.lastReloadAt);
    assert.equal(status.listener?.configReload?.lastReloadError, undefined);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    await rm(dir, { recursive: true, force: true });
  }

  assert.match(stderr, /Watching config for hot reload/);
  assert.match(stderr, /Reloaded config from/);
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

test("listener close is bounded for stuck sessions and active HTTP connections", async () => {
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
  let forcedConnectionsClosed = false;
  const internals = listener as unknown as {
    sessions: Map<string, {
      transport: { close?: () => Promise<void> };
      server: { close: () => Promise<void> };
    }>;
    httpServer: {
      close: (callback: () => void) => void;
      closeIdleConnections: () => void;
      closeAllConnections: () => void;
    };
  };
  internals.sessions.set("stuck", {
    transport: {
      async close() {
        await new Promise(() => {});
      },
    },
    server: {
      async close() {
        await new Promise(() => {});
      },
    },
  });
  internals.httpServer = {
    close() {},
    closeIdleConnections() {},
    closeAllConnections() {
      forcedConnectionsClosed = true;
    },
  };

  const startedAt = Date.now();
  await listener.close();
  const durationMs = Date.now() - startedAt;

  assert.equal(forcedConnectionsClosed, true);
  assert.equal(internals.sessions.size, 0);
  assert.ok(durationMs < 1800, `close took ${durationMs}ms`);
});

test("listener /health returns ok with session count", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const tools: Tool[] = [{ name: "test_tool", description: "A test", inputSchema: { type: "object", properties: {} } }];

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: tools,
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.sessions, 0);
  } finally {
    await listener.close();
  }
});

test("listener /ready reports degraded/down separately from /health", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async () => {
    throw new Error("offline");
  };
  await upstream.connect(
    { bad: { command: "bad-mcp" } },
    { reconnectPolicy: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 } }
  );
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: { bad: { command: "bad-mcp" } } },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });
  await listener.start();
  try {
    const port = listenerPort(listener);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(ready.status, 503);
    const body = await ready.json() as { status: string; downstream: { status: string } };
    assert.equal(body.status, "down");
    assert.equal(body.downstream.status, "degraded");
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("listener /ready reports degraded when some downstream servers are healthy", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async (name: string, config: ServerConfig) => {
    if (name === "bad") {
      throw new Error("offline");
    }
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
      resolvedTransport: "stdio",
      allTools: [tool],
      tools: [tool],
      connectDurationMs: 1,
    };
  };
  await upstream.connect(
    { good: { command: "good-mcp" }, bad: { command: "bad-mcp" } },
    { reconnectPolicy: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 } }
  );
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: { good: { command: "good-mcp" }, bad: { command: "bad-mcp" } } },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });
  await listener.start();
  try {
    const port = listenerPort(listener);
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(ready.status, 503);
    const body = await ready.json() as {
      status: string;
      downstream: {
        status: string;
        servers: Array<{ name: string }>;
        failedServers: Array<{ name: string }>;
      };
    };
    assert.equal(body.status, "degraded");
    assert.equal(body.downstream.status, "degraded");
    assert.deepEqual(body.downstream.servers.map((server) => server.name), ["good"]);
    assert.deepEqual(body.downstream.failedServers.map((server) => server.name), ["bad"]);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("listener listTools is dynamic and keeps meta tools present", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]) as unknown as UpstreamManager;
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: { github: { command: "github-mcp" } } },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  const tools = (listener as any).currentTools() as Tool[];
  assert.ok(tools.some((tool) => tool.name === "get_issue"));
  assert.ok(tools.some((tool) => tool.name === "callmux_status"));

  (upstream as any).toolMap = new Map();
  const metaOnly = (listener as any).currentTools() as Tool[];
  assert.ok(!metaOnly.some((tool) => tool.name === "github__get_issue"));
  assert.ok(metaOnly.some((tool) => tool.name === "callmux_status"));
});

test("listener listTools applies balanced schema compression by default", async () => {
  const tool: Tool = {
    name: "get_issue",
    description: "Get issue",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository name" },
        ref: { type: "string", description: "Git ref to resolve" },
      },
    },
  };
  const upstream = createMockUpstream([{ server: "github", tool }]) as unknown as UpstreamManager;
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: { github: { command: "github-mcp" } } },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  const tools = (listener as any).currentTools() as Tool[];
  const exposed = tools.find((item) => item.name === "get_issue");
  assert.ok(exposed);
  const properties = exposed.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(exposed.description, undefined);
  assert.equal(properties.repo.description, undefined);
  assert.equal(properties.ref.description, "Git ref to resolve");
});

test("listener dashboard is disabled by default", async () => {
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(res.status, 404);
  } finally {
    await listener.close();
  }
});

test("listener dashboard serves read-only runtime data when enabled", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      dashboard: { enabled: true, maxEvents: 10 },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const html = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /callmux dashboard/);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    await health.text();
    (listener as any).recordToolCallEvent(
      "get_item",
      { server: "fake", tool: "get_item" },
      textResult("ok"),
      Date.now() - 5,
      true
    );

    const data = await fetch(`http://127.0.0.1:${port}/dashboard/data`);
    assert.equal(data.status, 200);
    const body = await data.json() as {
      summary: { eventCount: number; totalEvents: number; maxEvents: number };
      status: { listener: { activeSessions: number } };
      events: Array<{ type: string; tool?: string; cacheHit?: boolean; path?: string }>;
    };
    assert.equal(body.summary.maxEvents, 10);
    assert.equal(body.summary.eventCount, 2);
    assert.equal(body.summary.totalEvents, 2);
    assert.equal(body.status.listener.activeSessions, 0);
    assert.ok(body.events.some((event) => event.type === "http_request" && event.path === "/health"));
    assert.ok(!body.events.some((event) => event.path === "/dashboard" || event.path === "/dashboard/data"));
    assert.ok(body.events.some((event) => event.type === "tool_call" && event.tool === "get_item" && event.cacheHit === true));
  } finally {
    await listener.close();
  }
});

test("listener dashboard supports trailing-slash reverse proxy paths", async () => {
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      dashboard: { enabled: true, path: "/relay/" },
    },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const withoutSlash = await fetch(`http://127.0.0.1:${port}/relay`);
    assert.equal(withoutSlash.status, 200);
    assert.match(await withoutSlash.text(), /dashboardEndpoint\("data"\)/);

    const withSlash = await fetch(`http://127.0.0.1:${port}/relay/`);
    assert.equal(withSlash.status, 200);

    const data = await fetch(`http://127.0.0.1:${port}/relay/data`);
    assert.equal(data.status, 200);

    const doubleSlashData = await fetch(`http://127.0.0.1:${port}/relay//data`);
    assert.equal(doubleSlashData.status, 404);
  } finally {
    await listener.close();
  }
});

test("listener dashboard supports root mount", async () => {
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      dashboard: { enabled: true, path: "/" },
    },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const html = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(html.status, 200);
    const htmlText = await html.text();
    assert.ok(htmlText.includes('const configuredPath = "/"'));
    assert.match(htmlText, /function externalMountPrefix/);
    assert.match(htmlText, /prefix \+ base/);
    assert.doesNotMatch(htmlText, /replace\(\/\/\+\$/);

    const data = await fetch(`http://127.0.0.1:${port}/data`);
    assert.equal(data.status, 200);

    const events = await fetch(`http://127.0.0.1:${port}/events`);
    assert.equal(events.status, 200);
    await events.body?.cancel();
  } finally {
    await listener.close();
  }
});

test("management overlay applies server additions and deletions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-management-overlay-"));
  const statePath = join(dir, "overlay.json");
  try {
    const base = {
      servers: {
        base: fakeMcpServer("base"),
      },
      management: { enabled: true, statePath },
    };
    const overlay = {
      version: 1 as const,
      servers: {
        added: { config: { command: "node", args: ["server.js"], tools: ["ping"] } },
        base: { deleted: true },
      },
    };

    await saveManagementOverlay(statePath, overlay);
    const loaded = await loadManagementOverlay(statePath);
    const effective = applyManagementOverlay(base, loaded);

    assert.deepEqual(Object.keys(effective.servers).sort(), ["added"]);
    assert.deepEqual(effective.servers.added, {
      command: "node",
      args: ["server.js"],
      tools: ["ping"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener management API requires management auth for mutations and persists overlay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-management-api-"));
  const statePath = join(dir, "overlay.json");
  const baseConfig = {
    servers: {
      alpha: { command: "node", args: ["alpha.js"] },
    },
    management: {
      enabled: true,
      statePath,
      auth: {
        mode: "bearer" as const,
        tokens: [{ id: "admin", token: "mgmt-secret" }],
      },
      allowUnauthenticatedRead: true,
    },
  };
  const upstream = new UpstreamManager();
  const cache = new CallCache(0);
  let listener: CallmuxListener | undefined;

  try {
    listener = new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      config: baseConfig,
      configPath: join(dir, "config.json"),
      managementBaseConfig: baseConfig,
      managementOverlay: { version: 1 },
      upstream,
      cache,
      allTools: [],
      maxConcurrency: 20,
      onManagementConfigChange: async (nextConfig, _trigger, overlay) => {
        listener!.applyReloadedState({
          config: nextConfig,
          upstream,
          cache,
          allTools: [],
          maxConcurrency: 20,
          managementBaseConfig: baseConfig,
          managementOverlay: overlay ?? { version: 1 },
        });
      },
    });
    await listener.start();
    const port = listenerPort(listener);

    const read = await fetch(`http://127.0.0.1:${port}/management/v1/config/effective`);
    assert.equal(read.status, 200);
    assert.deepEqual(Object.keys(((await read.json()) as { servers: Record<string, unknown> }).servers), ["alpha"]);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/management/v1/servers/alpha`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(unauthorized.status, 401);

    const client = new ManagementClient({
      baseUrl: `http://127.0.0.1:${port}/management/v1`,
      token: "mgmt-secret",
    });
    await client.updateServer("alpha", { disabled: true });

    const effective = await client.effectiveConfig();
    assert.equal(effective.servers.alpha.disabled, true);

    const disabledRestart = await fetch(`http://127.0.0.1:${port}/management/v1/servers/alpha/restart`, {
      method: "POST",
      headers: { Authorization: "Bearer mgmt-secret" },
    });
    assert.equal(disabledRestart.status, 409);
    assert.match(
      ((await disabledRestart.json()) as { error: string }).error,
      /enable it before restarting/
    );

    const overlay = await loadManagementOverlay(statePath);
    assert.equal(overlay.servers?.alpha.config?.disabled, true);
  } finally {
    await listener?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("management read denies a bare MCP principal unless allowAuthenticatedRead is set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-mgmt-read-"));
  const buildConfig = (allowAuthenticatedRead: boolean) => ({
    servers: { alpha: { command: "node", args: ["alpha.js"] } },
    auth: { mode: "bearer" as const, tokens: [{ id: "ops", token: "ops-secret" }] },
    management: {
      enabled: true,
      ...(allowAuthenticatedRead ? { allowAuthenticatedRead: true } : {}),
    },
  });
  const makeListener = (cfg: ReturnType<typeof buildConfig>) =>
    new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      config: cfg,
      configPath: join(dir, "config.json"),
      managementBaseConfig: cfg,
      managementOverlay: { version: 1 },
      upstream: new UpstreamManager(),
      cache: new CallCache(0),
      allTools: [],
      maxConcurrency: 10,
    });
  const readConfig = (port: number) =>
    fetch(`http://127.0.0.1:${port}/management/v1/config/effective`, {
      headers: { Authorization: "Bearer ops-secret" },
    });

  // Default: a valid global bearer authenticates the request (it is NOT a 401),
  // but management read is still refused — tool access does not imply config read.
  const gated = makeListener(buildConfig(false));
  try {
    await gated.start();
    const denied = await readConfig(listenerPort(gated));
    assert.equal(denied.status, 403);
  } finally {
    await gated.close();
  }

  // Opt in: the same principal is now allowed to read.
  const opened = makeListener(buildConfig(true));
  try {
    await opened.start();
    const allowed = await readConfig(listenerPort(opened));
    assert.equal(allowed.status, 200);
  } finally {
    await opened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener sanitizes a client-supplied x-request-id", async () => {
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream: new UpstreamManager(),
    cache: new CallCache(0),
    allTools: [],
    maxConcurrency: 10,
  });
  await listener.start();
  try {
    const port = listenerPort(listener);

    // A safe token is echoed verbatim.
    const ok = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-request-id": "req-123_ABC.def" },
    });
    assert.equal(ok.headers.get("x-request-id"), "req-123_ABC.def");

    // An unsafe value (would carry injection payloads into headers/logs) is
    // rejected and replaced with a fresh UUID.
    const evil = "spoof log injection";
    const bad = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-request-id": evil },
    });
    const echoed = bad.headers.get("x-request-id");
    assert.notEqual(echoed, evil);
    assert.match(
      echoed ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  } finally {
    await listener.close();
  }
});

test("listener serializes concurrent management mutations without clobbering the overlay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-management-race-"));
  const statePath = join(dir, "overlay.json");
  const baseConfig = {
    servers: {
      alpha: { command: "node", args: ["alpha.js"] },
    },
    management: {
      enabled: true,
      statePath,
      auth: {
        mode: "bearer" as const,
        tokens: [{ id: "admin", token: "mgmt-secret" }],
      },
      allowUnauthenticatedRead: true,
    },
  };
  const upstream = new UpstreamManager();
  const cache = new CallCache(0);
  let listener: CallmuxListener | undefined;

  try {
    listener = new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      config: baseConfig,
      configPath: join(dir, "config.json"),
      managementBaseConfig: baseConfig,
      managementOverlay: { version: 1 },
      upstream,
      cache,
      allTools: [],
      maxConcurrency: 20,
      onManagementConfigChange: async (nextConfig, _trigger, overlay) => {
        listener!.applyReloadedState({
          config: nextConfig,
          upstream,
          cache,
          allTools: [],
          maxConcurrency: 20,
          managementBaseConfig: baseConfig,
          managementOverlay: overlay ?? { version: 1 },
        });
      },
    });
    await listener.start();
    const port = listenerPort(listener);

    const client = new ManagementClient({
      baseUrl: `http://127.0.0.1:${port}/management/v1`,
      token: "mgmt-secret",
    });

    // Fire several adds concurrently. Without serialization, each handler
    // reads the same base overlay and the last write wins, dropping the rest.
    const names = ["beta", "gamma", "delta", "epsilon"];
    await Promise.all(
      names.map((name) => client.addServer(name, { command: "node", args: [`${name}.js`] }))
    );

    const overlay = await loadManagementOverlay(statePath);
    const persisted = Object.keys(overlay.servers ?? {}).sort();
    assert.deepEqual(persisted, [...names].sort());
  } finally {
    await listener?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManagementClient reports plain-text HTTP errors without JSON parse noise", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Unsupported method");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new ManagementClient({
      baseUrl: `http://127.0.0.1:${address.port}/management/v1`,
      token: "secret",
    });
    await assert.rejects(
      client.restartServer("scribe"),
      /Unsupported method/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("listener dashboard exposes tool suite change events", async () => {
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const clients: Array<{ onclose?: () => void; callTool: () => Promise<CallToolResult>; close: () => Promise<void> }> = [];
  let connectCount = 0;
  const harness = upstream as unknown as {
    connectOne: (name: string, config: ServerConfig) => Promise<unknown>;
  };
  harness.connectOne = async (name: string, config: ServerConfig) => {
    connectCount++;
    const toolNames = connectCount === 1 ? ["get_issue", "old_tool"] : ["get_issue", "new_tool"];
    const tools = toolNames.map((tool) => mockTool(tool));
    const client = {
      onclose: undefined as undefined | (() => void),
      async callTool() {
        return textResult("ok");
      },
      async close() {},
    };
    clients.push(client);
    return {
      name,
      config,
      client,
      transport: { async close() {} },
      resolvedTransport: "stdio",
      allTools: tools,
      tools,
      connectDurationMs: 1,
    };
  };

  await upstream.connect({ github: { command: "github-mcp" } });
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: { github: { command: "github-mcp" } },
      dashboard: { enabled: true, maxEvents: 10 },
    },
    upstream,
    cache,
    allTools: [],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    clients[0].onclose?.();
    await upstream.callTool("get_issue", {}, "github", { forceReconnect: true });

    const data = await fetch(`http://127.0.0.1:${port}/dashboard/data`);
    assert.equal(data.status, 200);
    const body = await data.json() as {
      events: Array<{
        type: string;
        server?: string;
        generation?: number;
        addedTools?: string[];
        removedTools?: string[];
      }>;
    };
    const event = body.events.find((item) => item.type === "tool_suite_changed");
    assert.ok(event);
    assert.equal(event.server, "github");
    assert.equal(typeof event.generation, "number");
    assert.deepEqual(event.addedTools, ["new_tool"]);
    assert.deepEqual(event.removedTools, ["old_tool"]);
  } finally {
    await listener.close();
    await upstream.close();
  }
});

test("RuntimeEventStore tracks total events separately from retained history", () => {
  const store = new RuntimeEventStore(2);
  for (let i = 0; i < 3; i += 1) {
    store.append({
      type: "http_request",
      timestamp: new Date(0).toISOString(),
      requestId: String(i),
      method: "GET",
      path: `/request-${i}`,
      status: 200,
      durationMs: 1,
    });
  }

  assert.equal(store.stats().eventCount, 2);
  assert.equal(store.stats().totalEvents, 3);
  assert.deepEqual(store.list().map((event) => event.type === "http_request" ? event.path : ""), ["/request-1", "/request-2"]);
});

test("RuntimeEventStore tracks distinct dashboard tool call totals", () => {
  const store = new RuntimeEventStore(10);
  store.append({
    type: "tool_call",
    timestamp: new Date(0).toISOString(),
    tool: "callmux_parallel",
    toolKind: "callmux_meta",
    operation: "parallel",
    passthroughToolCalls: 0,
    callmuxMetaToolCalls: 1,
    callmuxDownstreamToolCalls: 3,
    totalDownstreamToolCalls: 3,
    callmuxToolCalls: 1,
    realToolCalls: 3,
    downstreamTargets: [{ server: "github", tool: "get_issue", count: 3 }],
    durationMs: 1,
    success: true,
  });
  store.append({
    type: "tool_call",
    timestamp: new Date(1).toISOString(),
    tool: "github__get_issue",
    toolKind: "downstream",
    operation: "direct",
    passthroughToolCalls: 1,
    callmuxMetaToolCalls: 0,
    callmuxDownstreamToolCalls: 0,
    totalDownstreamToolCalls: 1,
    callmuxToolCalls: 0,
    realToolCalls: 1,
    downstreamTargets: [{ server: "github", tool: "get_issue", count: 1 }],
    durationMs: 1,
    success: true,
  });

  assert.equal(store.stats().passthroughToolCalls, 1);
  assert.equal(store.stats().callmuxMetaToolCalls, 1);
  assert.equal(store.stats().callmuxDownstreamToolCalls, 3);
  assert.equal(store.stats().totalDownstreamToolCalls, 4);
  assert.equal(store.stats().callmuxToolCalls, 1);
  assert.equal(store.stats().realToolCalls, 4);
});

test("dashboard classifies downstream tool errors separately from callmux errors", () => {
  const downstreamFailure: CallToolResult = {
    content: [{ type: "text", text: "npm test failed" }],
    isError: true,
  };
  assert.equal(classifyDashboardToolStatus(downstreamFailure), "downstream_error");
  assert.equal(
    classifyDashboardToolStatus(
      errorResult("invalid_arguments", "command must be a string"),
      { realToolCalls: 1 }
    ),
    "downstream_error"
  );

  assert.equal(
    classifyDashboardToolStatus(
      errorResult("tool_call_failed", "github add_issue_comment timed out", {
        category: "timeout",
      })
    ),
    "error"
  );
});

test("RuntimeEventStore recent errors ignores downstream tool result failures", () => {
  const store = new RuntimeEventStore(10);
  store.append({
    type: "tool_call",
    timestamp: new Date(0).toISOString(),
    tool: "tokenlean__tl_run",
    toolKind: "downstream",
    operation: "direct",
    callmuxToolCalls: 0,
    realToolCalls: 1,
    downstreamTargets: [{ server: "tokenlean", tool: "tl_run", count: 1 }],
    durationMs: 1,
    status: "downstream_error",
    success: true,
    error: "npm test failed",
  });
  store.append({
    type: "tool_call",
    timestamp: new Date(1).toISOString(),
    tool: "github__add_issue_comment",
    toolKind: "downstream",
    operation: "direct",
    callmuxToolCalls: 0,
    realToolCalls: 1,
    downstreamTargets: [{ server: "github", tool: "add_issue_comment", count: 1 }],
    durationMs: 1,
    status: "error",
    success: false,
    error: "timed out",
  });

  assert.equal(store.stats().recentErrors, 1);
});

test("RuntimeEventStore recent errors counter decrements as errors are evicted", () => {
  const store = new RuntimeEventStore(1);
  store.append({
    type: "tool_call",
    timestamp: new Date(0).toISOString(),
    tool: "github__add_issue_comment",
    toolKind: "downstream",
    operation: "direct",
    callmuxToolCalls: 0,
    realToolCalls: 1,
    downstreamTargets: [{ server: "github", tool: "add_issue_comment", count: 1 }],
    durationMs: 1,
    status: "error",
    success: false,
    error: "timed out",
  });
  assert.equal(store.stats().recentErrors, 1);

  // A second event pushes the error out of the single-slot ring; the counter
  // must follow what is actually retained, not what was ever appended.
  store.append({
    type: "http_request",
    timestamp: new Date(1).toISOString(),
    requestId: "ok",
    method: "GET",
    path: "/health",
    status: 200,
    durationMs: 1,
  });
  assert.equal(store.stats().eventCount, 1);
  assert.equal(store.stats().recentErrors, 0);
});

test("RuntimeEventStore recent errors ignores routine transport disconnects", () => {
  const store = new RuntimeEventStore(10);
  store.append({
    type: "http_request",
    timestamp: new Date(0).toISOString(),
    requestId: "sse-close",
    method: "GET",
    path: "/sse",
    status: 499,
    durationMs: 300_000,
  });
  store.append({
    type: "http_request",
    timestamp: new Date(1).toISOString(),
    requestId: "mcp-get-close",
    method: "GET",
    path: "/mcp",
    status: 499,
    durationMs: 300_000,
  });
  store.append({
    type: "http_request",
    timestamp: new Date(2).toISOString(),
    requestId: "not-found",
    method: "GET",
    path: "/dashboard/data",
    status: 404,
    durationMs: 1,
  });
  store.append({
    type: "http_request",
    timestamp: new Date(3).toISOString(),
    requestId: "mcp-post-close",
    method: "POST",
    path: "/mcp",
    status: 499,
    durationMs: 300_000,
  });

  assert.equal(store.stats().recentErrors, 2);
});

test("listener dashboard records downstream tool failures without callmux error status", () => {
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  (listener as any).recordToolCallEvent(
    "tokenlean__tl_run",
    { server: "tokenlean", tool: "tl_run" },
    {
      content: [{ type: "text" as const, text: "npm test failed" }],
      isError: true,
    },
    Date.now() - 5
  );

  const events = (listener as any).runtimeEvents.list() as Array<{
    status?: string;
    success?: boolean;
    error?: string;
  }>;
  assert.equal(events[0].status, "downstream_error");
  assert.equal(events[0].success, true);
  assert.equal(events[0].error, "npm test failed");
  assert.equal((events[0] as any).passthroughToolCalls, 1);
  assert.equal((events[0] as any).callmuxMetaToolCalls, 0);
  assert.equal((events[0] as any).callmuxDownstreamToolCalls, 0);
  assert.equal((events[0] as any).totalDownstreamToolCalls, 1);
  assert.equal((listener as any).runtimeEvents.stats().recentErrors, 0);
});

test("dashboard hides successful transport HTTP events by default", () => {
  const html = renderDashboardHtml({ enabled: true, path: "/dashboard", maxEvents: 500 });
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(html, /%2338bdf8/);
  assert.match(html, /id="hide-transport" type="checkbox" checked/);
  assert.match(html, /id="hide-agent-status" type="checkbox" checked/);
  assert.match(html, /function isTransportHttpEvent/);
  assert.match(html, /function isAgentStatusEvent/);
  assert.match(html, /agent\\s\+\(ready\|idle\|busy\)/);
  assert.match(html, /notifications\/initialized/);
  assert.match(html, /function cacheEntriesText/);
  assert.match(html, /return "disabled"/);
  assert.match(html, /function truncateText/);
  assert.match(html, /maxLength = 180/);
  assert.match(html, /function setManagementMessage/);
  assert.match(html, /Enable this server before restarting/);
  assert.match(html, /server\.managed \? "Override" : "base"/);
  assert.match(html, /const runtime = server\.runtime \|\| \{\}/);
  assert.match(html, /const disabled = config\.disabled === true \|\| state === "disabled"/);
  assert.match(html, /truncateText\(detailText\(event\)\)/);
  assert.match(html, /function clientRows/);
  assert.match(html, /STDIO Bridge/);
  assert.match(html, /function renderTrafficChart/);
  assert.match(html, /Tool Call Traffic/);
  assert.match(html, /eventDurationText\(event\)/);
  assert.match(html, /event-detail-row/);
  assert.match(html, /function updateUpdatedClock/);
  assert.match(html, /setInterval\(updateUpdatedClock, 1000\)/);
  assert.match(html, /function hasActiveTextSelection/);
  assert.match(html, /function renderWhenSelectionAllows/);
  assert.match(html, /document\.addEventListener\("selectionchange"/);
  assert.match(html, /renderWhenSelectionAllows\(await res\.json\(\)\)/);
  assert.match(html, /Passthrough calls/);
  assert.match(html, /In-Flight Tool Calls/);
  assert.match(html, /function activeToolCallRows/);
  assert.match(html, /tool_call_lifecycle/);
  assert.match(html, /client_aborted/);
  assert.match(html, /call exceeded timeout/);
  assert.match(html, /Meta calls \/ downstream/);
  assert.match(html, /Total downstream/);
  assert.doesNotMatch(html, /Live proxy activity/);
  assert.doesNotMatch(html, /Current status payload/);
  assert.doesNotMatch(html, /Traffic Path/);
  assert.match(html, /class="sidebar"/);
  assert.match(html, /data-view-button="overview"/);
  assert.match(html, /data-view-button="servers"/);
  assert.match(html, /data-view-button="tools"/);
  assert.match(html, /data-view-button="diagrams"/);
  assert.match(html, /data-view-button="events"/);
  assert.match(html, /data-view-button="runtime"/);
  assert.match(html, /function switchView/);
  assert.match(html, /callmux-dashboard-view/);
  assert.match(html, /id="runtime-json"/);
  assert.match(html, /id="server-detail"/);
  assert.match(html, /id="tool-suites"/);
  assert.match(html, /id="runtime-diagrams"/);
  assert.match(html, /id="overview-flow"/);
  assert.match(html, /function renderRuntimeDiagrams/);
  assert.match(html, /function eventMatchesFilters/);
  assert.match(html, /event-filter-server/);
  assert.match(html, /class="filter-field search-field"/);
  assert.match(html, /<th>Duration<\/th>/);
  assert.ok(html.includes('["/mcp", "/sse", "/messages"]'));
  assert.ok(html.includes("status < 400"));
  assert.ok(html.includes('status === 499 && (event.path === "/sse" || (event.path === "/mcp" && event.method === "GET"))'));
});

test("listener dashboard summarizes meta-tool fanout without arguments", () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
    { server: "github", tool: mockTool("list_issues") },
  ]) as unknown as UpstreamManager;
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  const summary = (listener as any).summarizeDashboardToolCall(
    "callmux_parallel",
    {
      calls: [
        { tool: "get_issue", server: "github", arguments: { token: "secret" } },
        { tool: "list_issues", server: "github", arguments: { token: "secret" } },
        { tool: "get_issue", server: "github", arguments: { token: "secret" } },
      ],
    },
    textResult("ok")
  );

  assert.equal(summary.toolKind, "callmux_meta");
  assert.equal(summary.operation, "parallel");
  assert.equal(summary.passthroughToolCalls, 0);
  assert.equal(summary.callmuxMetaToolCalls, 1);
  assert.equal(summary.callmuxDownstreamToolCalls, 3);
  assert.equal(summary.totalDownstreamToolCalls, 3);
  assert.equal(summary.callmuxToolCalls, 1);
  assert.equal(summary.realToolCalls, 3);
  assert.deepEqual(summary.downstreamTargets, [
    { server: "github", tool: "get_issue", count: 2 },
    { server: "github", tool: "list_issues", count: 1 },
  ]);
  assert.equal(JSON.stringify(summary).includes("secret"), false);

  const invalid = (listener as any).summarizeDashboardToolCall(
    "callmux_call",
    { tool: "callmux_status", server: "callmux" },
    errorResult("tool_resolution_failed", "server not found")
  );
  assert.equal(invalid.passthroughToolCalls, 0);
  assert.equal(invalid.callmuxMetaToolCalls, 1);
  assert.equal(invalid.callmuxDownstreamToolCalls, 0);
  assert.equal(invalid.totalDownstreamToolCalls, 0);
  assert.equal(invalid.realToolCalls, 0);
  assert.deepEqual(invalid.downstreamTargets, []);

  const invalidBatch = (listener as any).summarizeDashboardToolCall(
    "callmux_batch",
    {
      tool: "get_issue",
      server: "github",
      items: { bad: true },
    },
    errorResult("invalid_arguments", '"items" must be an array')
  );
  assert.equal(invalidBatch.passthroughToolCalls, 0);
  assert.equal(invalidBatch.callmuxMetaToolCalls, 1);
  assert.equal(invalidBatch.callmuxDownstreamToolCalls, 0);
  assert.equal(invalidBatch.totalDownstreamToolCalls, 0);
  assert.equal(invalidBatch.realToolCalls, 0);
  assert.deepEqual(invalidBatch.downstreamTargets, [
    { server: "github", tool: "get_issue", count: 0 },
  ]);

  const status = (listener as any).summarizeDashboardToolCall(
    "callmux_status",
    {},
    textResult("ok")
  );
  assert.equal(status.toolKind, "callmux_meta");
  assert.equal(status.callmuxMetaToolCalls, 0);
  assert.equal(status.callmuxDownstreamToolCalls, 0);
  assert.equal(status.totalDownstreamToolCalls, 0);
  assert.equal(status.callmuxToolCalls, 0);
  assert.equal(status.realToolCalls, 0);
});

test("listener dashboard uses listener authentication", async () => {
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      servers: {},
      dashboard: { enabled: true },
      auth: {
        mode: "bearer",
        tokens: [{ id: "ops", token: "top-secret" }],
      },
    },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Authorization: "Bearer top-secret" },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await listener.close();
  }
});

test("runListenerDoctor validates streamable listener cwd diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "callmux-doctor-cwd-"));
  const upstream = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream,
    cache,
    allTools: META_TOOLS,
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const report = await runListenerDoctor({
      url: `http://127.0.0.1:${port}/mcp`,
      cwd: root,
    });

    assert.equal(report.ok, true);
    assert.equal(report.health?.status, 200);
    assert.ok(report.initialize?.sessionId);
    const status = report.status?.body as {
      listener: { sessions: Array<{ id: string; cwd?: string; cwdSource?: string }> };
    };
    assert.ok(status.listener.sessions.some((session) =>
      session.id === report.initialize?.sessionId &&
      session.cwd === root &&
      session.cwdSource === "header"
    ));
  } finally {
    await listener.close();
    await rm(root, { recursive: true, force: true });
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

test("listener scopes stdio downstream cwd per MCP session", async () => {
  const upstream = new UpstreamManager();
  const rootA = await mkdtemp(join(tmpdir(), "callmux-cwd-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "callmux-cwd-b-"));
  const cache = new CallCache(60, undefined, {}, 100);
  let listener: CallmuxListener | undefined;

  try {
    await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([
          { name: "get_item", description: "Get a fake item" },
        ]),
      }),
    });

    const allTools = upstream.getTools().map(({ qualifiedName, tool }) => ({
      ...tool,
      name: qualifiedName,
    }));
    listener = new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      config: { servers: { fake: fakeMcpServer("fake") } },
      upstream,
      cache,
      allTools,
      maxConcurrency: 10,
    });

    await listener.start();
    const port = listenerPort(listener);

    const mcpHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };

    const initialize = async (cwd: string, id: number) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { ...mcpHeaders, "x-callmux-cwd": cwd },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
          id,
        }),
      });
      assert.equal(res.status, 200);
      const sessionId = res.headers.get("mcp-session-id");
      assert.ok(sessionId);
      return sessionId;
    };

    const callGetItem = async (sessionId: string, id: number) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { ...mcpHeaders, "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "get_item",
            arguments: { id: 7 },
          },
          id,
        }),
      });
      assert.equal(res.status, 200);
      const body = await parseMcpResponseBody(res);
      const text = body.result.content[0].text;
      return JSON.parse(text) as { cwd: string; arguments: { id: number } };
    };

    const callStatus = async (sessionId: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { ...mcpHeaders, "mcp-session-id": sessionId },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "callmux_status",
            arguments: { sessions: true, recommendations: false },
          },
          id: 5,
        }),
      });
      assert.equal(res.status, 200);
      const body = await parseMcpResponseBody(res);
      const text = body.result.content[0].text;
      return JSON.parse(text) as {
        listener: {
          activeSessions: number;
          sessions: Array<{ id: string; cwd?: string; cwdSource?: string }>;
          scopedStdioClients: {
            total: number;
            byServer: Record<string, number>;
            items: Array<{ server: string; cwd: string; idle: boolean }>;
          };
        };
      };
    };

    const sessionA = await initialize(rootA, 1);
    const sessionB = await initialize(rootB, 2);

    const payloadA = await callGetItem(sessionA, 3);
    const payloadB = await callGetItem(sessionB, 4);
    const status = await callStatus(sessionA);

    assert.equal(payloadA.cwd, rootA);
    assert.equal(payloadB.cwd, rootB);
    assert.deepEqual(payloadA.arguments, { id: 7 });
    assert.deepEqual(payloadB.arguments, { id: 7 });
    assert.equal(status.listener.activeSessions, 2);
    assert.ok(status.listener.sessions.some((session) =>
      session.id === sessionA && session.cwd === rootA && session.cwdSource === "header"
    ));
    assert.ok(status.listener.sessions.some((session) =>
      session.id === sessionB && session.cwd === rootB && session.cwdSource === "header"
    ));
    assert.equal(status.listener.scopedStdioClients.total, 2);
    assert.equal(status.listener.scopedStdioClients.byServer.fake, 2);
    assert.ok(status.listener.scopedStdioClients.items.some((item) =>
      item.server === "fake" && item.cwd === rootA && item.idle
    ));
    assert.ok(status.listener.scopedStdioClients.items.some((item) =>
      item.server === "fake" && item.cwd === rootB && item.idle
    ));
  } finally {
    await listener?.close();
    await upstream.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("stdio bridge forwards calls to shared listener with cwd header", async () => {
  const upstream = new UpstreamManager();
  const root = await mkdtemp(join(tmpdir(), "callmux-bridge-cwd-"));
  const cache = new CallCache(0, undefined, {}, 100);
  let listener: CallmuxListener | undefined;
  let bridgeClient: Client | undefined;
  let bridgeTransport: StdioClientTransport | undefined;

  try {
    await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([
          { name: "get_item", description: "Get a fake item" },
        ]),
      }),
    });

    const allTools = upstream.getTools().map(({ qualifiedName, tool }) => ({
      ...tool,
      name: qualifiedName,
    }));
    const port = await getFreePort();
    listener = new CallmuxListener({
      port,
      host: "127.0.0.1",
      config: { servers: { fake: fakeMcpServer("fake") } },
      upstream,
      cache,
      allTools,
      maxConcurrency: 10,
    });

    await listener.start();

    bridgeTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(process.cwd(), "dist-test", "bin", "callmux.js"),
        "bridge",
        "--url",
        `http://127.0.0.1:${port}/mcp`,
        "--cwd",
        root,
      ],
    });
    bridgeClient = new Client(
      { name: "bridge-test", version: "1.0" },
      { capabilities: {} }
    );
    await bridgeClient.connect(bridgeTransport);

    const { tools } = await bridgeClient.listTools();
    assert.ok(tools.some((tool) => tool.name === "get_item"));

    const result = await bridgeClient.callTool({
      name: "get_item",
      arguments: { id: 99 },
    }) as unknown as CallToolResult;
    assert.equal(result.isError, undefined);
    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      cwd: string;
      arguments: { id: number };
    };
    assert.equal(payload.cwd, root);
    assert.deepEqual(payload.arguments, { id: 99 });
    const diagnostics = (listener as any).getRuntimeDiagnostics() as {
      sessions: Array<{ clientKind?: string; cwd?: string }>;
    };
    assert.ok(diagnostics.sessions.some((session) =>
      session.clientKind === "stdio-bridge" && session.cwd === root
    ));

    await listener.close();
    await listener.start();

    const restartedTools = await bridgeClient.listTools();
    assert.ok(restartedTools.tools.some((tool) => tool.name === "get_item"));

    const restartedResult = await bridgeClient.callTool({
      name: "get_item",
      arguments: { id: 100 },
    }) as unknown as CallToolResult;
    assert.equal(restartedResult.isError, undefined);
    const restartedPayload = JSON.parse((restartedResult.content[0] as { text: string }).text) as {
      cwd: string;
      arguments: { id: number };
    };
    assert.equal(restartedPayload.cwd, root);
    assert.deepEqual(restartedPayload.arguments, { id: 100 });

    await bridgeClient.close();
    bridgeClient = undefined;
    await bridgeTransport.close();
    bridgeTransport = undefined;
    await waitFor(async () => {
      const diagnostics = (listener as any).getRuntimeDiagnostics() as {
        sessions: Array<{ clientKind?: string; cwd?: string }>;
      };
      return !diagnostics.sessions.some((session) =>
        session.clientKind === "stdio-bridge" && session.cwd === root
      );
    });
  } finally {
    await bridgeClient?.close();
    await bridgeTransport?.close();
    await listener?.close();
    await upstream.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stdio bridge emits tool list changed notification when refreshed tools differ", async () => {
  const bridge = new CallmuxBridge({
    url: "http://127.0.0.1:1/mcp",
    cwd: process.cwd(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let tools = [mockTool("old_tool")];
  const notifications: Array<{ error: Error | null; tools: Tool[] | null }> = [];
  const bridgeClient = new Client(
    { name: "bridge-list-changed-test", version: "1.0" },
    {
      capabilities: {},
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged(error, changedTools) {
            notifications.push({ error, tools: changedTools });
          },
        },
      },
    }
  );

  (bridge as any).client = {
    async listTools() {
      return { tools };
    },
    async close() {},
  };

  try {
    await (bridge as any).server.connect(serverTransport);
    await bridgeClient.connect(clientTransport);

    assert.equal(bridgeClient.getServerCapabilities()?.tools?.listChanged, true);
    const first = await bridgeClient.listTools();
    assert.deepEqual(first.tools.map((tool) => tool.name), ["old_tool"]);
    assert.equal(notifications.length, 0);

    tools = [mockTool("new_tool")];
    const second = await bridgeClient.listTools();
    assert.deepEqual(second.tools.map((tool) => tool.name), ["new_tool"]);

    await waitFor(async () => notifications.length === 1);
    assert.equal(notifications[0].error, null);
    assert.equal(notifications[0].tools, null);
  } finally {
    await bridgeClient.close().catch(() => undefined);
    await bridge.close();
  }
});

test("stdio bridge preserves per-call cwd metadata for shared listener", async () => {
  const upstream = new UpstreamManager();
  const rootA = await mkdtemp(join(tmpdir(), "callmux-bridge-meta-a-"));
  const rootB = await mkdtemp(join(tmpdir(), "callmux-bridge-meta-b-"));
  const cache = new CallCache(0, undefined, {}, 100);
  let listener: CallmuxListener | undefined;
  let bridgeClient: Client | undefined;
  let bridgeTransport: StdioClientTransport | undefined;

  try {
    await upstream.connect({
      fake: fakeMcpServer("fake", {
        FAKE_MCP_TOOLS: JSON.stringify([
          { name: "get_item", description: "Get a fake item" },
        ]),
      }),
    });

    const allTools = upstream.getTools().map(({ qualifiedName, tool }) => ({
      ...tool,
      name: qualifiedName,
    }));
    listener = new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      config: { servers: { fake: fakeMcpServer("fake") } },
      upstream,
      cache,
      allTools,
      maxConcurrency: 10,
    });

    await listener.start();
    const port = listenerPort(listener);

    bridgeTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(process.cwd(), "dist-test", "bin", "callmux.js"),
        "bridge",
        "--url",
        `http://127.0.0.1:${port}/mcp`,
        "--cwd",
        rootA,
      ],
    });
    bridgeClient = new Client(
      { name: "bridge-meta-test", version: "1.0" },
      { capabilities: {} }
    );
    await bridgeClient.connect(bridgeTransport);

    const result = await bridgeClient.callTool({
      name: "get_item",
      arguments: { id: 101 },
      _meta: { callmux: { cwd: rootB } },
    } as never) as unknown as CallToolResult;
    assert.equal(result.isError, undefined);
    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      cwd: string;
      arguments: { id: number };
    };
    assert.equal(payload.cwd, rootB);
    assert.deepEqual(payload.arguments, { id: 101 });

    const diagnostics = (listener as any).getRuntimeDiagnostics() as {
      sessions: Array<{ clientKind?: string; cwd?: string; cwdSource?: string }>;
      scopedStdioClients: { items: Array<{ server: string; cwd: string }> };
    };
    assert.ok(diagnostics.sessions.some((session) =>
      session.clientKind === "stdio-bridge" &&
      session.cwd === rootB &&
      session.cwdSource === "meta"
    ));
    assert.ok(diagnostics.scopedStdioClients.items.some((item) =>
      item.server === "fake" && item.cwd === rootB
    ));
  } finally {
    await bridgeClient?.close();
    await bridgeTransport?.close();
    await listener?.close();
    await upstream.close();
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("stdio bridge starts while shared listener is down and returns retryable errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "callmux-bridge-down-"));
  const port = await getFreePort();
  let bridgeClient: Client | undefined;
  let bridgeTransport: StdioClientTransport | undefined;

  try {
    bridgeTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(process.cwd(), "dist-test", "bin", "callmux.js"),
        "bridge",
        "--url",
        `http://127.0.0.1:${port}/mcp`,
        "--cwd",
        root,
      ],
    });
    bridgeClient = new Client(
      { name: "bridge-down-test", version: "1.0" },
      { capabilities: {} }
    );
    await bridgeClient.connect(bridgeTransport);

    const listed = await bridgeClient.listTools();
    assert.deepEqual(listed.tools, []);

    const result = await bridgeClient.callTool({
      name: "get_item",
      arguments: { id: 1 },
    }) as unknown as CallToolResult;
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { error: { code: string; details?: Record<string, unknown> } }).error.code,
      "bridge_upstream_unavailable"
    );
    assert.equal(
      (result.structuredContent as { error: { details?: Record<string, unknown> } }).error.details?.retryable,
      true
    );
  } finally {
    await bridgeClient?.close();
    await bridgeTransport?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("listener resolves session cwd from MCP roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "callmux-roots-cwd-"));
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  try {
    const session: Record<string, unknown> = {};
    const server = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({
        roots: [{ uri: pathToFileURL(root).href, name: "project" }],
      }),
    };

    const context = await (listener as any).resolveToolCallContext(
      session,
      server,
      { sessionId: "session-1" }
    );

    assert.equal(context.cwd, root);
    assert.equal(context.sessionId, "session-1");
    assert.equal(session.cwd, root);
    assert.equal(session.cwdSource, "roots");
  } finally {
    await listener.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("listener does not require session cwd for global meta tools", () => {
  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: {} },
    upstream: new UpstreamManager(),
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });
  const upstream = {
    usesSessionCwd() {
      throw new Error("should not resolve targets for global meta tools");
    },
  };

  assert.equal(
    (listener as any).toolRequestNeedsSessionCwd(upstream, "callmux_status", {}),
    false
  );
  assert.equal(
    (listener as any).toolRequestNeedsSessionCwd(upstream, "callmux_cache_clear", {}),
    false
  );
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  const port = listenerPort(listener);
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

  await listener.start();
  const port = listenerPort(listener);
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

  await listener.start();
  const port = listenerPort(listener);
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

    await listener.start();
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await deniedListener.start();
  try {
    const deniedPort = listenerPort(deniedListener);
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

  await allowedListener.start();
  try {
    const allowedPort = listenerPort(allowedListener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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
    assert.ok(listBody.result.tools.length >= META_TOOLS.length);
    assert.ok(listBody.result.tools.some((tool: Tool) => tool.name === "callmux_status"));
    assert.ok(!listBody.result.tools.some((tool: Tool) => tool.name === "my_tool"));

    assert.equal((listener as any).getRuntimeDiagnostics().activeSessions, 1);
    const deleteRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    assert.equal(deleteRes.status, 200);
    await waitFor(async () => (listener as any).getRuntimeDiagnostics().activeSessions === 0);
  } finally {
    await listener.close();
  }
});

test("listener dashboard exposes in-flight and client-aborted tool calls", async () => {
  const upstream = new UpstreamManager(1200);
  const cache = new CallCache(0, undefined, {}, 100);
  let listener: CallmuxListener | undefined;
  // The upstream call hangs on a promise the test releases explicitly, so the
  // in_flight -> client_aborted -> cleanup sequence is fully deterministic and
  // never races the wall-clock call timeout (the source of past flakiness).
  let releaseCall: (() => void) | undefined;

  try {
    await upstream.connect({
      fake: fakeMcpServer("fake"),
    });
    const allTools = upstream.getTools().map(({ qualifiedName, tool }) => ({
      ...tool,
      name: qualifiedName,
    }));
    // Keep the real connected upstream (so server/targetTool resolve through
    // real metadata) but make the actual call controllable.
    (upstream as unknown as { callTool: () => Promise<CallToolResult> }).callTool =
      () =>
        new Promise<CallToolResult>((resolve) => {
          releaseCall = () => resolve(textResult("released"));
        });
    listener = new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      config: { servers: { fake: fakeMcpServer("fake") } },
      upstream,
      cache,
      allTools,
      maxConcurrency: 10,
    });

    await listener.start();
    const port = listenerPort(listener);
    const mcpHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      }),
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const controller = new AbortController();
    const callPromise = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "fake__get_item", arguments: { id: 14 } },
        id: 2,
      }),
      signal: controller.signal,
    }).catch((error) => error);

    await waitFor(async () => {
      const diagnostics = (listener as any).getRuntimeDiagnostics() as {
        activeToolCalls?: Array<{ status: string; server?: string; targetTool?: string }>;
      };
      return diagnostics.activeToolCalls?.some((call) =>
        call.status === "in_flight" &&
        call.server === "fake" &&
        call.targetTool === "get_item"
      ) === true;
    });

    controller.abort();
    await callPromise;

    await waitFor(async () => {
      const diagnostics = (listener as any).getRuntimeDiagnostics() as {
        activeToolCalls?: Array<{ status: string; server?: string; targetTool?: string }>;
      };
      return diagnostics.activeToolCalls?.some((call) =>
        call.status === "client_aborted" &&
        call.server === "fake" &&
        call.targetTool === "get_item"
      ) === true;
    }, 1000, 10);

    const lifecycleEvents = ((listener as any).runtimeEvents.list() as Array<{
      type: string;
      lifecycle?: string;
      status?: string;
      requestId?: string;
      server?: string;
      targetTool?: string;
    }>).filter((event) => event.type === "tool_call_lifecycle");
    assert.ok(!lifecycleEvents.some((event) => event.lifecycle === "started"));
    assert.ok(lifecycleEvents.some((event) =>
      event.lifecycle === "client_aborted" &&
      event.status === "client_aborted" &&
      event.server === "fake" &&
      event.targetTool === "get_item"
    ));

    // Release the hung upstream call so the request handler's finally runs and
    // the active-call entry is cleaned up — no timeout firing required.
    releaseCall?.();

    await waitFor(async () =>
      ((listener as any).getRuntimeDiagnostics() as { activeToolCallCount?: number })
        .activeToolCallCount === 0,
      3000,
      20
    );
  } finally {
    releaseCall?.();
    await listener?.close();
    await upstream.close();
  }
});

test("listener emits timeout overrun event only for still-active tool calls", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("get_issue") },
  ]) as unknown as UpstreamManager & {
    callTool: () => Promise<CallToolResult>;
  };
  const cache = new CallCache(0, undefined, {}, 100);
  let releaseCall: ((result: CallToolResult) => void) | undefined;
  upstream.callTool = async () => new Promise<CallToolResult>((resolve) => {
    releaseCall = resolve;
  });

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: {
      callTimeoutMs: 20,
      servers: { github: { command: "ignored" } },
    },
    upstream,
    cache,
    allTools: [{ name: "get_issue", description: "test", inputSchema: { type: "object", properties: {} } }],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const mcpHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
        id: 1,
      }),
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const callPromise = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "get_issue", arguments: { id: 1 } },
        id: 2,
      }),
    });

    await waitFor(async () => releaseCall !== undefined);
    await waitFor(async () => {
      const events = ((listener as any).runtimeEvents.list() as Array<{
        type: string;
        lifecycle?: string;
        status?: string;
        timeoutMs?: number;
        success?: boolean;
        error?: string;
      }>).filter((event) => event.type === "tool_call_lifecycle");
      return events.some((event) =>
        event.lifecycle === "timeout_overrun" &&
        event.status === "error" &&
        event.timeoutMs === 20 &&
        event.success === false &&
        /still in flight/.test(event.error ?? "")
      );
    }, 2500, 20);

    assert.ok(!((listener as any).runtimeEvents.list() as Array<{ lifecycle?: string }>)
      .some((event) => event.lifecycle === "started"));

    releaseCall?.(textResult("late ok"));
    const callRes = await callPromise;
    assert.equal(callRes.status, 200);
    const callBody = await parseMcpResponseBody(callRes);
    assert.equal(callBody.result.isError, undefined);
    assert.ok(((listener as any).runtimeEvents.list() as Array<{ type: string; tool?: string }>)
      .some((event) => event.type === "tool_call" && event.tool === "get_issue"));
  } finally {
    await listener.close();
  }
});

test("listener lets callmux_call page stored truncated results", async () => {
  const upstream = createMockUpstream([
    { server: "github", tool: mockTool("large_list") },
  ]) as unknown as UpstreamManager;
  (upstream as unknown as {
    callTool: () => Promise<CallToolResult>;
  }).callTool = async () =>
    textResult(JSON.stringify(Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      name: `item-${index + 1}`,
      body: "x".repeat(500),
    }))));

  const listener = new CallmuxListener({
    port: 0,
    host: "127.0.0.1",
    config: { servers: { github: { command: "ignored" } } },
    upstream,
    cache: new CallCache(0, undefined, {}, 100),
    allTools: [],
    maxConcurrency: 10,
  });

  await listener.start();
  try {
    const port = listenerPort(listener);
    const mcpHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
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

    const shielded = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "large_list", arguments: {} },
        id: 2,
      }),
    });
    assert.equal(shielded.status, 200);
    const shieldedBody = await parseMcpResponseBody(shielded);
    const ref = shieldedBody.result.structuredContent._callmux.ref;
    assert.match(ref, /^r_/);

    const page = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "callmux_call",
          arguments: {
            tool: "callmux_get_result",
            arguments: { ref, offset: 1, limit: 2, fields: ["id"] },
          },
        },
        id: 3,
      }),
    });
    assert.equal(page.status, 200);
    const pageBody = await parseMcpResponseBody(page);
    assert.equal(pageBody.result.structuredContent.type, "array");
    assert.deepEqual(pageBody.result.structuredContent.data, [{ id: 2 }, { id: 3 }]);
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

  await listener.start();
  try {
    const port = listenerPort(listener);
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

test("listener dashboard metrics endpoint aggregates and persists across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-metrics-"));
  const configPath = join(dir, "config.json");
  const metricsPath = join(dir, "callmux-metrics.json");

  const mcpHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };

  // Initialize an MCP session and return its id.
  async function initSession(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        id: 1,
      }),
    });
    const sessionId = res.headers.get("mcp-session-id");
    assert.ok(sessionId, "expected a session id");
    return sessionId;
  }

  async function callTool(port: number, sessionId: string, name: string, args: unknown, id: number): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id }),
    });
    await res.text(); // drain so the call completes server-side
  }

  function buildListener(upstream: UpstreamManager, cache: CallCache, allTools: unknown[]): CallmuxListener {
    return new CallmuxListener({
      port: 0,
      host: "127.0.0.1",
      configPath,
      config: { servers: { fake: fakeMcpServer("fake") }, dashboard: { enabled: true, maxEvents: 50 } },
      upstream,
      cache,
      allTools: allTools as never,
      maxConcurrency: 10,
    });
  }

  const upstream = new UpstreamManager();
  const upstream2 = new UpstreamManager();
  const cache = new CallCache(0, undefined, {}, 100);
  const cache2 = new CallCache(0, undefined, {}, 100);
  let listener: CallmuxListener | undefined;
  let listener2: CallmuxListener | undefined;
  try {
    await upstream.connect({ fake: fakeMcpServer("fake") });
    const allTools = upstream.getTools().map(({ qualifiedName, tool }) => ({ ...tool, name: qualifiedName }));
    listener = buildListener(upstream, cache, allTools);
    await listener.start();
    const port = listenerPort(listener);
    const session = await initSession(port);

    // 2 passthrough downstream calls + 1 meta call (callmux_status hits no server)
    await callTool(port, session, "fake__get_item", { id: 1 }, 2);
    await callTool(port, session, "fake__get_item", { id: 2 }, 3);
    await callTool(port, session, "callmux_status", {}, 4);

    const res = await fetch(`http://127.0.0.1:${port}/dashboard/series?range=1h`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      totals: { calls: number; meta: number; passthrough: number; downstream: number };
      servers: { server: string; calls: number; downstream: number }[];
      series: { bucketMs: number; points: unknown[] };
    };
    assert.equal(body.totals.calls, 3);
    assert.equal(body.totals.meta, 1);
    assert.equal(body.totals.passthrough, 2);
    // per-server downstream stays consistent with the global counter (no double counting)
    const serverDownstream = body.servers.reduce((sum, s) => sum + s.downstream, 0);
    assert.equal(serverDownstream, body.totals.downstream);
    const fake = body.servers.find((s) => s.server === "fake");
    assert.ok(fake);
    assert.equal(fake.calls, 2);
    assert.equal(body.series.bucketMs, 60_000);
    // ~60 one-minute buckets for a 1h window (61 when `from` straddles a boundary)
    assert.ok(body.series.points.length >= 60 && body.series.points.length <= 61);

    // Closing flushes the metrics snapshot to the config dir.
    await listener.close();
    listener = undefined;
    const persisted = JSON.parse(await readFile(metricsPath, "utf8")) as { aggregate: { calls: number } };
    assert.equal(persisted.aggregate.calls, 3);

    // A fresh listener on the same configPath restores the counters and accrues onto them.
    await upstream2.connect({ fake: fakeMcpServer("fake") });
    const allTools2 = upstream2.getTools().map(({ qualifiedName, tool }) => ({ ...tool, name: qualifiedName }));
    listener2 = buildListener(upstream2, cache2, allTools2);
    await listener2.start();
    const port2 = listenerPort(listener2);

    const restored = await (await fetch(`http://127.0.0.1:${port2}/dashboard/series?range=1h`)).json() as {
      totals: { calls: number };
    };
    assert.equal(restored.totals.calls, 3, "restart should restore persisted call count");

    const session2 = await initSession(port2);
    await callTool(port2, session2, "fake__get_item", { id: 9 }, 2);
    const after = await (await fetch(`http://127.0.0.1:${port2}/dashboard/series?range=1h`)).json() as {
      totals: { calls: number };
    };
    assert.equal(after.totals.calls, 4, "new calls accrue onto restored history");
  } finally {
    await listener?.close();
    await listener2?.close();
    await upstream.close();
    await upstream2.close();
    await rm(dir, { recursive: true, force: true });
  }
});
