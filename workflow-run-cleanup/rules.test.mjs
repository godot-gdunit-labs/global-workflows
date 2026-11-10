import assert from "node:assert/strict";
import { test } from "node:test";
import { cell, compactRun, cutoffTime, DAY_MS, deletionReason, nextPage, parseRepositories, REASONS, uniqueRuns } from "./rules.mjs";

const NOW = Date.parse("2026-11-10T00:00:00Z");
const CONTEXT = {
  repository: "owner/repo",
  refs: new Set(["master", "TASK-1", "v6.0.0"]),
  cutoff: cutoffTime(NOW, 12),
};

function run(fields = {}) {
  return {
    status: "completed",
    conclusion: "success",
    head_branch: "master",
    head_repository: "owner/repo",
    created_at: "2026-11-09T00:00:00Z",
    ...fields,
  };
}

test("parseRepositories applies the default and the overrides", () => {
  assert.deepEqual(parseRepositories("a, b c", "12", "b=5"), [
    { name: "a", daysToKeep: 12 },
    { name: "b", daysToKeep: 5 },
    { name: "c", daysToKeep: 12 },
  ]);
});

test("parseRepositories rejects invalid input", () => {
  assert.throws(() => parseRepositories("", "12"), /No repositories/);
  assert.throws(() => parseRepositories("a/b", "12"), /Invalid repository name/);
  assert.throws(() => parseRepositories("a", "0"), /Invalid number of days/);
  assert.throws(() => parseRepositories("a", "1.5"), /Invalid number of days/);
  assert.throws(() => parseRepositories("a", "12", "b=5"), /expected/);
  assert.throws(() => parseRepositories("a", "12", "a"), /expected/);
  assert.throws(() => parseRepositories("a", "12", "a=x"), /Invalid number of days/);
});

test("deletionReason keeps recent runs that are not completed", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
    assert.equal(deletionReason(run({ status, conclusion: null }), CONTEXT), null);
  }
});

test("deletionReason expires old runs regardless of status", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending", "requested", "completed"]) {
    assert.equal(
      deletionReason(run({ status, conclusion: null, created_at: "2020-10-01T00:00:00Z" }), CONTEXT),
      REASONS.expired,
    );
  }
});

test("deletionReason deletes cancelled and skipped runs", () => {
  assert.equal(deletionReason(run({ conclusion: "cancelled" }), CONTEXT), REASONS.cancelled);
  assert.equal(deletionReason(run({ conclusion: "skipped" }), CONTEXT), REASONS.skipped);
});

test("deletionReason deletes runs of deleted repository refs", () => {
  assert.equal(deletionReason(run({ head_branch: "TASK-2" }), CONTEXT), REASONS.deletedRef);
  assert.equal(deletionReason(run({ head_branch: "TASK-1" }), CONTEXT), null);
});

test("deletionReason keeps runs on existing repository refs", () => {
  assert.equal(deletionReason(run({ head_branch: "v6.0.0" }), CONTEXT), null);
});

test("deletionReason ignores the branch of pull requests from forks", () => {
  const fork = { head_branch: "TASK-2", head_repository: "someone/repo" };
  assert.equal(deletionReason(run(fork), CONTEXT), null);
  assert.equal(deletionReason(run({ ...fork, created_at: "2026-10-01T00:00:00Z" }), CONTEXT), REASONS.expired);
});

test("deletionReason ignores the branch of pull requests from deleted forks", () => {
  assert.equal(deletionReason(run({ head_branch: "TASK-2", head_repository: null }), CONTEXT), null);
});

test("compactRun keeps the used fields", () => {
  const full = { ...run({ id: 1, workflow_id: 10, name: "ci", html_url: "u" }), head_repository: { full_name: "owner/repo" }, actor: {} };
  assert.deepEqual(compactRun(full), {
    id: 1,
    name: "ci",
    workflow_id: 10,
    html_url: "u",
    head_branch: "master",
    status: "completed",
    conclusion: "success",
    created_at: "2026-11-09T00:00:00Z",
    head_repository: "owner/repo",
  });
  assert.equal(compactRun({ id: 2, head_repository: null }).head_repository, null);
});

test("uniqueRuns removes runs listed twice", () => {
  assert.deepEqual(uniqueRuns([{ id: 1 }, { id: 2 }, { id: 1 }]), [{ id: 1 }, { id: 2 }]);
});

test("deletionReason deletes runs older than the days to keep", () => {
  const cutoff = new Date(CONTEXT.cutoff).toISOString();
  assert.equal(deletionReason(run({ created_at: cutoff }), CONTEXT), null);
  assert.equal(deletionReason(run({ created_at: new Date(CONTEXT.cutoff - 1000).toISOString() }), CONTEXT), REASONS.expired);
});

test("cutoffTime subtracts the days to keep", () => {
  assert.equal(cutoffTime(NOW, 12), NOW - 12 * DAY_MS);
});

test("nextPage reads the next link", () => {
  const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
  assert.equal(nextPage(link), "https://api.github.com/x?page=2");
  assert.equal(nextPage('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(nextPage(null), null);
});

test("cell escapes Markdown", () => {
  assert.equal(cell("a|b\n`c`"), "a\\|b \\`c\\`");
  assert.equal(cell(null), "");
});
