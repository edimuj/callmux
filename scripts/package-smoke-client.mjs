import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (process.argv[2] === "--stub") {
  const server = new McpServer({ name: "package-smoke-stub", version: "1.0.0" });
  server.registerTool("package_smoke", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  await server.connect(new StdioServerTransport());
} else {
  const config = new URL("./callmux.json", import.meta.url);
  await writeFile(config, JSON.stringify({
    exposeMetaTools: false,
    mcpServers: {
      stub: {
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), "--stub"],
      },
    },
  }));
  const client = new Client({ name: "package-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: fileURLToPath(new URL("./node_modules/.bin/callmux", import.meta.url)),
    args: ["--config", fileURLToPath(config)],
    env: { PATH: process.env.PATH, HOME: process.cwd() },
    stderr: "inherit",
  });
  try {
    // connect sends initialize and notifications/initialized over real stdio.
    await client.connect(transport, { timeout: 30_000 });
    assert.equal(client.getServerVersion()?.version, process.argv[2]);
    assert.ok(client.getServerCapabilities()?.tools);
    const { tools } = await client.listTools({}, { timeout: 30_000 });
    assert.deepEqual(tools.map((tool) => tool.name), ["package_smoke"]);
  } finally {
    await client.close();
    await transport.close();
  }
}
