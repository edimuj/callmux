import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { fetchWithoutUndiciTimeout } from "./http-fetch.js";

// Regression for #50: undici's fixed 300s headersTimeout/bodyTimeout used to
// pre-empt long tool calls regardless of the caller's configured deadline.
// Rather than waiting out the real 300s default, this pins a short-timeout
// dispatcher to prove a withheld response trips it, then proves
// fetchWithoutUndiciTimeout (used by every StreamableHTTP/SSE transport) is
// unaffected by the same withheld response.
test("fetchWithoutUndiciTimeout is not pre-empted by undici's timeout ceiling", async () => {
  const RESPONSE_DELAY_MS = 2_000;
  const LOW_TIMEOUT_MS = 200;

  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("done");
    }, RESPONSE_DELAY_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;

  try {
    // Baseline: a dispatcher with a short timeout aborts before the withheld
    // response arrives — confirms the response really is withheld past the
    // low threshold, not just slow test scheduling.
    const timedDispatcher = new Agent({ headersTimeout: LOW_TIMEOUT_MS, bodyTimeout: LOW_TIMEOUT_MS });
    await assert.rejects(() => undiciFetch(url, { dispatcher: timedDispatcher }), /fetch failed/i);

    // Fix: fetchWithoutUndiciTimeout disables undici's ceiling, so the same
    // withheld response — held well past LOW_TIMEOUT_MS — completes instead
    // of being aborted at the fixed default.
    const response = await fetchWithoutUndiciTimeout(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "done");
  } finally {
    server.close();
  }
});
