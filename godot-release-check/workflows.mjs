import { compareVersions, normalizeTested, normalizeVersion, releaseName, versionLine } from "./releases.mjs";

// Finds and updates the Godot versions of GitHub Actions workflows without a YAML round trip, so
// comments, quoting and formatting stay untouched. A version is set by a `godot-version` key, as a
// matrix list (`godot-version: ['4.7', '4.7.1']`), a matrix `include` entry or a step input
// (`godot-version: '4.8'`), or by a `godot-versions` JSON list passed to a reusable workflow
// (`godot-versions: '["4.5.1", "4.6.2"]'`). Its status comes from a `godot-status` or `godot-status-version` key of
// the same mapping, and is stable without one. Expressions such as `${{ inputs.godot-version }}`
// and commented out lines are ignored. Lines are only ever replaced, never added or removed.

const KEY = /^(\s*)(-\s+)?([\w-]+):(\s*)(.*)$/;
const VERSION = /^\d+(\.\d+)+$/;
const STATUS = /^[a-z]+\d*$/;

function isComment(line) {
  return line.trim().startsWith("#");
}

function keyColumn(line) {
  const match = /^(\s*)(-\s+)?/.exec(line);
  return { column: match[1].length + (match[2]?.length ?? 0), dash: Boolean(match[2]) };
}

function unquote(text) {
  const quote = text[0];
  return (quote === "'" || quote === '"') && text.endsWith(quote) && text.length > 1 ? { value: text.slice(1, -1), quote } : { value: text, quote: "" };
}

// Splits a key line into the text before the value, the value and a trailing comment.
function parseKey(line) {
  const match = KEY.exec(line);
  if (!match || isComment(line)) {
    return null;
  }
  const rest = match[5];
  const commentAt = rest.search(/\s+#/);
  const raw = commentAt === -1 ? rest : rest.slice(0, commentAt);
  const value = raw.trim();
  return {
    key: match[3],
    prefix: line.slice(0, line.length - rest.length),
    value,
    suffix: rest.slice(value.length + rest.indexOf(value)),
  };
}

// A list is a YAML flow sequence (`['4.7', '4.7.1']`) or a quoted JSON list passed to a reusable
// workflow (`'["4.5.1", "4.6.2"]'`), which keeps its outer quotes.
function parseValue(value) {
  if (!value || value.includes("${{")) {
    return null;
  }
  const outer = unquote(value);
  const list = outer.quote && outer.value.startsWith("[") ? outer.value : value;
  if (list.startsWith("[") && list.endsWith("]")) {
    const items = list.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean).map(unquote);
    if (items.length === 0) {
      return null;
    }
    const separator = /,\S/.test(list) ? "," : ", ";
    return { list: true, raw: items.map((item) => item.value), quote: items[0].quote, separator, outer: list === value ? "" : outer.quote };
  }
  return { list: false, raw: [outer.value], quote: outer.quote };
}

// The lines of the mapping that holds the key at `index`: same key column, until the mapping or
// its list item ends.
function mappingLines(lines, index, column) {
  const result = [];
  for (let j = index - 1; j >= 0 && !keyColumn(lines[index]).dash; j--) {
    if (!lines[j].trim() || isComment(lines[j])) {
      continue;
    }
    const position = keyColumn(lines[j]);
    if (position.column < column) {
      break;
    }
    if (position.column === column) {
      result.push(j);
      if (position.dash) {
        break;
      }
    }
  }
  for (let j = index + 1; j < lines.length; j++) {
    if (!lines[j].trim() || isComment(lines[j])) {
      continue;
    }
    const position = keyColumn(lines[j]);
    if (position.column < column || (position.column === column && position.dash)) {
      break;
    }
    if (position.column === column) {
      result.push(j);
    }
  }
  return result;
}

export function findVersions(content) {
  const lines = content.split("\n");
  const found = [];
  lines.forEach((line, index) => {
    const key = parseKey(line);
    if (key?.key !== "godot-version" && key?.key !== "godot-versions") {
      return;
    }
    const value = parseValue(key.value);
    if (!value || !value.raw.every((version) => VERSION.test(version))) {
      return;
    }
    let status = null;
    for (const j of mappingLines(lines, index, keyColumn(line).column)) {
      const candidate = parseKey(lines[j]);
      if (candidate?.key === "godot-status" || candidate?.key === "godot-status-version") {
        const parsed = parseValue(candidate.value);
        if (parsed && parsed.raw.every((entry) => STATUS.test(entry.toLowerCase()))) {
          status = { line: j, key: candidate, value: parsed };
        }
        break;
      }
    }
    found.push({
      line: index,
      key,
      value,
      versions: value.raw.map(normalizeVersion),
      statuses: status ? status.value.raw.map((entry) => entry.toLowerCase()) : ["stable"],
      status,
    });
  });
  return found;
}

export function testedVersions(files) {
  return normalizeTested(
    files.flatMap((file) =>
      findVersions(file.content).flatMap((entry) => entry.versions.flatMap((version) => entry.statuses.map((status) => ({ version, status })))),
    ),
  );
}

function renderValue(value, items) {
  const quoted = items.map((item) => `${value.quote}${item}${value.quote}`);
  return value.list ? `${value.outer}[${quoted.join(value.separator)}]${value.outer}` : quoted[0];
}

// Applies the planned updates to the workflow files. An update that has no place to go, such as a
// new version line in a repository without a stable matrix list, is returned as manual.
export function applyUpdates(files, updates) {
  const states = files.map((file) => {
    const lines = file.content.split("\n");
    const entries = findVersions(file.content).map((entry) => ({ ...entry, current: entry.value.raw.slice(), currentStatus: entry.status?.value.raw[0] }));
    return { file, lines, entries };
  });
  const applied = [];
  const manual = [];
  for (const update of updates) {
    const target = update.release;
    const replaced = new Set(update.replaced.map(releaseName));
    let used = false;
    for (const { entries } of states) {
      for (const entry of entries) {
        const stableList = entry.value.list && entry.statuses.length === 1 && entry.statuses[0] === "stable";
        if (stableList) {
          if (target.status !== "stable") {
            continue;
          }
          const keep = entry.current.filter((raw) => !replaced.has(`${normalizeVersion(raw)}-stable`));
          const hasLine = entry.current.some((raw) => versionLine(normalizeVersion(raw)) === versionLine(target.version));
          if (keep.length === entry.current.length && !update.newLine && !hasLine) {
            continue;
          }
          if (!keep.some((raw) => normalizeVersion(raw) === target.version)) {
            keep.push(target.version);
          }
          entry.current = keep.sort((a, b) => compareVersions(normalizeVersion(a), normalizeVersion(b)));
          entry.dirty = true;
          used = true;
        } else if (!entry.value.list && replaced.has(`${normalizeVersion(entry.current[0])}-${(entry.currentStatus ?? "stable").toLowerCase()}`)) {
          if (!entry.status && target.status !== "stable") {
            continue;
          }
          entry.current = [target.version];
          if (entry.status) {
            entry.currentStatus = target.status;
          }
          entry.dirty = true;
          used = true;
        }
      }
    }
    (used ? applied : manual).push(update);
  }
  const changed = [];
  for (const { file, lines, entries } of states) {
    for (const entry of entries.filter((item) => item.dirty)) {
      lines[entry.line] = `${entry.key.prefix}${renderValue(entry.value, entry.current)}${entry.key.suffix}`;
      if (entry.status && !entry.status.value.list) {
        lines[entry.status.line] = `${entry.status.key.prefix}${renderValue(entry.status.value, [entry.currentStatus])}${entry.status.key.suffix}`;
      }
    }
    const content = lines.join("\n");
    if (content !== file.content) {
      changed.push({ path: file.path, content });
    }
  }
  return { changed, applied, manual };
}

export function changedLines(before, after) {
  const old = before.split("\n");
  return after
    .split("\n")
    .flatMap((line, index) => (line === old[index] ? [] : [`${index + 1}: - ${old[index].trim()}`, `${index + 1}: + ${line.trim()}`]));
}
