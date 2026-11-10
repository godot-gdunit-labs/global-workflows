export const DAY_MS = 24 * 60 * 60 * 1000;

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+$/;

export const REASONS = {
  cancelled: "cancelled",
  skipped: "skipped",
  deletedRef: "deleted ref",
  expired: "expired",
};

function parseDays(value, source) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`Invalid number of days to keep in ${source}: '${text}'`);
  }
  return Number(text);
}

function splitList(value) {
  return String(value ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * Builds the cleanup configuration of the listed repositories.
 * `overrides` is a list of `repository=days` entries that replace the default number of days to keep.
 */
export function parseRepositories(repositories, defaultDays, overrides = "") {
  const days = parseDays(defaultDays, "DAYS_TO_KEEP");
  const result = new Map();
  for (const name of splitList(repositories)) {
    if (!REPOSITORY_NAME.test(name)) {
      throw new Error(`Invalid repository name: '${name}'`);
    }
    result.set(name, { name, daysToKeep: days });
  }
  if (result.size === 0) {
    throw new Error("No repositories to clean up");
  }
  for (const entry of splitList(overrides)) {
    const separator = entry.indexOf("=");
    const name = separator < 0 ? entry : entry.slice(0, separator);
    if (separator < 0 || !result.has(name)) {
      throw new Error(`Invalid entry in DAYS_TO_KEEP_OVERRIDES: '${entry}', expected '<listed repository>=<days>'`);
    }
    result.get(name).daysToKeep = parseDays(entry.slice(separator + 1), `DAYS_TO_KEEP_OVERRIDES for ${name}`);
  }
  return [...result.values()];
}

const RUN_FIELDS = ["id", "name", "workflow_id", "html_url", "head_branch", "status", "conclusion", "created_at"];

/** Keeps only the fields of a workflow run that the cleanup uses. */
export function compactRun(run) {
  const result = Object.fromEntries(RUN_FIELDS.map((field) => [field, run[field] ?? null]));
  result.head_repository = run.head_repository?.full_name ?? null;
  return result;
}

/** Removes runs that were listed twice, as new runs shift the pages while they are listed. */
export function uniqueRuns(runs) {
  const seen = new Set();
  return runs.filter((run) => !seen.has(run.id) && seen.add(run.id));
}

/**
 * Returns why a compacted workflow run is deleted, or null to keep it.
 * The retention period applies to runs of every status. The deleted-ref rule only applies to runs from this
 * repository, as the branch of a pull request from a fork is not part of the repository.
 */
export function deletionReason(run, { repository, refs, cutoff }) {
  if (run.status === "completed") {
    if (run.conclusion === "cancelled") {
      return REASONS.cancelled;
    }
    if (run.conclusion === "skipped") {
      return REASONS.skipped;
    }
    if (run.head_repository === repository && run.head_branch && !refs.has(run.head_branch)) {
      return REASONS.deletedRef;
    }
  }
  if (Date.parse(run.created_at) < cutoff) {
    return REASONS.expired;
  }
  return null;
}

export function cutoffTime(now, daysToKeep) {
  return now - daysToKeep * DAY_MS;
}

/** Returns the URL of the next page from a `Link` response header, or null on the last page. */
export function nextPage(link) {
  if (!link) {
    return null;
  }
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** Escapes a value for a Markdown table cell. */
export function cell(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\|`*_[\]<>]/g, (char) => `\\${char}`);
}
