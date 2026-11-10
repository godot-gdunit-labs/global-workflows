import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTemplate, renderIssueBody, selectTaskTemplate, templateLabels, templatePrefix } from "./templates.mjs";

const FORM = `name: Task
description: A small task to implement/fix non-API related work
title: "TASK-XXX: Brief description of the task"
labels: ["API", "task"]
projects: ["godot-gdunit-labs/3"]
type: task
assignees:
  - MikeSchulze

body:
  - type: markdown
    attributes:
      value: A Task is not a bug or feature request!
  - type: dropdown
    id: task-category
    attributes:
      label: Task Category
      options:
        - Code maintenance/cleanup
        - Build/CI improvements
      default: 0
    validations:
      required: true
  - type: textarea
    id: task-description
    attributes:
      label: Task Description
    validations:
      required: true
  - type: textarea
    id: acceptance-criteria
    attributes:
      label: Acceptance Criteria
    validations:
      required: true
  - type: textarea
    id: notes
    attributes:
      label: Notes
  - type: checkboxes
    id: task-checklist
    attributes:
      label: Pre-work Checklist
      options:
        - label: I have confirmed this is not a duplicate task
        - label: The acceptance criteria are clear and testable
          required: true
`;

const MARKDOWN = `---
name: Task
about: A small task to implement
title: ''
labels: task
assignees: MikeSchulze

---

## A Task is not a bug or feature request

### Description
<!-- Describe the task you want to do -->

### Acceptance criteria
<!-- Define the acceptance criteria here to accept the task as done -->
`;

const BUG = `name: Bug Report
title: "GD-XXX: Describe the bug"
type: bug
body: []
`;

const CONTENT = { description: "New releases are available.", criteria: "- [ ] The CI matrix is updated" };

test("parseTemplate reads issue forms and markdown templates", () => {
  const form = parseTemplate(".github/ISSUE_TEMPLATE/task.yml", FORM);
  assert.equal(form.kind, "form");
  assert.deepEqual(form.labels, ["API", "task"]);
  assert.deepEqual(form.assignees, ["MikeSchulze"]);
  assert.deepEqual(form.projects, ["godot-gdunit-labs/3"]);
  assert.equal(form.type, "task");
  const markdown = parseTemplate(".github/ISSUE_TEMPLATE/task.md", MARKDOWN.replace(/\n/g, "\r\n"));
  assert.equal(markdown.kind, "markdown");
  assert.deepEqual(markdown.labels, ["task"]);
  assert.deepEqual(markdown.assignees, ["MikeSchulze"]);
  assert.ok(markdown.text.startsWith("## A Task"));
});

test("selectTaskTemplate prefers the task issue form and ignores other templates", () => {
  const bug = parseTemplate("bug.yml", BUG);
  const form = parseTemplate("task.yml", FORM);
  const markdown = parseTemplate("task.md", MARKDOWN);
  assert.equal(selectTaskTemplate([bug, markdown, form]), form);
  assert.equal(selectTaskTemplate([bug, markdown]), markdown);
  assert.equal(selectTaskTemplate([bug]), null);
});

test("templatePrefix reads the issue ID prefix from the template title", () => {
  assert.equal(templatePrefix(parseTemplate("task.yml", FORM), "X"), "TASK");
  assert.equal(templatePrefix(parseTemplate("task.md", MARKDOWN), "TASK"), "TASK");
  assert.equal(templatePrefix(null, "TASK"), "TASK");
});

test("templateLabels replaces the generic API label with the CI label and drops unknown labels", () => {
  const form = parseTemplate("task.yml", FORM);
  assert.deepEqual(templateLabels(form, ["API", "CI", "task"], "task"), ["CI", "task"]);
  assert.deepEqual(templateLabels(form, ["API", "task"], "task"), ["task"]);
  assert.deepEqual(templateLabels(null, ["task", "ci"], "task"), ["task"]);
  assert.deepEqual(templateLabels(null, ["bug"], "task"), []);
});

test("renderIssueBody fills every field of an issue form like GitHub renders it", () => {
  const body = renderIssueBody(parseTemplate("task.yml", FORM), CONTENT);
  assert.equal(
    body,
    [
      "### Task Category",
      "",
      "Build/CI improvements",
      "",
      "### Task Description",
      "",
      "New releases are available.",
      "",
      "### Acceptance Criteria",
      "",
      "- [ ] The CI matrix is updated",
      "",
      "### Notes",
      "",
      "_No response_",
      "",
      "### Pre-work Checklist",
      "",
      "- [ ] I have confirmed this is not a duplicate task",
      "- [X] The acceptance criteria are clear and testable",
    ].join("\n"),
  );
});

test("renderIssueBody rejects a required form field it can't fill", () => {
  const form = parseTemplate("task.yml", FORM.replace("label: Notes", "label: Affected Areas\n    validations:\n      required: true"));
  assert.throws(() => renderIssueBody(form, CONTENT), /required field `notes`/);
});

test("renderIssueBody replaces the placeholders of a markdown template", () => {
  const body = renderIssueBody(parseTemplate("task.md", MARKDOWN), CONTENT);
  assert.equal(
    body,
    [
      "## A Task is not a bug or feature request",
      "",
      "### Description",
      "New releases are available.",
      "",
      "### Acceptance criteria",
      "- [ ] The CI matrix is updated",
    ].join("\n"),
  );
});

test("renderIssueBody uses a description and acceptance criteria without a template", () => {
  assert.equal(
    renderIssueBody(null, CONTENT),
    "### Description\n\nNew releases are available.\n\n### Acceptance criteria\n\n- [ ] The CI matrix is updated",
  );
});
