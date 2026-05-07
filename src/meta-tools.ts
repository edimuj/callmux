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
            additionalProperties: false,
          },
        },
      },
      required: ["calls"],
      additionalProperties: false,
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
            additionalProperties: false,
          },
        },
      },
      required: ["tool", "items"],
      additionalProperties: false,
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
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_search_tools",
    description:
      "Search downstream tools by name, server, description, and input field names. " +
      "Use this first in meta-only mode when you know the task but not the exact tool name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query. Empty or omitted returns the first available tools.",
        },
        server: {
          type: "string",
          description: "Optional server name filter.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 50).",
        },
        descriptionMaxLength: {
          type: "number",
          description:
            "Max chars per tool description. 0 disables truncation for this call; omit uses the config default.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "callmux_get_result",
    description:
      "Retrieve a stored full result when a prior call returned a truncated _callmux.ref. " +
      "Supports pagination, optional dot-path selection, field projection, and text search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ref: {
          type: "string",
          description: "Result ref returned in _callmux.ref by a truncated response.",
        },
        path: {
          type: "string",
          description:
            "Optional dot path inside the stored result, for example preview.items or content.",
        },
        offset: {
          type: "number",
          description: "Start offset for arrays or strings (default 0).",
        },
        limit: {
          type: "number",
          description: "Items to return for arrays, or chunks of about 200 chars for strings (default 50, max 100).",
        },
        fields: {
          type: "array",
          description: "Optional field projection for arrays of objects.",
          items: { type: "string" },
        },
        search: {
          type: "string",
          description: "Optional case-insensitive text search before pagination.",
        },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_call",
    description:
      "Call a single tool on a downstream server. Primary way to invoke tools in meta-only mode. " +
      "Use callmux_search_tools to find available tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tool: {
          type: "string",
          description:
            "Tool name to call. Use original name with server param, or qualified name " +
            "(e.g. github__get_issue) without server param in multi-server setups.",
        },
        server: {
          type: "string",
          description: "Target server name (optional if only one server configured)",
        },
        arguments: {
          type: "object",
          description: "Arguments to pass to the tool",
        },
        forceReconnect: {
          type: "boolean",
          description:
            "Force an immediate reconnect attempt when the target server is in reconnect backoff.",
        },
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_dry_run",
    description:
      "Validate and preview callmux calls without executing downstream tools. " +
      "Resolves server routing and argument references ($file/$jsonFile/$yamlFile/$text), " +
      "returns planned calls, cache-hit candidates, and per-call errors.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          description: 'Optional explicit mode: "call", "parallel", "batch", or "pipeline".',
        },
        tool: { type: "string", description: "Tool name for call/batch mode" },
        server: { type: "string", description: "Optional server hint for call/batch mode" },
        arguments: { type: "object", description: "Arguments for call mode" },
        calls: {
          type: "array",
          description: "Parallel mode calls",
          items: {
            type: "object",
            properties: {
              server: { type: "string" },
              tool: { type: "string" },
              arguments: { type: "object" },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
        items: {
          type: "array",
          description: "Batch mode argument items",
          items: {
            type: "object",
            properties: {
              arguments: { type: "object" },
            },
            required: ["arguments"],
            additionalProperties: false,
          },
        },
        steps: {
          type: "array",
          description: "Pipeline mode steps",
          items: {
            type: "object",
            properties: {
              server: { type: "string" },
              tool: { type: "string" },
              arguments: { type: "object" },
              inputMapping: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "callmux_recipe_run",
    description:
      "Run a named recipe from callmux config. Recipes expand into call, parallel, batch, " +
      "or pipeline meta-tool calls and support structured parameter substitution.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipe: {
          type: "string",
          description: "Configured recipe name to run",
        },
        arguments: {
          type: "object",
          description: "Runtime values for { \"$param\": \"name\" } placeholders in the recipe",
        },
      },
      required: ["recipe"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_recipe_dry_run",
    description:
      "Preview a named recipe without executing downstream tools. Expands recipe parameters, " +
      "then validates routing, argument references, cache-hit candidates, and per-call errors.",
    inputSchema: {
      type: "object" as const,
      properties: {
        recipe: {
          type: "string",
          description: "Configured recipe name to preview",
        },
        arguments: {
          type: "object",
          description: "Runtime values for { \"$param\": \"name\" } placeholders in the recipe",
        },
      },
      required: ["recipe"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_cache_clear",
    description: "Clear the callmux result cache. Optionally scope by tool name and/or server.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tool: {
          type: "string",
          description: "Tool name to clear cache for (omit to clear all)",
        },
        server: {
          type: "string",
          description: "Server name to clear cache for (omit to clear all servers)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "callmux_status",
    description:
      "Check the health and status of callmux and its downstream servers. " +
      "Returns instance identity, connected servers, available tools, cache stats, and configuration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "Check a specific server (omit to check all)",
        },
        descriptions: {
          type: "boolean",
          description: "Include tool descriptions in output (default false)",
        },
        descriptionMaxLength: {
          type: "number",
          description:
            "Max chars per tool description. Truncated values end with '...'. " +
            "0 or omit = no limit. Only applies when descriptions is true.",
        },
        recommendations: {
          type: "boolean",
          description:
            "Include lightweight guidance on which callmux meta-tool to use for common patterns (default true).",
        },
        sessions: {
          type: "boolean",
          description:
            "Include listener session cwd diagnostics and scoped stdio client state when running in shared listener mode (default false).",
        },
      },
      additionalProperties: false,
    },
  },
];
