import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { XMLValidator } from "fast-xml-parser";
import { parse as parseJsonc } from "jsonc-parser";
import { lint as lintMarkdown } from "markdownlint/promise";
import { minimatch } from "minimatch";

const CENTRAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHUNK_SIZE = 200;
const TOOL_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" };

const GROUPS = {
  yaml: (file) => /\.ya?ml$/i.test(file),
  workflows: (file) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file),
  markdown: (file) => /\.md$/i.test(file),
  json: (file) => /\.json$/i.test(file),
  js: (file) => /\.[cm]?js$/i.test(file),
  xml: (file) => /\.xml$/i.test(file),
  gdscript: (file) => /\.gd$/i.test(file),
};
GROUPS.editorconfig = (file) => ["yaml", "markdown", "json", "js", "xml"].some((group) => GROUPS[group](file));
GROUPS.gdformat = GROUPS.gdscript;

const CHECK_TITLES = {
  editorconfig: "Line endings, final newline and whitespace",
  yaml: "YAML",
  workflows: "GitHub Actions workflows",
  markdown: "Markdown",
  json: "JSON syntax",
  xml: "XML syntax",
  js: "JavaScript",
  gdscript: "GDScript lint",
  gdformat: "GDScript format",
};

let errorCount = 0;
let warningCount = 0;
const findingsByFile = new Map();

const escapeData = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (value) => escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
const toLine = (value) => Math.max(1, Number.parseInt(value, 10) || 1);
const centralFile = (name) => path.join(CENTRAL_DIR, name);
const asArgument = (file) => `./${file}`;
const fromArgument = (file) => file.replace(/^\.\//, "");

function report(level, file, line, column, message) {
  if (level === "error") {
    errorCount++;
  } else {
    warningCount++;
  }
  findingsByFile.set(file, (findingsByFile.get(file) ?? 0) + 1);
  const properties = [`file=${escapeProperty(file)}`, `line=${toLine(line)}`];
  if (column) {
    properties.push(`col=${toLine(column)}`);
  }
  process.stdout.write(`::${level} ${properties.join(",")}::${escapeData(message)}\n`);
}

function toolFailure(tool, result) {
  errorCount++;
  process.stdout.write(`::error::${escapeData(`${tool} failed with exit code ${result.status}`)}\n`);
  for (const line of `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/)) {
    if (line.trim()) {
      process.stdout.write(`    ${line}\n`);
    }
  }
}

function runTool(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: TOOL_ENV, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function* chunks(files) {
  for (let index = 0; index < files.length; index += CHUNK_SIZE) {
    yield files.slice(index, index + CHUNK_SIZE);
  }
}

function readRepositoryIgnore() {
  const name = process.env.REPOSITORY_NAME ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) {
    throw new Error(`Invalid repository name: ${name}`);
  }
  const file = centralFile(path.join("ignore", `${name}.txt`));
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readIgnorePatterns() {
  const defaults = readFileSync(centralFile("default-ignore.txt"), "utf8");
  return `${defaults}\n${readRepositoryIgnore()}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function readGdstyleExcludes() {
  const config = readFileSync(centralFile("gdstyle.toml"), "utf8");
  const block = /^exclude\s*=\s*\[([\s\S]*?)\]/m.exec(config)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .flatMap((pattern) => (/[*/]/.test(pattern) ? [pattern] : [`${pattern}/**`, `**/${pattern}/**`]));
}

function collect(repoDir, listDir) {
  const patterns = readIgnorePatterns();
  const gdstyleExcludes = readGdstyleExcludes();
  const isGdstyleExcluded = (file) => gdstyleExcludes.some((pattern) => minimatch(file, pattern, { dot: true }));
  const entries = execFileSync("git", ["-C", repoDir, "ls-files", "--stage", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const files = [...new Set(entries
    .filter((entry) => entry.startsWith("100"))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .filter((file) => !patterns.some((pattern) => minimatch(file, pattern, { dot: true }))))];

  mkdirSync(listDir, { recursive: true });
  for (const [group, matches] of Object.entries(GROUPS)) {
    const list = files.filter(matches).filter((file) => !GROUPS.gdscript(file) || !isGdstyleExcluded(file));
    writeFileSync(path.join(listDir, `${group}.json`), JSON.stringify(list));
    console.log(`${group}: ${list.length} file(s)`);
  }
}

function checkYaml(repoDir, files) {
  for (const chunk of chunks(files)) {
    const result = runTool(process.env.YAMLLINT, ["-c", centralFile(".yamllint.yml"), "-f", "parsable", ...chunk.map(asArgument)], repoDir);
    let findings = 0;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^(.+):(\d+):(\d+): \[(error|warning)\] (.*)$/.exec(line);
      if (match) {
        findings++;
        report(match[4], fromArgument(match[1]), match[2], match[3], `yamllint: ${match[5]}`);
      }
    }
    if (result.status !== 0 && (result.status !== 1 || findings === 0)) {
      toolFailure("yamllint", result);
    }
  }
}

function checkWorkflows(repoDir, files) {
  for (const chunk of chunks(files)) {
    const args = ["-config-file", centralFile("actionlint.yaml"), "-no-color", "-format", "{{json .}}", "--", ...chunk];
    const result = runTool(process.env.ACTIONLINT, args, repoDir);
    if (result.status !== 0 && result.status !== 1) {
      toolFailure("actionlint", result);
      continue;
    }
    for (const finding of JSON.parse(result.stdout || "[]")) {
      report("error", fromArgument(finding.filepath), finding.line, finding.column, `actionlint [${finding.kind}]: ${finding.message}`);
    }
  }
}

async function checkMarkdown(repoDir, files) {
  const config = parseJsonc(readFileSync(centralFile(".markdownlint.jsonc"), "utf8"));
  delete config.extends;
  for (const chunk of chunks(files)) {
    const results = await lintMarkdown({ files: chunk.map((file) => path.join(repoDir, file)), config });
    for (const [file, findings] of Object.entries(results)) {
      for (const finding of findings) {
        const detail = finding.errorDetail ? ` [${finding.errorDetail}]` : "";
        const message = `markdownlint ${finding.ruleNames.join("/")}: ${finding.ruleDescription}${detail}`;
        report("error", path.relative(repoDir, file).split(path.sep).join("/"), finding.lineNumber, finding.errorRange?.[0], message);
      }
    }
  }
}

function checkJson(repoDir, files) {
  for (const file of files) {
    const text = readFileSync(path.join(repoDir, file), "utf8").replace(/^\uFEFF/, "");
    try {
      JSON.parse(text);
    } catch (error) {
      const line = /line (\d+)/.exec(error.message)?.[1];
      report("error", file, line, undefined, `json: ${error.message}`);
    }
  }
}

async function checkJs(repoDir, files) {
  const eslint = new ESLint({ cwd: repoDir, overrideConfigFile: centralFile("eslint.config.mjs"), warnIgnored: true });
  for (const chunk of chunks(files)) {
    for (const result of await eslint.lintFiles(chunk)) {
      const file = path.relative(repoDir, result.filePath).split(path.sep).join("/");
      for (const finding of result.messages) {
        const level = finding.severity === 2 ? "error" : "warning";
        report(level, file, finding.line, finding.column, `eslint ${finding.ruleId ?? ""}: ${finding.message}`);
      }
    }
  }
}

function checkXml(repoDir, files) {
  for (const file of files) {
    const result = XMLValidator.validate(readFileSync(path.join(repoDir, file), "utf8"));
    if (result !== true) {
      report("error", file, result.err.line, result.err.col, `xml ${result.err.code}: ${result.err.msg}`);
    }
  }
}

function checkEditorconfig(repoDir, files) {
  const target = path.join(repoDir, ".editorconfig");
  rmSync(target, { force: true });
  copyFileSync(centralFile(".editorconfig"), target);
  for (const chunk of chunks(files)) {
    const args = ["-config", centralFile("editorconfig-checker.json"), "-no-color", "-format", "codeclimate", ...chunk.map(asArgument)];
    const result = runTool(process.env.EDITORCONFIG_CHECKER, args, repoDir);
    if (result.status !== 0 && result.status !== 1) {
      toolFailure("editorconfig-checker", result);
      continue;
    }
    const output = result.stdout.trim();
    for (const finding of output ? JSON.parse(output) : []) {
      report("error", fromArgument(finding.location.path), finding.location.lines?.begin, undefined, `editorconfig: ${finding.description}`);
    }
  }
}

function checkGdscript(repoDir, files) {
  for (const chunk of chunks(files)) {
    const args = ["check", "--no-color", "--format", "json", "-c", centralFile("gdstyle.toml"), ...chunk.map(asArgument)];
    const result = runTool(process.env.GDSTYLE, args, repoDir);
    const output = result.stdout.trim();
    if ((result.status !== 0 && result.status !== 1) || !output.startsWith("[")) {
      toolFailure("gdstyle check", result);
      continue;
    }
    for (const finding of JSON.parse(output)) {
      const file = fromArgument(path.relative(repoDir, path.resolve(repoDir, finding.file)).split(path.sep).join("/"));
      report("error", file, finding.span?.line, finding.span?.column, `gdstyle ${finding.rule}: ${finding.message}`);
    }
  }
}

function checkGdformat(repoDir, files) {
  for (const chunk of chunks(files)) {
    const args = ["fmt", "--check", "--no-color", "-c", centralFile("gdstyle.toml"), ...chunk.map(asArgument)];
    const result = runTool(process.env.GDSTYLE, args, repoDir);
    if (result.status !== 0 && result.status !== 1) {
      toolFailure("gdstyle fmt", result);
      continue;
    }
    let findings = 0;
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^Would reformat: (.+)$/.exec(line);
      if (match) {
        findings++;
        report("error", fromArgument(match[1]), 1, undefined, "gdstyle fmt: file is not formatted, run `gdstyle fmt` on it");
      }
    }
    if (result.status === 1 && findings === 0) {
      toolFailure("gdstyle fmt", result);
    }
  }
}

const MAX_SUMMARY_FILES = 50;

const isPrintable = (char) => char.charCodeAt(0) >= 0x20 && char !== "`";
const asCode = (value) => `\`${[...String(value)].filter(isPrintable).join("").replace(/\|/g, "\\|").slice(0, 200)}\``;

function readResult(listDir, command) {
  try {
    return JSON.parse(readFileSync(path.join(listDir, `${command}.result.json`), "utf8"));
  } catch {
    return undefined;
  }
}

function writeSummary(listDir) {
  const lines = ["## Formatting checks", "", "| Check | Files | Errors | Warnings | Result |", "| --- | ---: | ---: | ---: | :---: |"];
  const totals = new Map();
  for (const [command, title] of Object.entries(CHECK_TITLES)) {
    const result = readResult(listDir, command);
    if (!result) {
      lines.push(`| ${title} | | | | not run |`);
      continue;
    }
    const status = result.errors > 0 ? "❌" : result.warnings > 0 ? "⚠️" : result.files > 0 ? "✅" : "no files";
    lines.push(`| ${title} | ${result.files} | ${result.errors} | ${result.warnings} | ${status} |`);
    for (const [file, count] of Object.entries(result.findings)) {
      totals.set(file, (totals.get(file) ?? 0) + count);
    }
  }
  if (totals.size > 0) {
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    lines.push("", `<details><summary>Findings in ${totals.size} file(s)</summary>`, "", "| File | Findings |", "| --- | ---: |");
    for (const [file, count] of sorted.slice(0, MAX_SUMMARY_FILES)) {
      lines.push(`| ${asCode(file)} | ${count} |`);
    }
    if (sorted.length > MAX_SUMMARY_FILES) {
      lines.push("", `${sorted.length - MAX_SUMMARY_FILES} more file(s), see the job log.`);
    }
    lines.push("", "</details>");
  }
  lines.push("", "GitHub shows only the first annotations of each step, the job log lists all findings.", "");
  const summary = lines.join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" });
  } else {
    process.stdout.write(summary);
  }
}

const CHECKS = {
  yaml: checkYaml,
  workflows: checkWorkflows,
  markdown: checkMarkdown,
  json: checkJson,
  js: checkJs,
  xml: checkXml,
  editorconfig: checkEditorconfig,
  gdscript: checkGdscript,
  gdformat: checkGdformat,
};

const [command, repoArgument, listArgument] = process.argv.slice(2);
const repoDir = path.resolve(repoArgument);
const listDir = path.resolve(listArgument);

if (command === "collect") {
  collect(repoDir, listDir);
} else if (command === "summary") {
  writeSummary(listDir);
} else if (CHECKS[command]) {
  const files = JSON.parse(readFileSync(path.join(listDir, `${command}.json`), "utf8"));
  if (files.length === 0) {
    console.log(`No ${command} files to check.`);
  } else {
    await CHECKS[command](repoDir, files);
    console.log(`${command}: ${files.length} file(s) checked, ${errorCount} error(s).`);
  }
  const result = { files: files.length, errors: errorCount, warnings: warningCount, findings: Object.fromEntries(findingsByFile) };
  writeFileSync(path.join(listDir, `${command}.result.json`), JSON.stringify(result));
} else {
  throw new Error(`Unknown command: ${command}`);
}

process.exitCode = errorCount > 0 ? 1 : 0;
