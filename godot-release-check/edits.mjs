const GUARDED_TOKENS = ["uses:", "run:", "${{", "secrets."];

function occurrences(text, search) {
  let count = 0;
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + 1)) {
    count++;
  }
  return count;
}

export function applyEdits(files, edits) {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  for (const edit of edits) {
    const content = contents.get(edit.path);
    if (content === undefined) {
      throw new Error(`the edit targets the unknown file ${edit.path}`);
    }
    if (!edit.search) {
      throw new Error(`an edit of ${edit.path} has an empty search text`);
    }
    const found = occurrences(content, edit.search);
    if (found !== 1) {
      throw new Error(`the search text of an edit occurs ${found} times in ${edit.path}, expected exactly once: ${JSON.stringify(edit.search)}`);
    }
    contents.set(edit.path, content.replace(edit.search, () => edit.replace));
  }
  const changed = [];
  for (const file of files) {
    const content = contents.get(file.path);
    if (content === file.content) {
      continue;
    }
    for (const token of GUARDED_TOKENS) {
      if (occurrences(content, token) > occurrences(file.content, token)) {
        throw new Error(`the edits add \`${token}\` to ${file.path}, only Godot versions may change`);
      }
    }
    if (occurrences(content.replace(/\[\s*\]/g, "[]"), ": []") > occurrences(file.content.replace(/\[\s*\]/g, "[]"), ": []")) {
      throw new Error(`the edits leave an empty list in ${file.path}, a matrix list must keep at least one version`);
    }
    changed.push({ path: file.path, content });
  }
  if (changed.length === 0) {
    throw new Error("the edits change no file");
  }
  return changed;
}

const PULL_MARKER = /<!-- godot-release-pull: ([^ >]*) ([0-9a-f]*) -->/;

export function pullMarker(plan, sha) {
  return `<!-- godot-release-pull: ${plan} ${sha} -->`;
}

export function parsePullMarker(body) {
  const match = PULL_MARKER.exec(body ?? "");
  return match ? { plan: match[1], sha: match[2] } : null;
}
