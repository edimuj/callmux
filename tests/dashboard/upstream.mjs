import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'smoke', version: '1.0.0' })
server.registerTool('smoke_echo', { description: 'Browser smoke test tool', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'ok' }],
}))
await server.connect(new StdioServerTransport())
