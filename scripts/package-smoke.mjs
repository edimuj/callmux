#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "callmux-package-"));
const consumer = join(scratch, "consumer");

function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    timeout: 300_000,
  });
}

try {
  // npm pack must build everything itself; no build or test compilation first.
  run("npm", ["pack", "--pack-destination", scratch], root);
  const archives = (await readdir(scratch)).filter((path) => path.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const archive = join(scratch, archives[0]);
  const paths = run("tar", ["-tzf", archive], root, true).trim().split("\n")
    .map((path) => path.replace(/^package\//, "")).sort();
  for (const path of paths) {
    assert.ok(
      /^(LICENSE|README\.md|package\.json|schema\.json|assets\/dashboard\.html)$/.test(path)
        || (/^dist\/.+\.(js|d\.ts)$/.test(path) && !/(\.test\.|test-fixtures\/)/.test(path)),
      `Unexpected package file: ${path}`,
    );
  }
  for (const required of ["dist/bin/callmux.js", "dist/index.js", "dist/index.d.ts", "assets/dashboard.html", "schema.json"]) {
    assert.ok(paths.includes(required), `Missing package file: ${required}`);
  }
  console.log(`Package contents (${paths.length} files):\n${paths.join("\n")}`);

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", archive], consumer);
  const bin = join(consumer, "node_modules", ".bin", "callmux");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(run(bin, ["--version"], consumer, true).trim(), version);

  // Run from the consumer so SDK imports resolve only from installed dependencies.
  await copyFile(join(root, "scripts", "package-smoke-client.mjs"), join(consumer, "smoke.mjs"));
  run(process.execPath, ["smoke.mjs", version], consumer);
  console.log("Package smoke passed: installed CLI version, MCP initialize and tools/list");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
