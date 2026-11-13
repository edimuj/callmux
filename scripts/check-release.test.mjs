import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCI, checkTag } from "./check-release.mjs";

test("release tags must exactly match the package version", () => {
  checkTag("v0.27.0", "0.27.0");
  for (const tag of ["v0.26.1", "0.27.0", "v0.27.0-beta.1", "v0.27.0/extra", undefined]) {
    assert.throws(() => checkTag(tag, "0.27.0"), /does not match package.json version/);
  }
});

const successfulRun = {
  head_sha: "release-commit",
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yml",
  run_number: 10,
  status: "completed",
  conclusion: "success",
};

test("releases require green CI for the exact commit on main", () => {
  checkCI([successfulRun], "release-commit");
  checkCI([{ ...successfulRun, event: "workflow_dispatch" }], "release-commit");
  assert.throws(() => checkCI([], "release-commit"), /needs a completed, successful CI/);
  for (const change of [
    { head_sha: "previous-commit" },
    { head_branch: "feature" },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { status: "in_progress", conclusion: null },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "skipped" },
  ]) {
    assert.throws(() => checkCI([{ ...successfulRun, ...change }], "release-commit"),
      /needs a completed, successful CI/);
  }
});

test("a newer pending or failed CI run supersedes an older success", () => {
  for (const change of [
    { status: "queued", conclusion: null },
    { conclusion: "failure" },
  ]) {
    const newer = { ...successfulRun, run_number: 11, ...change };
    for (const runs of [[newer, successfulRun], [successfulRun, newer]]) {
      assert.throws(() => checkCI(runs, "release-commit"), /needs a completed, successful CI/);
    }
  }
  checkCI([{ ...successfulRun, run_number: 9, conclusion: "failure" }, successfulRun], "release-commit");
});
