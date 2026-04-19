import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Meta-tool definitions that callmux exposes alongside proxied tools.
 */
export const META_TOOLS: Tool[] = [
  {
    name: "callmux_parallel",
    description:
      "Execute multiple tool calls in parallel. Returns all results at once. " +
      "Use when you need to make several independent calls that don't depend on each other.",
    inputSchema: {
      type: "object" as const,
      properties: {
        calls: {
          type: "array",
          description: "Array of tool calls to execute concurrently",
          items: {
            type: "object",
            properties: {
              server: {
                type: "string",
                description: "Target server name (optional if only one server configured)",
              },
              tool: { type: "string", description: "Tool name to call" },
              arguments: {
                type: "object",
                description: "Arguments to pass to the tool",
              },
            },
            required: ["tool"],
          },
        },
      },
      required: ["calls"],
    },
  },
  {
    name: "callmux_batch",
    description:
      "Apply the same tool call across multiple items. Like parallel() but for " +
      "the common case of calling one tool many times with different arguments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "Target server name (optional if only one server)",
        },
        tool: { type: "string", description: "Tool name to call for each item" },
        items: {
          type: "array",
          description: "Array of argument objects, one per call",
          items: {
            type: "object",
            properties: {
              arguments: {
                type: "object",
                description: "Arguments for this call",
              },
            },
            required: ["arguments"],
          },
        },
      },
      required: ["tool", "items"],
    },
  },
  {
    name: "callmux_pipeline",
    description:
      "Chain tool calls where each step can use output from the previous step. " +
      "Use inputMapping to extract values from the previous result's text content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        steps: {
          type: "array",
          description: "Ordered array of tool calls to execute sequentially",
          items: {
            type: "object",
            properties: {
              server: { type: "string", description: "Target server name (optional)" },
              tool: { type: "string", description: "Tool name" },
              arguments: { type: "object", description: "Base arguments" },
              inputMapping: {
                type: "object",
                description:
                  "Map of argument names to JSONPath-like expressions to extract from the previous step's result. " +
                  'Use "$text" for the full text content, "$json" to parse as JSON, or "$json.field.path" for nested fields.',
                additionalProperties: { type: "string" },
              },
            },
            required: ["tool"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "callmux_cache_clear",
    description: "Clear the callmux result cache. Optionally clear only a specific tool's cache.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tool: {
          type: "string",
          description: "Tool name to clear cache for (omit to clear all)",
        },
      },
    },
  },
];
