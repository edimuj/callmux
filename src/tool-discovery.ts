import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ListToolsResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const MAX_TOOL_LIST_PAGES = 1_000;

/** Discover a complete catalog before publishing it, retaining pages for bridges. */
export async function listAllTools(client: Pick<Client, "listTools">, timeoutMs?: number): Promise<{
  tools: Tool[];
  pages: Map<string | undefined, ListToolsResult>;
}> {
  const tools: Tool[] = [];
  const pages = new Map<string | undefined, ListToolsResult>();
  const signal = timeoutMs !== undefined && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const result = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      signal ? { signal } : undefined
    );
    pages.set(cursor, result);
    for (const tool of result.tools) tools.push(tool);
    cursor = result.nextCursor;
    if (cursor === undefined) return { tools, pages };
    if (pages.has(cursor)) {
      throw new Error(`tools/list pagination repeated cursor ${JSON.stringify(cursor)}`);
    }
  }
  throw new Error(`tools/list pagination exceeded ${MAX_TOOL_LIST_PAGES} pages`);
}
