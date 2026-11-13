#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkTag(tag, version) {
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package.json version v${version}`);
  }
}

export function checkCI(runs, sha) {
  const latest = runs.filter((run) => run.head_sha === sha && run.head_branch === "main"
    && ["push", "workflow_dispatch"].includes(run.event)
    && run.path === ".github/workflows/ci.yml")
    .sort((a, b) => b.run_number - a.run_number)[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error(`Commit ${sha} needs a completed, successful CI run on main`);
  }
}

function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  checkTag(process.argv[2], version);
  const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
  const sha = run("git", ["rev-parse", "HEAD"]);
  run("git", ["fetch", "origin", "main"]);
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp",
    `repos/edimuj/callmux/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&per_page=100`]));
  checkCI(pages.flatMap((page) => page.workflow_runs), sha);
  console.log(`Release checks passed: v${version}, commit ${sha} on main with green CI`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
