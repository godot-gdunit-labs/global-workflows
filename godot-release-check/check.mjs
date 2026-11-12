import { appendFileSync } from "node:fs";
import { parsePullMarker, planMarker, planUpdates, pullMarker, releaseName, selectCandidates, versionLine, withoutHandled } from "./releases.mjs";
import { parseTemplate, renderIssueBody, selectTaskTemplate, templateLabels, templatePrefix } from "./templates.mjs";
import { applyUpdates, changedLines, testedVersions } from "./workflows.mjs";

const OWNER = process.env.OWNER || "godot-gdunit-labs";
const REPOSITORIES = (process.env.REPOSITORIES ?? "").split(/[\s,]+/).filter(Boolean);
const READ_TOKEN = process.env.GITHUB_TOKEN ?? "";
const BOT_TOKEN = process.env.BOT_TOKEN ?? "";
const ISSUE_ASSIGNEE = process.env.ISSUE_ASSIGNEE ?? "";
const ISSUE_LABEL = process.env.ISSUE_LABEL || "task";
const ISSUE_PREFIX = process.env.ISSUE_PREFIX || "TASK";
const TRIAGE_FAILED_LABEL = process.env.TRIAGE_FAILED_LABEL || "triage:failed";
const PULL_LABELS = (process.env.PULL_LABELS ?? "").split(",").map((label) => label.trim()).filter(Boolean);
const DRY_RUN = process.env.DRY_RUN === "true";
const RELEASES_REPOSITORY = "godotengine/godot-builds";

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  } else {
    console.log(text);
  }
}

async function github(path, { token = READ_TOKEN, method = "GET", body, optional = false } = {}) {
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (optional && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function graphql(query, variables) {
  const result = await github("graphql", { token: BOT_TOKEN, method: "POST", body: { query, variables } });
  if (result.errors) {
    throw new Error(`GraphQL request failed: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

async function loadFile(repository, path) {
  const file = await github(`repos/${OWNER}/${repository}/contents/${path}`, { optional: true });
  return file ? Buffer.from(file.content, "base64").toString("utf8") : null;
}

async function loadWorkflowFiles(repository) {
  const entries = await github(`repos/${OWNER}/${repository}/contents/.github/workflows`);
  const files = [];
  for (const entry of entries.filter((item) => item.type === "file" && /\.ya?ml$/i.test(item.name))) {
    const content = await loadFile(repository, entry.path);
    if (/godot-versions?:/.test(content)) {
      files.push({ path: entry.path, content });
    }
  }
  return files;
}

const TITLE = "Updating the `Godot` versions of the CI matrix";

function repositoryMarker(repository) {
  return `<!-- godot-release-check: ${OWNER}/${repository} -->`;
}

async function findCheckIssues(repository) {
  const query = encodeURIComponent(`repo:${OWNER}/${repository} is:issue in:title "Updating the Godot versions of the CI matrix"`);
  const result = await github(`search/issues?q=${query}&per_page=100`, { token: BOT_TOKEN || READ_TOKEN });
  return result.items.filter((issue) => (issue.body ?? "").includes(repositoryMarker(repository)));
}

function describeUpdate(update) {
  const name = `\`${releaseName(update.release)}\``;
  const line = `\`${versionLine(update.release.version)}\``;
  if (update.replaced.length > 0) {
    return `- replace ${update.replaced.map((entry) => `\`${releaseName(entry)}\``).join(", ")} with ${name}`;
  }
  return update.newLine ? `- add ${name} as the new version line ${line}, confirm that it should be supported` : `- add ${name}`;
}

function manualNote(manual) {
  if (manual.length === 0) {
    return [];
  }
  return ["", "These updates have no version list or entry to update and need a manual change of the workflows:", "", ...manual.map(describeUpdate)];
}

function issueBody(repository, updates, manual, tested, template) {
  const content = {
    description: [
      `New \`Godot\` releases are available that the CI workflows don't test yet, they currently test ${tested.map((entry) => `\`${releaseName(entry)}\``).join(", ")}.`,
      "Each version line is tested with its latest release and, when it is tested, its base release, a pull request with the update is opened automatically:",
      "",
      ...updates.map(describeUpdate),
      ...manualNote(manual),
    ].join("\n"),
    criteria: [
      ...updates.map((update) => `- [ ] The CI matrix tests \`Godot\` \`${releaseName(update.release)}\` as the latest version of the \`${versionLine(update.release.version)}\` line`),
      "- [ ] All CI checks pass",
    ].join("\n"),
  };
  return [renderIssueBody(template, content), "", repositoryMarker(repository), planMarker(updates), ""].join("\n");
}

async function loadIssueTemplate(repository) {
  const entries = (await github(`repos/${OWNER}/${repository}/contents/.github/ISSUE_TEMPLATE`, { optional: true })) ?? [];
  const templates = [];
  for (const entry of entries.filter((item) => item.type === "file" && /\.(ya?ml|md)$/i.test(item.name) && !/^config\.ya?ml$/i.test(item.name))) {
    templates.push(parseTemplate(entry.path, await loadFile(repository, entry.path)));
  }
  return selectTaskTemplate(templates);
}

async function addToProject(issueId, project) {
  const match = /^([^/]+)\/(\d+)$/.exec(project);
  if (!match) {
    return;
  }
  try {
    const { organization } = await graphql("query($login: String!, $number: Int!) { organization(login: $login) { projectV2(number: $number) { id } } }", {
      login: match[1],
      number: Number(match[2]),
    });
    await graphql("mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } } }", {
      projectId: organization.projectV2.id,
      contentId: issueId,
    });
  } catch (error) {
    console.log(`::warning::The issue could not be added to the project ${project}: ${error.message}`);
  }
}

async function createIssue(repository, body, template) {
  const repositoryLabels = (await github(`repos/${OWNER}/${repository}/labels?per_page=100`, { token: BOT_TOKEN })).map((label) => label.name);
  const labels = templateLabels(template, repositoryLabels, ISSUE_LABEL);
  const assignees = template?.assignees.length ? template.assignees : [ISSUE_ASSIGNEE].filter(Boolean);
  const typeName = (template?.type || "Task").toLowerCase();
  const { repository: target } = await graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        issueTypes(first: 20) { nodes { id name } }
        labels(first: 100) { nodes { id name } }
      }
    }`,
    { owner: OWNER, name: repository },
  );
  const assigneeIds = [];
  for (const login of assignees) {
    const { user } = await graphql("query($login: String!) { user(login: $login) { id } }", { login });
    if (user) {
      assigneeIds.push(user.id);
    }
  }
  const { createIssue: created } = await graphql(
    `mutation($repositoryId: ID!, $title: String!, $body: String, $labelIds: [ID!], $assigneeIds: [ID!], $issueTypeId: ID) {
      createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, labelIds: $labelIds, assigneeIds: $assigneeIds, issueTypeId: $issueTypeId }) {
        issue { id number url }
      }
    }`,
    {
      repositoryId: target.id,
      title: TITLE,
      body,
      labelIds: target.labels.nodes.filter((label) => labels.includes(label.name)).map((label) => label.id),
      assigneeIds,
      issueTypeId: target.issueTypes?.nodes.find((type) => type.name.toLowerCase() === typeName)?.id ?? null,
    },
  );
  const title = `${templatePrefix(template, ISSUE_PREFIX)}-${created.issue.number}: ${TITLE}`;
  await github(`repos/${OWNER}/${repository}/issues/${created.issue.number}`, {
    token: BOT_TOKEN,
    method: "PATCH",
    body: { title },
  });
  for (const project of template?.projects ?? []) {
    await addToProject(created.issue.id, project);
  }
  return { text: `${created.issue.url} (created)`, number: created.issue.number, title };
}

function sameText(left, right) {
  const normalize = (text) => (text ?? "").replace(/\r\n/g, "\n").trim();
  return normalize(left) === normalize(right);
}

async function syncIssue(repository, issues, pending, manual, tested, write) {
  const open = issues.find((issue) => issue.state === "open");
  const template = await loadIssueTemplate(repository);
  const body = issueBody(repository, pending, manual, tested, template);
  if (open && sameText(open.body, body)) {
    return { text: `${open.html_url} (up to date)`, number: open.number, title: open.title };
  }
  if (!write) {
    return { text: open ? `${open.html_url} (not updated)` : "not created", number: open?.number, title: open?.title };
  }
  if (open) {
    await github(`repos/${OWNER}/${repository}/issues/${open.number}`, { token: BOT_TOKEN, method: "PATCH", body: { body } });
    return { text: `${open.html_url} (updated)`, number: open.number, title: open.title };
  }
  return createIssue(repository, body, template);
}

function pullBody(repository, issueNumber, updates, manual, plan, sha) {
  return [
    "## Why",
    "",
    "New `Godot` releases are available that the CI workflows don't test yet.",
    "",
    "## What",
    "",
    "Updates the `Godot` versions of the CI matrix, each version line is tested with its latest release and, when it is tested, its base release:",
    "",
    ...updates.map(describeUpdate),
    ...manualNote(manual),
    "",
    "The release check only changed the values of the `godot-version` and `godot-status` keys of the matrix lists, `include` entries and step inputs.",
    "",
    `Closes #${issueNumber}`,
    "",
    repositoryMarker(repository),
    pullMarker(plan, sha),
    "",
  ].join("\n");
}

async function commitFiles(repository, branch, files, message, branchExists) {
  const base = `repos/${OWNER}/${repository}`;
  const { default_branch: defaultBranch } = await github(base, { token: BOT_TOKEN });
  const head = await github(`${base}/git/ref/heads/${defaultBranch}`, { token: BOT_TOKEN });
  const parent = await github(`${base}/git/commits/${head.object.sha}`, { token: BOT_TOKEN });
  const tree = await github(`${base}/git/trees`, {
    token: BOT_TOKEN,
    method: "POST",
    body: { base_tree: parent.tree.sha, tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })) },
  });
  const commit = await github(`${base}/git/commits`, { token: BOT_TOKEN, method: "POST", body: { message, tree: tree.sha, parents: [parent.sha] } });
  if (branchExists) {
    await github(`${base}/git/refs/heads/${branch}`, { token: BOT_TOKEN, method: "PATCH", body: { sha: commit.sha, force: true } });
  } else {
    await github(`${base}/git/refs`, { token: BOT_TOKEN, method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  }
  return { sha: commit.sha, defaultBranch };
}

async function labelPullRequest(repository, number) {
  const base = `repos/${OWNER}/${repository}`;
  const labels = [];
  for (const label of PULL_LABELS) {
    if (await github(`${base}/labels/${encodeURIComponent(label)}`, { token: BOT_TOKEN, optional: true })) {
      labels.push(label);
    }
  }
  if (labels.length > 0) {
    await github(`${base}/issues/${number}/labels`, { token: BOT_TOKEN, method: "POST", body: { labels } });
  }
  if (ISSUE_ASSIGNEE) {
    await github(`${base}/issues/${number}/assignees`, { token: BOT_TOKEN, method: "POST", body: { assignees: [ISSUE_ASSIGNEE] } });
  }
}

async function syncPullRequest(repository, issue, pending, changes) {
  const issueNumber = issue.number;
  const base = `repos/${OWNER}/${repository}`;
  const branch = /^([A-Z][A-Z0-9]*-\d+):/.exec(issue.title ?? "")?.[1] ?? `${ISSUE_PREFIX}-${issueNumber}`;
  const plan = pending.map((update) => releaseName(update.release)).join(",");
  const pulls = await github(`${base}/pulls?state=all&head=${OWNER}:${branch}&per_page=100`, { token: BOT_TOKEN });
  const open = pulls.find((pull) => pull.state === "open");
  if (open && parsePullMarker(open.body)?.plan === plan) {
    return `${open.html_url} (up to date)`;
  }
  const closed = pulls.find((pull) => pull.state === "closed" && parsePullMarker(pull.body)?.plan === plan);
  if (!open && closed) {
    return `${closed.html_url} (closed, not reopened)`;
  }
  const branchRef = await github(`${base}/git/ref/heads/${branch}`, { token: BOT_TOKEN, optional: true });
  const ownCommits = new Set(pulls.map((pull) => parsePullMarker(pull.body)?.sha).filter(Boolean));
  if (branchRef && !ownCommits.has(branchRef.object.sha)) {
    return open ? `${open.html_url} (changed by hand, not updated)` : `branch \`${branch}\` exists, not created`;
  }
  const message = `${branch}: ${TITLE}\n\n${changes.applied.map(describeUpdate).join("\n")}\n`;
  const { sha, defaultBranch } = await commitFiles(repository, branch, changes.changed, message, Boolean(branchRef));
  const body = pullBody(repository, issueNumber, changes.applied, changes.manual, plan, sha);
  if (open) {
    await github(`${base}/pulls/${open.number}`, { token: BOT_TOKEN, method: "PATCH", body: { body } });
    return `${open.html_url} (updated)`;
  }
  const created = await github(`${base}/pulls`, {
    token: BOT_TOKEN,
    method: "POST",
    body: { title: `${branch}: ${TITLE}`, head: branch, base: defaultBranch, body },
  });
  await labelPullRequest(repository, created.number);
  return `${created.html_url} (created)`;
}

function previewChanges(files, changes) {
  for (const file of changes.changed) {
    console.log(`::group::${file.path}`);
    console.log(changedLines(files.find((entry) => entry.path === file.path).content, file.content).join("\n"));
    console.log("::endgroup::");
  }
  return `not created, changes ${changes.changed.map((file) => `\`${file.path}\``).join(", ")}`;
}

async function syncChanges(repository, issues, files, pending, tested, write) {
  const changes = applyUpdates(files, pending);
  const actionable = pending.filter((update) => !changes.skipped.includes(update));
  if (actionable.length === 0) {
    return "no change | no change";
  }
  const issue = await syncIssue(repository, issues, actionable, changes.manual, tested, write);
  let pull = "no change";
  try {
    if (changes.changed.length > 0 && write && issue.number) {
      pull = await syncPullRequest(repository, issue, actionable, changes);
    } else if (changes.changed.length > 0) {
      pull = previewChanges(files, changes);
    }
  } catch (error) {
    process.exitCode = 1;
    pull = "failed";
    console.error(`::error::${repository}: ${error.message}`);
  }
  return `${issue.text} | ${pull}`;
}

async function checkRepository(repository, candidates, write) {
  const files = await loadWorkflowFiles(repository);
  if (files.length === 0) {
    return `| ${repository} | no Godot workflow | | | |`;
  }
  const tested = testedVersions(files);
  const updates = planUpdates(candidates, tested);
  const updateNames = updates.map((update) => releaseName(update.release)).join(", ") || "none";
  const issues = updates.length > 0 ? await findCheckIssues(repository) : [];
  const handled = issues.filter((issue) => issue.state === "closed" && !issue.labels.some((label) => label.name === TRIAGE_FAILED_LABEL));
  const pending = withoutHandled(updates, handled.map((issue) => issue.body));
  const changes = pending.length > 0 ? await syncChanges(repository, issues, files, pending, tested, write) : " | ";
  return `| ${repository} | ${tested.map(releaseName).join(", ")} | ${updateNames} | ${changes} |`;
}

async function main() {
  const candidates = selectCandidates(await github(`repos/${RELEASES_REPOSITORY}/releases?per_page=100`));
  const write = !DRY_RUN && Boolean(BOT_TOKEN);
  summary("## Godot release check\n");
  summary(`Latest release per version line: ${candidates.map((release) => `\`${releaseName(release)}\``).join(", ")}\n`);
  if (DRY_RUN) {
    summary("Dry run, no issue or pull request is created. The changes of the pull requests are shown in the log.\n");
  } else if (!BOT_TOKEN) {
    summary("The GitHub App is not configured, no issue or pull request is created.\n");
  }
  summary("| Repository | Tested | Update to | Issue | Pull request |");
  summary("| --- | --- | --- | --- | --- |");
  for (const repository of REPOSITORIES) {
    try {
      summary(await checkRepository(repository, candidates, write));
    } catch (error) {
      process.exitCode = 1;
      summary(`| ${repository} | check failed | | | |`);
      console.error(`::error::${repository}: ${error.message}`);
    }
  }
}

await main();
