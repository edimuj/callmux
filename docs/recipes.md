[← Back to README](../README.md)

# Recipes

Recipes are config-defined workflows that agents call by name. Define a multi-step operation once in your config, then any agent in any session can execute it with `callmux_recipe_run` and a single argument.

Think of them as team-wide shortcuts: encoding conventions ("bugs always get the `bug` label"), workflows ("triage means fetch both issues"), and pipelines ("search then analyze") into callable names.

---

## Defining Recipes

Recipes live in the `recipes` section of your config file. Each recipe wraps one of the existing meta-tools — `call`, `parallel`, `batch`, or `pipeline` — and can substitute runtime arguments using `{ "$param": "name" }` placeholders.

### Call Recipe (Single Tool)

The simplest form: one tool call with fixed and dynamic arguments.

```json
{
  "recipes": {
    "open_bug": {
      "description": "Create a labeled bug issue",
      "mode": "call",
      "server": "github",
      "tool": "create_issue",
      "arguments": {
        "title": { "$param": "title" },
        "body": { "$param": "body" },
        "labels": ["bug"]
      }
    }
  }
}
```

The agent calls it with:

```json
{
  "recipe": "open_bug",
  "arguments": {
    "title": "Crash on startup",
    "body": "Steps to reproduce..."
  }
}
```

callmux expands it into `create_issue` with `labels: ["bug"]` baked in. The agent doesn't need to know which labels to use or which server to target.

### Parallel Recipe (Concurrent Fetches)

Fire multiple independent calls at once:

```json
{
  "recipes": {
    "triage_pair": {
      "description": "Fetch two issues for comparison",
      "mode": "parallel",
      "calls": [
        { "server": "github", "tool": "get_issue", "arguments": { "issue_number": { "$param": "first" } } },
        { "server": "github", "tool": "get_issue", "arguments": { "issue_number": { "$param": "second" } } }
      ]
    }
  }
}
```

### Batch Recipe (Bulk Operations)

Same tool, many items:

```json
{
  "recipes": {
    "label_bugs": {
      "description": "Add bug label to multiple issues",
      "mode": "batch",
      "server": "github",
      "tool": "update_issue",
      "items": [
        { "arguments": { "issue_number": { "$param": "issue1" }, "labels": ["bug"] } },
        { "arguments": { "issue_number": { "$param": "issue2" }, "labels": ["bug"] } }
      ]
    }
  }
}
```

### Pipeline Recipe (Chained Steps)

Each step feeds into the next via `inputMapping`:

```json
{
  "recipes": {
    "search_and_analyze": {
      "description": "Search issues then analyze results",
      "mode": "pipeline",
      "steps": [
        { "tool": "search_issues", "arguments": { "query": { "$param": "query" } } },
        { "tool": "analyze", "arguments": {}, "inputMapping": { "data": "$json" } }
      ]
    }
  }
}
```

---

## Recipe Modes

| Mode | Wraps | Description |
|:-----|:------|:------------|
| `call` | `callmux_call` | Single tool call with param substitution |
| `parallel` | `callmux_parallel` | Concurrent calls, results returned together |
| `batch` | `callmux_batch` | Same tool, many items |
| `pipeline` | `callmux_pipeline` | Chained steps with `inputMapping` |

---

## Running Recipes

### `callmux_recipe_run`

Execute a named recipe:

```json
{
  "recipe": "open_bug",
  "arguments": {
    "title": "Crash on startup",
    "body": "Steps to reproduce..."
  }
}
```

### `callmux_recipe_dry_run`

Preview what a recipe will do without executing downstream tools:

```json
{
  "recipe": "open_bug",
  "arguments": {
    "title": "Crash on startup",
    "body": "Steps to reproduce..."
  }
}
```

Returns the expanded calls, cache-hit candidates, and any validation errors. Use this when testing new recipes or debugging `$param` substitution.

---

## The `$param` Placeholder

Use `{ "$param": "name" }` as an **entire JSON value** to mark it for runtime substitution. The placeholder is replaced with the corresponding value from the `arguments` object passed to `callmux_recipe_run`.

Rules:
- `$param` must be the only key in the object — `{ "$param": "x", "extra": true }` is invalid
- Missing params at runtime produce a clear error
- Params can substitute any JSON type: strings, numbers, booleans, arrays, objects

---

## Designing Good Recipes

**Encode team conventions.** If every bug issue gets the same labels, repo, and assignee — that's a recipe. The agent only supplies the title and body.

**Name for discoverability.** Agents see recipe names in `callmux_status`. Use clear, action-oriented names: `open_bug`, `triage_pair`, `search_and_analyze`.

**Add descriptions.** The `description` field shows up in status output, helping agents pick the right recipe without trial-and-error.

**Dry-run first.** When building or modifying recipes, use `callmux_recipe_dry_run` to verify expansion before live execution.

**Prefer recipes over agent instructions.** Instead of telling each agent "when creating bugs, always add the bug label and assign to the triage team," define it once in a recipe. It's enforced at infrastructure level, works across all clients, and survives prompt changes.

---

## See Also

- [Config Reference](config-reference.md) — full config schema including recipes field
- [Meta-Only Mode](meta-only-mode.md) — recipes work seamlessly in meta-only mode
