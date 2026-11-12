import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTag, releaseName } from "./releases.mjs";
import { applyUpdates, changedLines, findVersions, testedVersions } from "./workflows.mjs";

const names = (entries) => entries.map(releaseName);
const update = (release, replaced = [], newLine = false) => ({ release: parseTag(release), replaced: replaced.map(parseTag), newLine });

// gdUnit4: a stable matrix list with a prerelease include entry, and a commented out entry.
const MATRIX = `jobs:
  unit-tests:
    strategy:
      matrix:
        # If changes are made here, they must be transferred to \`ci-pr-publish-report.yml\`
        godot-version: ['4.7', '4.7.1']  # tested versions
        godot-status: ['stable']
        godot-net: ['.Net', '']
        include:
          - godot-version: '4.8'
            godot-status: 'dev7'
          # - godot-version: '4.6'
          #   godot-status: 'rc1'
    steps:
      - uses: ./.github/actions/unit-test
        with:
          godot-version: \${{ matrix.godot-version }}
          godot-status: \${{ matrix.godot-status }}
`;

// gdUnit4Net: an include entry with more keys before the version.
const INCLUDE = `    strategy:
      matrix:
        gdunit-version: ['v6.2.2']
        godot-version: ['4.7', '4.7.1']
        godot-status: ['stable']
        include:
          - gdunit-version: 'latest'
            windows: true
            godot-version: '4.7.2'
            godot-status: 'stable'
          - gdunit-version: 'v6.2.2'
            godot-version: '4.8'
            godot-status: 'beta2'
            dotnet-version: 'net10.0'
`;

// gdUnit4NetExamples: a step input with its own status key.
const STEP = `      - name: "Install Godot Net"
        uses: ./.github/actions/godot-install
        with:
          godot-version: "4.7"
          godot-mono: true
          godot-status-version: "stable"
`;

// gdUnit4-action: unquoted step inputs without a status, and input definitions.
const PINNED = `on:
  workflow_call:
    inputs:
      godot-version:
        required: true
        type: string
jobs:
  compat:
    steps:
      - uses: ./
        with:
          godot-version: 4.4
          version: 'v6.0.0'
      - uses: ./
        with:
          version: 'v5.1.1'
          godot-version: 4.5
`;

const files = (...entries) => entries.map(([path, content]) => ({ path, content }));

test("findVersions reads matrix lists, include entries and step inputs, but no expressions or comments", () => {
  const found = findVersions(MATRIX);
  assert.deepEqual(
    found.map((entry) => [entry.line, entry.versions, entry.statuses]),
    [
      [5, ["4.7", "4.7.1"], ["stable"]],
      [9, ["4.8"], ["dev7"]],
    ],
  );
});

test("testedVersions combines the versions and statuses of all files", () => {
  assert.deepEqual(names(testedVersions(files(["ci.yml", MATRIX]))), ["4.7-stable", "4.7.1-stable", "4.8-dev7"]);
  assert.deepEqual(names(testedVersions(files(["ci.yml", INCLUDE]))), ["4.7-stable", "4.7.1-stable", "4.7.2-stable", "4.8-beta2"]);
  assert.deepEqual(names(testedVersions(files(["ci.yml", STEP]))), ["4.7-stable"]);
  assert.deepEqual(names(testedVersions(files(["ci.yml", PINNED]))), ["4.4-stable", "4.5-stable"]);
});

test("applyUpdates replaces the patches of a line in a list and updates the prerelease entry", () => {
  const result = applyUpdates(files(["ci.yml", MATRIX]), [update("4.7.2-stable", ["4.7.1-stable"]), update("4.8-beta3", ["4.8-dev7"])]);
  assert.equal(result.manual.length, 0);
  assert.deepEqual(changedLines(MATRIX, result.changed[0].content), [
    "6: - godot-version: ['4.7', '4.7.1']  # tested versions",
    "6: + godot-version: ['4.7', '4.7.2']  # tested versions",
    "11: - godot-status: 'dev7'",
    "11: + godot-status: 'beta3'",
  ]);
  assert.deepEqual(names(testedVersions(result.changed)), ["4.7-stable", "4.7.2-stable", "4.8-beta3"]);
});

test("applyUpdates adds the latest patch next to the base release of a line only", () => {
  const content = "        godot-version: ['4.6', '4.7']\n";
  const other = "        godot-version: ['4.6']\n";
  const { changed, manual } = applyUpdates(files(["ci.yml", content], ["dev.yml", other]), [update("4.7.2-stable")]);
  assert.equal(manual.length, 0);
  assert.deepEqual(changed, [{ path: "ci.yml", content: "        godot-version: ['4.6', '4.7', '4.7.2']\n" }]);
});

test("applyUpdates keeps a step input with the base release and skips the latest one", () => {
  const { changed, manual, skipped } = applyUpdates(files(["ci.yml", STEP]), [update("4.7.2-stable")]);
  assert.deepEqual(changed, []);
  assert.deepEqual(manual, []);
  assert.deepEqual(skipped.map((entry) => releaseName(entry.release)), ["4.7.2-stable"]);
});

test("applyUpdates keeps other versions and the order of a list", () => {
  const content = "        godot-version: ['4.5', '4.6.2', '4.7']\n        godot-status: ['stable']\n";
  const { changed } = applyUpdates(files(["ci.yml", content]), [update("4.6.3-stable", ["4.6.2-stable"])]);
  assert.equal(changed[0].content, "        godot-version: ['4.5', '4.6.3', '4.7']\n        godot-status: ['stable']\n");
});

test("applyUpdates adds a new stable line to every stable list", () => {
  const second = "        godot-version: [\"4.7\"]\n";
  const { changed, manual } = applyUpdates(files(["ci.yml", MATRIX], ["dev.yml", second]), [update("4.9-stable", [], true)]);
  assert.equal(manual.length, 0);
  assert.match(changed[0].content, /godot-version: \['4\.7', '4\.7\.1', '4\.9'\]/);
  assert.equal(changed[1].content, '        godot-version: ["4.7", "4.9"]\n');
});

test("applyUpdates turns a prerelease entry stable when its line is released", () => {
  const { changed } = applyUpdates(files(["ci.yml", MATRIX]), [update("4.8-stable", ["4.8-dev7"])]);
  assert.deepEqual(names(testedVersions(changed)), ["4.7-stable", "4.7.1-stable", "4.8-stable"]);
  assert.match(changed[0].content, /- godot-version: '4\.8'\n {12}godot-status: 'stable'/);
});

test("applyUpdates updates a step input and its separate status key", () => {
  const { changed } = applyUpdates(files(["ci.yml", STEP]), [update("4.7.2-stable", ["4.7-stable"])]);
  assert.equal(changed[0].content, STEP.replace('godot-version: "4.7"', 'godot-version: "4.7.2"'));
});

test("applyUpdates moves pinned step inputs to the latest patch of their line only", () => {
  const { changed, manual } = applyUpdates(files(["ci.yml", PINNED]), [update("4.4.1-stable", ["4.4-stable"]), update("4.7.2-stable", [], true)]);
  assert.equal(changed[0].content, PINNED.replace("godot-version: 4.4", "godot-version: 4.4.1"));
  assert.deepEqual(manual.map((entry) => releaseName(entry.release)), ["4.7.2-stable"]);
});

test("applyUpdates leaves files without a planned version unchanged", () => {
  const { changed, applied } = applyUpdates(files(["ci.yml", INCLUDE]), []);
  assert.deepEqual(changed, []);
  assert.deepEqual(applied, []);
});

test("applyUpdates keeps a compact list separator", () => {
  const { changed } = applyUpdates(files(["ci.yml", "godot-version: [4.6.2,4.7]\n"]), [update("4.6.3-stable", ["4.6.2-stable"])]);
  assert.equal(changed[0].content, "godot-version: [4.6.3,4.7]\n");
});

// gdUnit4-action: a quoted JSON list passed to a reusable workflow, whose matrix sets the status.
const REUSABLE = `jobs:
  unit-test:
    uses: ./.github/workflows/shared-unit-tests.yml
    with:
      godot-versions: '["4.5.1", "4.6.2"]'
`;

test("findVersions reads a quoted JSON version list of a reusable workflow call", () => {
  assert.deepEqual(names(testedVersions(files(["ci.yml", REUSABLE]))), ["4.5.1-stable", "4.6.2-stable"]);
});

test("applyUpdates keeps the outer quotes of a JSON version list", () => {
  const { changed } = applyUpdates(files(["ci.yml", REUSABLE]), [update("4.6.3-stable", ["4.6.2-stable"]), update("4.7.2-stable", [], true)]);
  assert.equal(changed[0].content, REUSABLE.replace(`'["4.5.1", "4.6.2"]'`, `'["4.5.1", "4.6.3", "4.7.2"]'`));
});
