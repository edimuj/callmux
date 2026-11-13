# Dashboard smoke tests

From the repository root, run `npm ci`, `npx playwright install chromium`,
then `npm run test:dashboard`. On Linux, install browser system dependencies
with `npx playwright install --with-deps chromium` instead.

The command builds TypeScript and the embedded single-file dashboard before
running headless Chromium. CI runs it in the `dashboard` job on pushes and PRs.
The suite uses a real callmux listener, a small stdio MCP server and a streaming
reverse proxy, all on OS-assigned ports. Each test owns its temporary state and
closes the listener, child process and proxy. There are no live upstream services,
fixed ports, sleeps or retries. Failure traces are saved in `test-results/`.

The tests check server/tool rendering, authenticated Disable actions (including
the persisted overlay), external `/operations` mounts, and recovery after the
proxy drops connections. Recovery must fetch new backend state without reloading
the page, including changes made during the outage.

To demonstrate failure detection, temporarily replace `<App />` in
`dashboard/src/main.tsx` with `<div>Deliberately broken dashboard</div>`, rebuild
with `npm run build:dashboard`, and run `npx playwright test --grep 'at /$'`.
The page-load assertion fails because the Overview heading is missing. Restore
the source and rebuild before running the passing suite again.
