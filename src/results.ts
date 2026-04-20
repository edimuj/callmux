import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface ToolErrorDetails {
  [key: string]: unknown;
}

interface ToolErrorPayload {
  error: {
    code: string;
    message: string;
    details?: ToolErrorDetails;
  };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: formatJson(payload) }],
    structuredContent: payload,
  };
}

export function errorResult(
  code: string,
  message: string,
  details?: ToolErrorDetails
): CallToolResult {
  const payload: ToolErrorPayload = {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };

  return {
    content: [{ type: "text", text: formatJson(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true,
  };
}
