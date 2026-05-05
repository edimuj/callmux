#!/usr/bin/env node

import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function fail(message) {
  console.error(`[public-surface] ${message}`);
  process.exitCode = 1;
}

const metaToolsSource = read("src/meta-tools.ts");
const cliSource = read("src/bin/callmux.ts");
const readme = read("README.md");
const configRef = read("docs/config-reference.md");
const schema = JSON.parse(read("schema.json"));

const metaToolNames = Array.from(
  metaToolsSource.matchAll(/name:\s*"([^"]+)"/g),
  (match) => match[1]
).filter((name) => name.startsWith("callmux_"));

if (metaToolNames.length === 0) {
  fail("no callmux meta-tools found in src/meta-tools.ts");
}

for (const name of metaToolNames) {
  if (!cliSource.includes(name)) {
    fail(`CLI help/source does not mention meta-tool ${name}`);
  }
  if (!readme.includes(`\`${name}\``)) {
    fail(`README is missing meta-tool ${name}`);
  }
}

const schemaProperties = Object.keys(schema.properties ?? {})
  .filter((name) => name !== "$schema" && name !== "mcpServers")
  .sort();

for (const name of schemaProperties) {
  if (!configRef.includes(`\`${name}\``)) {
    fail(`docs/config-reference.md is missing schema property ${name}`);
  }
}

if (!process.exitCode) {
  console.log(
    `[public-surface] ok: ${metaToolNames.length} meta-tools and ${schemaProperties.length} schema properties documented`
  );
}
