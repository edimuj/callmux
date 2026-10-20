import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool-catalog comparison shared by every place that decides whether a
 * downstream's tools changed (bridge refresh, upstream connect/reconnect, and
 * list_changed refresh). A tool counts as changed when anything in its
 * definition differs — name, description, input/output schema, annotations —
 * not just its name.
 */

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }

  return value;
}

function toolFingerprint(tool: Tool): string {
  return JSON.stringify(stableValue(tool));
}

function toolListFingerprint(tools: Tool[]): string {
  return JSON.stringify(
    tools
      .map(toolFingerprint)
      .sort((left, right) => left.localeCompare(right))
  );
}

export function sameToolList(left: Tool[], right: Tool[]): boolean {
  return toolListFingerprint(left) === toolListFingerprint(right);
}

export interface ToolListDiff {
  addedTools: string[];
  removedTools: string[];
  /** Tools present in both lists whose definition (schema, description, …) differs. */
  changedTools: string[];
}

export function diffToolLists(previous: Tool[], next: Tool[]): ToolListDiff {
  const previousByName = new Map(previous.map((tool) => [tool.name, tool]));
  const nextNames = new Set<string>();
  const addedTools: string[] = [];
  const changedTools: string[] = [];
  for (const tool of next) {
    nextNames.add(tool.name);
    const before = previousByName.get(tool.name);
    if (!before) {
      addedTools.push(tool.name);
    } else if (toolFingerprint(before) !== toolFingerprint(tool)) {
      changedTools.push(tool.name);
    }
  }
  const removedTools = previous
    .map((tool) => tool.name)
    .filter((name) => !nextNames.has(name));
  return {
    addedTools: addedTools.sort(),
    removedTools: removedTools.sort(),
    changedTools: changedTools.sort(),
  };
}
