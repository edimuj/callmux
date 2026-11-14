import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateNotes, renderNotes } from "./release-notes.mjs";

test("conventional commits produce grouped notes and preserve breaking descriptions", () => {
  const commits = [
    ["feat(ui): add search", ""],
    ["fix: handle cancellation", ""],
    ["feat(api)!: replace endpoint", ""],
    ["chore: update runtime", "BREAKING CHANGE: Require Node 22.\nUpgrade before installing.\n\nOther details."],
    ["fix!: remove old option", ""],
    ["docs: revise examples", ""],
    ["deps: update SDK", ""],
    ["ci: check builds", ""],
    ["test: cover retries", ""],
    ["chore: tidy config", ""],
    ["chore(release): 1.2.0", ""],
    ["Explain diagnostics", ""],
    ["refactor: simplify parser", "BREAKING-CHANGE: Drop legacy syntax."],
  ].map(([subject, body], i) => ({ sha: String(i).padStart(40, "a"), subject, body }));
  const notes = renderNotes(commits, "v1.2.0", "v1.1.0", { breaking: ["Manual compatibility note."] });
  const section = (name) => notes.split(`## ${name}\n\n`)[1].split("\n\n")[0];
  assert.match(section("Features"), /ui: add search/);
  assert.match(section("Fixes"), /handle cancellation/);
  for (const title of ["api: replace endpoint", "Require Node 22. Upgrade before installing.",
    "remove old option", "Manual compatibility note.", "Drop legacy syntax."]) {
    assert.ok(section("Breaking").includes(title), title);
  }
  for (const title of ["revise examples", "update SDK", "check builds", "cover retries", "tidy config"]) {
    assert.ok(section("Maintenance").includes(title), title);
  }
  assert.match(section("Other changes"), /Explain diagnostics/);
  assert.doesNotMatch(notes, /chore\(release\)|Other details/);
  assert.match(notes, /https:\/\/github.com\/edimuj\/callmux\/commit\/a+0/);
  assert.match(notes, /compare\/v1.1.0\.\.\.v1.2.0/);
});

test("the CLI reads the tagged range, discovers its predecessor, and supports a first release", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "release-notes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (...args) => execFileSync("git", args, { cwd, env, stdio: "pipe" });
  git("init");
  git("commit", "--allow-empty", "-m", "feat: initial feature");
  git("tag", "v1.0.0");
  git("commit", "--allow-empty", "-m", "fix: range only", "-m", "BREAKING CHANGE: New configuration required.");
  git("tag", "-a", "v1.1.0", "-m", "release");
  git("commit", "--allow-empty", "-m", "feat: unreleased feature");
  const script = new URL("./release-notes.mjs", import.meta.url);
  const notes = execFileSync(process.execPath, [script.pathname, "v1.1.0"], { cwd, env, encoding: "utf8" });
  assert.equal(notes, generateNotes("v1.1.0", "v1.0.0", cwd));
  assert.match(notes, /## Breaking\n\n- range only — New configuration required\./);
  assert.match(notes, /compare\/v1.0.0\.\.\.v1.1.0/);
  assert.doesNotMatch(notes, /initial feature|unreleased feature|## Features|## Maintenance/);
  const initial = generateNotes("v1.0.0", undefined, cwd);
  assert.match(initial, /## Features\n\n- initial feature/);
  assert.doesNotMatch(initial, /Full Changelog/);
  const preview = execFileSync(process.execPath, [script.pathname, "v1.2.0", "--dry-run"], { cwd, env, encoding: "utf8" });
  assert.match(preview, /unreleased feature/);
  assert.match(preview, /compare\/v1.1.0\.\.\.v1.2.0/);
  assert.doesNotMatch(preview, /range only|initial feature/);
  assert.throws(() => generateNotes("--all", undefined, cwd), /Invalid release tag/);
});

test("v0.27.0 includes the manually recorded runtime breaking change", () => {
  const notes = renderNotes([], "v0.27.0", "v0.26.1");
  assert.match(notes, /## Breaking\n\n- Node.js >=22.19.0 is now required/);
});
