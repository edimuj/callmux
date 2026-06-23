# Observability

callmux has two complementary listener observability stores:

- The dashboard RRD JSON store (`callmux-metrics.json`) keeps compact aggregate counters for history charts.
- The optional SQLite event store (`eventStore`) keeps bounded per-call rows for drill-down and audit queries.

The SQLite store is additive. Enabling it does not replace or disable the existing dashboard metrics.

## Enable Per-Call History

`eventStore` requires Node 24's built-in `node:sqlite` module. It is off by default, so existing listener deployments keep the current no-database behavior until explicitly enabled:

```json
{
  "dashboard": {
    "enabled": true
  },
  "eventStore": {
    "enabled": true,
    "path": "/var/lib/callmux/callmux-events.sqlite",
    "maxRows": 100000,
    "retentionDays": 14,
    "pruneEvery": 100
  }
}
```

If `path` is omitted, listener mode stores `callmux-events.sqlite` beside the config file, or under `~/.config/callmux` when no config file path is available.

## Stored Data

Each completed top-level tool call records:

- timestamp
- requested tool, target tool, downstream server targets
- session id and authenticated principal when available
- duration, status, error class, cache hit
- approximate JSON bytes in and out
- call kind and downstream fan-out count

Tool arguments and raw tool results are not stored in the event store.

## Forwarded-Header Audit

For downstream servers configured with `forwardHeaders`, callmux records an audit row when a call used a session with a configured forwarded header present. The audit row stores:

- downstream server
- downstream tool
- session id
- principal
- forwarded header name

It does not store the header value. This preserves the credential passthrough invariant: callmux can show which credential scope was used without persisting the credential itself.

## Retention

The event store uses SQLite WAL mode and prunes periodically:

- `retentionDays` deletes old events by age.
- `maxRows` keeps only the newest event rows by count.
- `pruneEvery` controls how many completed calls occur between prune passes.

Both bounds can be active together. Deletes cascade to target and forwarded-header audit rows.

## Dashboard Drill-Down

When both `dashboard.enabled` and `eventStore.enabled` are true, the dashboard exposes a Drill-down tab and JSON endpoint:

```bash
curl http://localhost:4860/dashboard/drilldown?range=1h
```

Supported ranges match the existing dashboard charts: `1h`, `today`, `yesterday`, `7d`, and `30d`.

[< Back to README](../README.md)
