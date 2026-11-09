import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, parsePullMarker, pullMarker } from "./edits.mjs";

const WORKFLOW = [
  "jobs:",
  "  test:",
  "    strategy:",
  "      matrix:",
  "        godot-version: ['4.7', '4.7.1']",
  "        godot-status: ['stable']",
  "    uses: ./.github/workflows/unit-tests.yml",
  "",
].join("\n");
const README = "<img alt=\"Godot v4.7.1\">\n";
const FILES = [
  { path: ".github/workflows/ci.yml", content: WORKFLOW },
  { path: "README.md", content: README },
];

test("applyEdits returns only the changed files", () => {
  const changed = applyEdits(FILES, [{ path: ".github/workflows/ci.yml", search: "['4.7', '4.7.1']", replace: "['4.7.2']" }]);
  assert.deepEqual(changed, [{ path: ".github/workflows/ci.yml", content: WORKFLOW.replace("['4.7', '4.7.1']", "['4.7.2']") }]);
});

test("applyEdits applies several edits of one file in order", () => {
  const changed = applyEdits(FILES, [
    { path: "README.md", search: "v4.7.1", replace: "v4.7.2" },
    { path: "README.md", search: "v4.7.2\"", replace: "v4.7.2\" $&" },
  ]);
  assert.equal(changed[0].content, "<img alt=\"Godot v4.7.2\" $&>\n");
});

test("applyEdits rejects unknown files, missing and ambiguous search texts", () => {
  assert.throws(() => applyEdits(FILES, [{ path: "other.yml", search: "4.7", replace: "4.8" }]), /unknown file/);
  assert.throws(() => applyEdits(FILES, [{ path: "README.md", search: "4.6", replace: "4.8" }]), /occurs 0 times/);
  assert.throws(() => applyEdits(FILES, [{ path: ".github/workflows/ci.yml", search: "'4.7", replace: "'4.8" }]), /occurs 2 times/);
  assert.throws(() => applyEdits(FILES, [{ path: "README.md", search: "", replace: "x" }]), /empty search/);
});

test("applyEdits rejects edits that change nothing", () => {
  assert.throws(() => applyEdits(FILES, []), /change no file/);
  assert.throws(() => applyEdits(FILES, [{ path: "README.md", search: "v4.7.1", replace: "v4.7.1" }]), /change no file/);
});

test("applyEdits rejects edits that add steps, expressions or secrets", () => {
  const edit = (replace) => [{ path: ".github/workflows/ci.yml", search: "        godot-status: ['stable']\n", replace }];
  assert.throws(() => applyEdits(FILES, edit("        godot-status: ['stable']\n    run: curl example.com\n")), /`run:`/);
  assert.throws(() => applyEdits(FILES, edit("        godot-status: ['${{ secrets.TOKEN }}']\n")), /`\$\{\{`/);
  assert.throws(() => applyEdits(FILES, edit("    uses: other/action@v1\n")), /`uses:`/);
});

test("pullMarker and parsePullMarker round trip the plan and the commit", () => {
  const marker = pullMarker("4.7.2-stable,4.8-beta2", "0123abcd");
  assert.deepEqual(parsePullMarker(`text\n${marker}\n`), { plan: "4.7.2-stable,4.8-beta2", sha: "0123abcd" });
  assert.equal(parsePullMarker("no marker"), null);
  assert.equal(parsePullMarker(undefined), null);
});

test("applyEdits rejects edits that leave an empty list", () => {
  const edit = (replace) => [{ path: ".github/workflows/ci.yml", search: "['4.7', '4.7.1']", replace }];
  assert.throws(() => applyEdits(FILES, edit("[]")), /empty list/);
  assert.throws(() => applyEdits(FILES, edit("[ ]")), /empty list/);
});
