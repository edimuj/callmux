import { Agent, fetch as undiciFetch } from "undici";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * undici's default `headersTimeout`/`bodyTimeout` is a fixed 300_000ms. When a
 * downstream response is withheld past that point (e.g. a long-running tool
 * call whose result only arrives once the underlying command finishes), undici
 * aborts the request at ~300s regardless of any caller-configured deadline
 * (MCP's own `timeout`/`callTimeoutMs`). Route every StreamableHTTP/SSE client
 * transport through a dispatcher with both timeouts disabled so the MCP-level
 * deadline is the only one that governs. See #50.
 */
const noTimeoutDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/**
 * `fetch` implementation for `StreamableHTTPClientTransportOptions.fetch` /
 * `SSEClientTransportOptions.eventSourceInit.fetch` that disables undici's
 * fixed 300s headers/body timeout ceiling. Safe to share across origins — an
 * undici `Agent` pools connections per-origin internally, the same way
 * Node's global fetch dispatcher does.
 */
export const fetchWithoutUndiciTimeout: FetchLike = (url, init) =>
  undiciFetch(url as string | URL, {
    ...(init as Record<string, unknown>),
    dispatcher: noTimeoutDispatcher,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
