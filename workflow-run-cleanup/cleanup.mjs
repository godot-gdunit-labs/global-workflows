import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { cell, compactRun, cutoffTime, deletionReason, nextPage, parseRepositories, REASONS, uniqueRuns } from "./rules.mjs";

const OWNER = process.env.OWNER || "godot-gdunit-labs";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const DRY_RUN = process.env.DRY_RUN === "true";
const MAX_LISTED_RUNS = 300;
const MAX_RETRIES = 5;
// The longest wait for a rate limit, a longer wait would exceed the timeout of the job
const MAX_WAIT_SECONDS = 10 * 60;
const API = "https://api.github.com/";

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  } else {
    console.log(text);
  }
}

// Waits as long as GitHub asks for when a rate limit is hit, returns false for any other error
async function waitForRateLimit(response, attempt) {
  if (response.status !== 403 && response.status !== 429) {
    return false;
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  let seconds;
  if (retryAfter > 0) {
    seconds = retryAfter;
  } else if (remaining === "0" && reset > 0) {
    seconds = Math.max(reset - Math.floor(Date.now() / 1000), 1);
  } else if (response.status === 429 || /rate limit/i.test(await response.clone().text())) {
    // a secondary rate limit without a retry-after header asks to wait at least one minute, longer on each retry
    seconds = 60 * 2 ** attempt;
  } else {
    return false;
  }
  if (attempt >= MAX_RETRIES || seconds > MAX_WAIT_SECONDS) {
    throw new Error(`The rate limit is still reached after ${attempt} retries, it resets in ${seconds} seconds`);
  }
  console.log(`Rate limit reached, waiting ${seconds} seconds`);
  await sleep(seconds * 1000);
  return true;
}

async function request(url, method = "GET") {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url.startsWith(API) ? url : `${API}${url}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.ok || response.status === 404 || !(await waitForRateLimit(response, attempt))) {
      return response;
    }
  }
}

async function paginate(path, key, map = (item) => item) {
  const items = [];
  let url = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (url) {
    const response = await request(url);
    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    items.push(...(key ? body[key] : body).map(map));
    url = nextPage(response.headers.get("link"));
  }
  return items;
}

async function loadRefs(repository) {
  const branches = await paginate(`repos/${OWNER}/${repository}/branches`);
  const tags = await paginate(`repos/${OWNER}/${repository}/tags`);
  return new Set([...branches, ...tags].map((ref) => ref.name));
}

function reportRepository({ name, daysToKeep }, total, selected, failed) {
  const counts = Object.values(REASONS)
    .map((reason) => `${reason}: ${selected.filter((entry) => entry.reason === reason).length}`)
    .join(", ");
  const action = DRY_RUN ? "Would delete" : "Deleted";
  const deleted = selected.length - failed.length;
  summary(`## ${name}\n`);
  summary(`Age limit: ${daysToKeep} days. ${action} ${deleted} of ${total} runs (${counts}).\n`);
  if (failed.length > 0) {
    summary(`Failed to delete ${failed.length} runs:\n`);
    for (const { run, error } of failed) {
      summary(`* [${run.id}](${run.html_url}): ${cell(error)}`);
    }
    summary("");
  }
  if (DRY_RUN && selected.length > 0) {
    summary("| Run | Workflow | Branch | Created | Reason |");
    summary("| --- | -------- | ------ | ------- | ------ |");
    for (const { run, reason } of selected.slice(0, MAX_LISTED_RUNS)) {
      summary(`| [${run.id}](${run.html_url}) | ${cell(run.name)} | ${cell(run.head_branch)} | ${run.created_at} | ${reason} |`);
    }
    if (selected.length > MAX_LISTED_RUNS) {
      summary(`\n${selected.length - MAX_LISTED_RUNS} more runs are not listed.`);
    }
    summary("");
  }
}

async function cleanup(repository, now) {
  const fullName = `${OWNER}/${repository.name}`;
  // list runs first so a ref created during the scan is not mistaken for a deleted ref
  const runs = uniqueRuns(await paginate(`repos/${fullName}/actions/runs`, "workflow_runs", compactRun));
  const refs = await loadRefs(repository.name);
  const context = { repository: fullName, refs, cutoff: cutoffTime(now, repository.daysToKeep) };
  const selected = runs
    .map((run) => ({ run, reason: deletionReason(run, context) }))
    .filter((entry) => entry.reason !== null);
  console.log(`${repository.name}: ${selected.length} of ${runs.length} runs to delete`);

  const failed = [];
  if (!DRY_RUN) {
    for (const { run, reason } of selected) {
      const response = await request(`repos/${OWNER}/${repository.name}/actions/runs/${run.id}`, "DELETE");
      // a run that is already gone needs no deletion
      if (response.ok || response.status === 404) {
        console.log(`Deleted run ${run.id} (${reason}): ${run.html_url}`);
      } else {
        const error = `${response.status} ${await response.text()}`;
        console.log(`::warning::Failed to delete run ${run.id} of ${repository.name}: ${error}`);
        failed.push({ run, error });
      }
    }
  }
  reportRepository(repository, runs.length, selected, failed);
  return failed.length;
}

async function main() {
  if (!TOKEN) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  const repositories = parseRepositories(process.env.REPOSITORIES, process.env.DAYS_TO_KEEP, process.env.DAYS_TO_KEEP_OVERRIDES);
  const now = Date.now();
  summary(`# Workflow run cleanup${DRY_RUN ? " (dry run)" : ""}\n`);
  let failures = 0;
  for (const repository of repositories) {
    try {
      failures += await cleanup(repository, now);
    } catch (error) {
      console.log(`::error::Cleanup of ${repository.name} failed: ${error.message}`);
      summary(`## ${repository.name}\n\nThe cleanup failed: ${cell(error.message)}\n`);
      failures++;
    }
  }
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
