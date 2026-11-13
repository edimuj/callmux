# Releasing callmux

Releases are published by [release.yml](../.github/workflows/release.yml) on GitHub-hosted Ubuntu runners when a `v*` tag is pushed to `edimuj/callmux`. The first release using this workflow is **0.27.0**. Host installation is a separate manual step.

## One-time npm setup

Before the first publish, Edin must register a GitHub Actions trusted publisher in the `callmux` package settings on npmjs.com:

- Organization/user: `edimuj`
- Repository: `callmux`
- Workflow filename: `release.yml`
- Environment: leave empty (the job does not use a GitHub environment)

The job uses Node 24 and npm 11.19.1, meeting npm's Node >=22.14 and npm >=11.5.1 requirements for [trusted publishing](https://docs.npmjs.com/trusted-publishers/). GitHub's OIDC identity authorizes `npm publish`; no `NPM_TOKEN` or npm login is needed. The workflow grants `id-token: write` and publishes with `--provenance --access public`.

## Prepare and dry run

1. Update `package.json` and `package-lock.json` to the release version (for the first release, `npm version 0.27.0 --no-git-tag-version`). Commit and land the version change on `main`.
2. Wait for **CI** to pass on that exact commit. If the version commit uses `[skip ci]`, run `gh workflow run ci.yml --ref main` and wait for it to pass. Release checks accept a successful push or manual CI run on `main`; a PR run or an older commit's result does not qualify.
3. Run the dry run on `main`:

   ```bash
   gh workflow run release.yml --ref main -f dry_run=true
   gh run list --workflow release.yml
   gh run view <run-id> --log
   ```

Manual runs require `main` and `dry_run=true`. They validate the prospective `v<package.json version>` tag, commit ancestry on `main`, and the latest CI run for the commit, then run `npm ci`, `npm test`, `npm pack`, and the tarball smoke test. Only npm publishing and GitHub release creation are skipped. This dry run does not verify the npm trusted-publisher registration, which must be completed separately.

## Publish

After a successful dry run, tag the same commit and push the tag:

```bash
git fetch origin main
git tag v0.27.0 <validated-commit-sha>
git push origin v0.27.0
```

The tag must equal `v` plus the exact `package.json` version, and its commit must be on `main` with green CI. Tag push events trigger this workflow even when the tagged commit message contains `[skip ci]`. It does not run on pull requests, and jobs in forks are excluded.

The workflow packs once, smoke tests that archive in an isolated consumer (CLI version, MCP initialize, and `tools/list`), and publishes the same archive with provenance. It then creates a GitHub release with generated notes. Check the Actions run, npm version/provenance, and GitHub release before proceeding with installation. A failed run must be investigated before retrying: npm versions are immutable, so if publishing succeeded but GitHub release creation failed, create the missing release separately instead of publishing again.

To demonstrate the version check locally without publishing:

```bash
node scripts/check-release.mjs v0.0.0
# exits nonzero: Release tag v0.0.0 does not match package.json version v<current-version>
```

## Reinstall the host manually

After verifying the release, an operator can reinstall on `macmini2` with `npm install --global callmux@0.27.0`, then restart the relevant service and check `callmux --version`. CI does not connect to or restart hosts.
