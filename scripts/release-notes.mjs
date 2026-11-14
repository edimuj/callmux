#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "https://github.com/edimuj/callmux";
const overrides = JSON.parse(readFileSync(new URL("./release-notes.json", import.meta.url), "utf8"));

export function renderNotes(commits, tag, previousTag, notes = overrides[tag]) {
  const groups = new Map([
    ["Breaking", [...(notes?.breaking ?? [])]],
    ["Features", []],
    ["Fixes", []],
    ["Maintenance", []],
    ["Other changes", []],
  ]);
  for (const { sha, subject, body } of commits) {
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject);
    const [, type, scope, bang, description] = match ?? [];
    if (type === "chore" && scope === "release") continue;
    const breaking = /^BREAKING[ -]CHANGE:\s*(.+(?:\n(?!\s*$).+)*)/m.exec(body)?.[1];
    const group = bang || breaking ? "Breaking"
      : type === "feat" ? "Features"
      : type === "fix" ? "Fixes"
      : ["chore", "ci", "test", "docs", "deps"].includes(type) ? "Maintenance"
      : "Other changes";
    const title = match ? `${scope ? `${scope}: ` : ""}${description}` : subject;
    groups.get(group).push(`${title}${breaking ? ` — ${breaking.replace(/\s+/g, " ").trim()}` : ""} ([${sha.slice(0, 7)}](${repository}/commit/${sha}))`);
  }
  const sections = [...groups].filter(([, entries]) => entries.length)
    .map(([heading, entries]) => `## ${heading}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}`);
  if (previousTag) sections.push(`**Full Changelog**: ${repository}/compare/${previousTag}...${tag}`);
  return `${sections.join("\n\n")}\n`;
}

export function generateNotes(tag, previousTag, cwd = process.cwd(), dryRun = false) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  for (const ref of [tag, previousTag].filter(Boolean)) {
    if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(ref)) throw new Error(`Invalid release tag: ${ref}`);
    if (ref !== tag || !dryRun) git("rev-parse", "--verify", `refs/tags/${ref}^{commit}`);
  }
  const target = dryRun ? "HEAD" : tag;
  if (!previousTag) {
    const tags = git("tag", "--merged", target, "--list", "v[0-9]*").split("\n");
    if (tags.some((candidate) => candidate && candidate !== tag)) {
      previousTag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", tag, target);
    }
  }
  const log = git("log", "--reverse", "--format=%H%x00%s%x00%b%x00", previousTag ? `${previousTag}..${target}` : target);
  const fields = log.split("\0");
  const commits = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    commits.push({ sha: fields[i].trim(), subject: fields[i + 1], body: fields[i + 2] });
  }
  return renderNotes(commits, tag, previousTag);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
  process.stdout.write(generateNotes(args[0], args[1], process.cwd(), process.argv.includes("--dry-run")));
}
