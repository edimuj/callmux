export type AgentInstructionsProfile = "generic" | "codex" | "claude";
export type AgentInstructionsMode = "standard" | "meta-only";

interface AgentInstructionsOptions {
  profile?: AgentInstructionsProfile;
  mode?: AgentInstructionsMode;
}

export function renderAgentInstructions(
  options: AgentInstructionsOptions = {}
): string {
  const profile = options.profile ?? "generic";
  const mode = options.mode ?? "standard";
  const lines = [
    "# callmux Agent Instructions",
    "",
    `Profile: ${profile}`,
    `Mode: ${mode}`,
    "",
    "- Prefer `callmux_parallel` for independent calls and `callmux_batch` for many calls to the same tool.",
    "- Use `callmux_pipeline` for dependent steps. Results include `status`, `failedStep`, `mappedArguments`, and `skippedMappings`.",
    "- For required pipeline mappings, set `onMappingMissing: \"fail\"` so missing IDs/targets stop before side effects.",
    "- Retry only failed `failedIndexes` from `callmux_parallel` or `callmux_batch`; successful siblings are already complete.",
    "- Use `callmux_call` when direct downstream tools are hidden or when `callmux_get_result` is deferred by the client.",
    "- Run `callmux_dry_run` before mutating multi-step workflows; treat per-item `warnings` as safety issues to fix first.",
    "- Use absolute `cwd` overrides for session-cwd stdio tools when client cwd/roots are unreliable.",
    "- Use `$file` or `$text` for markdown/string fields such as issue `body`, `description`, `comment`, `text`, or `content`.",
    "- Use `$jsonFile` or `$yamlFile` only when the downstream field expects structured data.",
    "- `$json` and `$json.path` are pipeline `inputMapping` expressions only; never put literal `$json` in normal arguments.",
    "- If a response is shielded/truncated, follow `_callmux.retrieval` with `callmux_get_result` to page/filter/project the stored result.",
    "- Use `outputFormat: \"toon\"` or `\"auto\"` on large tabular meta-tool outputs when model-facing JSON is too verbose.",
    "- Prefer `callmux_search_tools` or `callmux_status` to discover wrapped tools instead of guessing names.",
  ];

  if (mode === "meta-only") {
    lines.push(
      "- In meta-only mode, discover downstream tools first, then call them through `callmux_call`, recipes, or fan-out meta-tools."
    );
  }

  return `${lines.join("\n")}\n`;
}
