import assert from "node:assert/strict";
import { test } from "node:test";
import { compareStatus, compareVersions, findMissing, normalizeTested, normalizeVersion, parseTag, releaseName, selectCandidates } from "./releases.mjs";

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

test("findMissing skips releases below the lowest tested version", () => {
  const missing = findMissing(selectCandidates(RELEASES), tested("4.7-stable", "4.7.1-stable", "4.8-dev7"));
  assert.deepEqual(names(missing), ["4.7.2-stable", "4.8-beta2"]);
});

test("findMissing reports a patch of an older supported line", () => {
  const missing = findMissing(selectCandidates(RELEASES), tested("4.6-stable", "4.6.2-stable", "4.7.2-stable"));
  assert.deepEqual(names(missing), ["4.6.3-stable", "4.8-beta2"]);
  assert.equal(missing[0].newLine, false);
  assert.equal(missing[1].newLine, true);
});

test("findMissing marks a stable release of an untested line as new line", () => {
  const missing = findMissing(selectCandidates(RELEASES), tested("4.5-stable", "4.6.2-stable"));
  assert.deepEqual(names(missing), ["4.6.3-stable", "4.7.2-stable", "4.8-beta2"]);
  assert.deepEqual(missing.map((entry) => entry.newLine), [false, true, true]);
});

test("findMissing skips a prerelease that is not newer than the tested one", () => {
  const candidates = [{ version: "4.8", status: "beta2" }];
  assert.deepEqual(findMissing(candidates, tested("4.7-stable", "4.8-rc1")), []);
  assert.deepEqual(findMissing(candidates, tested("4.7-stable", "4.8-beta2")), []);
  assert.deepEqual(names(findMissing(candidates, tested("4.7-stable", "4.8-dev7"))), ["4.8-beta2"]);
});

test("findMissing reports nothing when nothing is tested", () => {
  assert.deepEqual(findMissing(selectCandidates(RELEASES), []), []);
});
