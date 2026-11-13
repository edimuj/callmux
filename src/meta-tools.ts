import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const OUTPUT_FORMAT_PROPERTY = {
  type: "string",
  enum: ["json", "toon", "auto"],
  description:
    "Optional model-facing text output format. structuredContent remains JSON.",
} as const;

const DETAIL_PROPERTY = {
  type: "string",
  enum: ["full", "brief"],
  description:
    "full (default) inlines every result. brief: counts, failedIndexes, capped failures; every result stays at full.ref, path results.<index>.",
} as const;

/**
 * One batch item: canonical `{arguments: {...}}` or a flat argument object.
 * Flat keys other than cwd/timeoutMs become the tool's arguments; the runtime
 * rejects items that mix `arguments` with other downstream keys.
 */
const BATCH_ITEM_SCHEMA = {
  type: "object",
  description:
    "{arguments:{...}} or flat {...}. Flat cwd/timeoutMs stay callmux overrides (also sent if the tool declares them); wrap to send them only to the tool.",
  properties: {
    arguments: {
      type: "object",
      description: "Arguments for this call",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      description: "Optional timeout in milliseconds for this item.",
    },
    cwd: {
      type: "string",
      description: "Optional absolute cwd override for this item.",
    },
  },
  additionalProperties: true,
} as const;

/**
 * Meta-tool definitions that callmux exposes alongside proxied tools.
 */
export const META_TOOLS: Tool[] = [
  {
    name: "callmux_parallel",
    description:
      "Run independent calls concurrently: {calls:[{tool,server?,arguments}]}. " +
      "Returns status, counts, failedIndexes and per-call results; retry only failedIndexes.",
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
              timeoutMs: {
                type: "integer",
                minimum: 1,
                description:
                  "Optional timeout in milliseconds for this downstream tool call.",
              },
              cwd: {
                type: "string",
                description:
                  "Optional absolute cwd override for session-cwd stdio servers.",
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
        detail: DETAIL_PROPERTY,
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      required: ["calls"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_batch",
    description:
      'Call one tool per item: {"tool":"get_item","items":[{"arguments":{"id":"1"}}]}; flat items [{"id":"1"}] also work. ' +
      "Retry only failedIndexes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "Target server name (optional if only one server)",
        },
        tool: { type: "string", description: "Tool name to call for each item" },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description:
            "Optional timeout in milliseconds applied to each item unless the item sets timeoutMs.",
        },
        cwd: {
          type: "string",
          description:
            "Optional absolute cwd override applied to each item unless the item sets cwd.",
        },
        items: {
          type: "array",
          description: "One entry per call: {arguments:{...}} or flat argument object",
          items: BATCH_ITEM_SCHEMA,
        },
        detail: DETAIL_PROPERTY,
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      required: ["tool", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_pipeline",
    description:
      "Run dependent steps in order: {steps:[{tool,arguments,inputMapping}]}. " +
      "On failure it stops and returns status=failed, failedStep and prior outputs.",
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
              timeoutMs: {
                type: "integer",
                minimum: 1,
                description:
                  "Optional timeout in milliseconds for this downstream tool call.",
              },
              cwd: {
                type: "string",
                description:
                  "Optional absolute cwd override for session-cwd stdio servers.",
              },
              inputMapping: {
                type: "object",
                description:
                  'Argument name -> expression on the previous result: "$text" (full text), "$json" (parsed JSON) or "$json.field.path".',
                additionalProperties: { type: "string" },
              },
              onMappingMissing: {
                type: "string",
                description:
                  'Behavior when inputMapping entries cannot be resolved. Default "continue" preserves recoverable behavior; "fail" stops before executing the step.',
                enum: ["continue", "fail"],
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_search_tools",
    description:
      "Find downstream tools by name, server, description or field. Use first when the tool name is unknown. " +
      "includeSchema:true adds types, required and enums.",
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
          type: "integer",
          minimum: 1,
          description: "Max results to return (default 10, max 50).",
        },
        descriptionMaxLength: {
          type: "integer",
          minimum: 0,
          description:
            "Max chars per tool description. 0 disables truncation for this call; omit uses the config default.",
        },
        includeSchema: {
          type: "boolean",
          description:
            "Include each result's full inputSchema (types, required, enums). Default false keeps results compact.",
        },
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      additionalProperties: false,
    },
  },
  {
    name: "callmux_get_result",
    description:
      "Page a stored result by ref: {ref,path?,offset?,limit?,fields?,search?}. " +
      "If deferred, use callmux_call with tool=callmux_get_result and arguments={ref}.",
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
          type: "integer",
          minimum: 0,
          description: "Start offset for arrays or strings (default 0).",
        },
        limit: {
          type: "integer",
          minimum: 1,
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
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_call",
    description:
      "Call one tool: {tool,server?,arguments}; server is optional if the name is unique. " +
      "Find it via callmux_search_tools. tool=callmux_get_result pages refs.",
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
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "Optional timeout in milliseconds for this downstream tool call.",
        },
        cwd: {
          type: "string",
          description: "Optional absolute cwd override for session-cwd stdio servers.",
        },
        forceReconnect: {
          type: "boolean",
          description:
            "Force an immediate reconnect attempt when the target server is in reconnect backoff.",
        },
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_dry_run",
    description:
      "Preview call/parallel/batch/pipeline input without executing: resolves routing and $file/$text refs; " +
      "returns planned calls, warnings and per-call errors.",
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
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description: "Optional timeout in milliseconds for call/batch mode.",
        },
        cwd: {
          type: "string",
          description: "Optional absolute cwd override for call/batch mode.",
        },
        calls: {
          type: "array",
          description: "Parallel mode calls",
          items: {
            type: "object",
            properties: {
              server: { type: "string" },
              tool: { type: "string" },
              arguments: { type: "object" },
              timeoutMs: { type: "integer", minimum: 1 },
              cwd: { type: "string" },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
        items: {
          type: "array",
          description: "Batch mode items: {arguments:{...}} or flat argument object",
          items: BATCH_ITEM_SCHEMA,
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
              timeoutMs: { type: "integer", minimum: 1 },
              cwd: { type: "string" },
              inputMapping: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              onMappingMissing: {
                type: "string",
                enum: ["continue", "fail"],
              },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
        outputFormat: OUTPUT_FORMAT_PROPERTY,
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
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      required: ["recipe"],
      additionalProperties: false,
    },
  },
  {
    name: "callmux_recipe_dry_run",
    description:
      "Preview a named recipe without executing: expands parameters, then validates routing, " +
      "argument refs, cache-hit candidates and per-call errors.",
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
        outputFormat: OUTPUT_FORMAT_PROPERTY,
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
      "Check callmux and downstream server health. Returns instance identity, servers, tools, " +
      "cache stats and config. Use it when routing fails.",
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
          type: "integer",
          minimum: 0,
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
        outputFormat: OUTPUT_FORMAT_PROPERTY,
      },
      additionalProperties: false,
    },
  },
];
