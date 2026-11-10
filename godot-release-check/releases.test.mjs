import assert from "node:assert/strict";
import { test } from "node:test";
import { compareStatus, compareVersions, expectedTested, normalizeTested, normalizeVersion, parsePlan, parsePullMarker, parseTag, planMarker, planUpdates, pullMarker, releaseName, selectCandidates, withoutHandled } from "./releases.mjs";

const release = (tag, prerelease, published = "2026-10-01T00:00:00Z") => ({ tag_name: tag, prerelease, draft: false, published_at: published });
const tested = (...names) => normalizeTested(names.map((name) => parseTag(name)));
const names = (releases) => releases.map(releaseName);

const RELEASES = [
  release("4.8-beta2", true, "2026-10-29T14:01:23Z"),
  release("4.7.2-stable", false, "2026-10-20T10:00:00Z"),
  release("4.8-beta1", true, "2026-10-15T21:27:06Z"),
  release("4.7.2-rc1", true, "2026-10-10T10:00:00Z"),
  release("4.8-dev10", true, "2026-10-05T14:33:18Z"),
  release("4.8-dev9", true, "2026-09-25T14:33:18Z"),
  release("4.6.3-stable", false, "2026-09-20T10:00:00Z"),
  release("4.7.1-stable", false, "2026-09-01T10:00:00Z"),
  release("3.6.2-stable", false, "2026-10-25T10:00:00Z"),
];

test("parseTag splits version and status at the last hyphen", () => {
  assert.deepEqual(parseTag("4.7.1-rc1"), { version: "4.7.1", status: "rc1" });
  assert.deepEqual(parseTag("4.8-beta2"), { version: "4.8", status: "beta2" });
  assert.deepEqual(parseTag("4.7.0-stable"), { version: "4.7", status: "stable" });
  assert.equal(parseTag("latest"), null);
});

test("normalizeVersion drops trailing zero patch versions only", () => {
  assert.equal(normalizeVersion("4.7.0"), "4.7");
  assert.equal(normalizeVersion("4.0"), "4.0");
  assert.equal(normalizeVersion(" 4.7.1 "), "4.7.1");
});

test("compareVersions compares numerically", () => {
  assert.ok(compareVersions("4.10", "4.9") > 0);
  assert.ok(compareVersions("4.7", "4.7.1") < 0);
  assert.equal(compareVersions("4.7", "4.7.0"), 0);
});

test("compareStatus orders dev, alpha, beta, rc and stable with numbers", () => {
  assert.ok(compareStatus("dev10", "dev9") > 0);
  assert.ok(compareStatus("beta1", "dev10") > 0);
  assert.ok(compareStatus("rc1", "beta5") > 0);
  assert.ok(compareStatus("stable", "rc3") > 0);
});

test("selectCandidates picks the highest stable per version line and the highest prerelease above all stables", () => {
  assert.deepEqual(names(selectCandidates(RELEASES)), ["3.6.2-stable", "4.6.3-stable", "4.7.2-stable", "4.8-beta2"]);
});

test("selectCandidates orders prereleases by status, not by name or publish date", () => {
  const candidates = selectCandidates([
    release("4.8-dev10", true, "2026-10-01T00:00:00Z"),
    release("4.8-dev9", true, "2026-10-02T00:00:00Z"),
    release("4.7-stable", false),
  ]);
  assert.deepEqual(names(candidates), ["4.7-stable", "4.8-dev10"]);
});

test("selectCandidates drops a prerelease once its version is stable", () => {
  const candidates = selectCandidates([release("4.8-stable", false), release("4.8-rc3", true)]);
  assert.deepEqual(names(candidates), ["4.8-stable"]);
});

test("normalizeTested drops invalid entries and duplicates", () => {
  const result = normalizeTested([
    { version: "4.7.0", status: "Stable" },
    { version: "4.7", status: "stable" },
    { version: "net9", status: "stable" },
    { version: "4.8", status: "dev 7" },
    { version: "4.8", status: "dev7" },
  ]);
  assert.deepEqual(names(result), ["4.7-stable", "4.8-dev7"]);
});

const plan = (candidates, testedNames) =>
  planUpdates(candidates, tested(...testedNames)).map((update) => ({
    release: releaseName(update.release),
    replaced: names(update.replaced),
    newLine: update.newLine,
  }));

test("planUpdates skips releases below the lowest tested version", () => {
  assert.deepEqual(plan(selectCandidates(RELEASES), ["4.7.2-stable", "4.8-beta2"]), []);
});

test("planUpdates updates a version line to its latest patch", () => {
  assert.deepEqual(plan(selectCandidates(RELEASES), ["4.6.2-stable", "4.7.2-stable"]), [
    { release: "4.6.3-stable", replaced: ["4.6.2-stable"], newLine: false },
  ]);
});

test("planUpdates shrinks a version line with several patches to the latest one", () => {
  assert.deepEqual(plan(selectCandidates(RELEASES), ["4.7-stable", "4.7.1-stable", "4.7.2-stable", "4.8-beta2"]), [
    { release: "4.7.2-stable", replaced: ["4.7-stable", "4.7.1-stable"], newLine: false },
  ]);
});

test("planUpdates shrinks and updates a version line in one step", () => {
  assert.deepEqual(plan(selectCandidates(RELEASES), ["4.7-stable", "4.7.1-stable", "4.8-dev7"]), [
    { release: "4.7.2-stable", replaced: ["4.7-stable", "4.7.1-stable"], newLine: false },
    { release: "4.8-beta2", replaced: ["4.8-dev7"], newLine: false },
  ]);
});

test("planUpdates adds a missing version line at or above the lowest tested version", () => {
  assert.deepEqual(plan(selectCandidates(RELEASES), ["4.5-stable", "4.6.3-stable"]), [{ release: "4.7.2-stable", replaced: [], newLine: true }]);
});

test("planUpdates replaces the prereleases of a line once it is stable", () => {
  const candidates = selectCandidates([release("4.8-stable", false), release("4.8-rc3", true)]);
  assert.deepEqual(plan(candidates, ["4.7-stable", "4.8-rc2"]), [{ release: "4.8-stable", replaced: ["4.8-rc2"], newLine: false }]);
});

test("planUpdates skips a prerelease that is not newer than the tested one", () => {
  const candidates = [{ version: "4.8", status: "beta2" }];
  assert.deepEqual(plan(candidates, ["4.7-stable", "4.8-rc1"]), []);
  assert.deepEqual(plan(candidates, ["4.7-stable", "4.8-beta2"]), []);
  assert.deepEqual(plan(candidates, ["4.7-stable", "4.8-dev7"]), [{ release: "4.8-beta2", replaced: ["4.8-dev7"], newLine: false }]);
});

test("planUpdates plans nothing when nothing is tested", () => {
  assert.deepEqual(planUpdates(selectCandidates(RELEASES), []), []);
});

test("planMarker and parsePlan round trip the planned releases", () => {
  const updates = plan(selectCandidates(RELEASES), ["4.7-stable", "4.7.1-stable", "4.8-dev7"]).map((entry) => ({ release: parseTag(entry.release) }));
  const marker = planMarker(updates);
  assert.equal(marker, "<!-- godot-release-plan: 4.7.2-stable,4.8-beta2 -->");
  assert.deepEqual(parsePlan(`text\n${marker}\n`), ["4.7.2-stable", "4.8-beta2"]);
  assert.deepEqual(parsePlan("no marker"), []);
  assert.deepEqual(parsePlan(null), []);
});

test("withoutHandled drops releases listed in closed issues", () => {
  const updates = planUpdates(selectCandidates(RELEASES), tested("4.6.2-stable", "4.7.1-stable", "4.8-dev7"));
  const closed = ["<!-- godot-release-plan: 4.6.3-stable,4.8-beta1 -->", "unrelated"];
  assert.deepEqual(names(withoutHandled(updates, closed).map((update) => update.release)), ["4.7.2-stable", "4.8-beta2"]);
  assert.deepEqual(withoutHandled(updates, []).length, 3);
});

test("expectedTested replaces the updated releases and keeps the others", () => {
  const current = tested("4.6.2-stable", "4.7-stable", "4.7.1-stable", "4.8-dev7");
  const updates = planUpdates(selectCandidates(RELEASES), current);
  assert.deepEqual(names(expectedTested(current, updates)), ["4.6.3-stable", "4.7.2-stable", "4.8-beta2"]);
  assert.deepEqual(names(expectedTested(current, [])), names(current));
});

test("planUpdates plans prereleases only for repositories that already test one", () => {
  assert.deepEqual(plan(selectCandidates(RELEASES), ["4.7-stable"]), [{ release: "4.7.2-stable", replaced: ["4.7-stable"], newLine: false }]);
  assert.deepEqual(plan(selectCandidates(RELEASES), ["4.7.2-stable", "4.6-rc1"]), [
    { release: "4.6.3-stable", replaced: ["4.6-rc1"], newLine: false },
    { release: "4.8-beta2", replaced: [], newLine: true },
  ]);
});

test("pullMarker and parsePullMarker round trip the plan and the commit", () => {
  const marker = pullMarker("4.7.2-stable,4.8-beta2", "0123abcd");
  assert.deepEqual(parsePullMarker(`text
${marker}
`), { plan: "4.7.2-stable,4.8-beta2", sha: "0123abcd" });
  assert.equal(parsePullMarker("no marker"), null);
  assert.equal(parsePullMarker(undefined), null);
});
