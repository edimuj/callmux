import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatToolText, type OutputFormat } from "./output-format.js";

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

interface ResultFormatOptions {
  outputFormat?: OutputFormat;
}

export function jsonResult(
  payload: Record<string, unknown>,
  options: ResultFormatOptions = {}
): CallToolResult {
  return {
    content: [
      { type: "text", text: formatToolText(payload, { format: options.outputFormat }) },
    ],
    structuredContent: payload,
  };
}

export function textFirstResultForNonJson(result: CallToolResult): CallToolResult {
  if (result.isError || result.structuredContent === undefined) return result;

  const text = result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");

  try {
    JSON.parse(text);
    return result;
  } catch {
    const { structuredContent: _structuredContent, ...textFirst } = result;
    return textFirst;
  }
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
    content: [{ type: "text", text: formatToolText(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true,
  };
}
