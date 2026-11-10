import { parse } from "yaml";

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function list(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((entry) => entry.trim()).filter(Boolean);
  }
  return typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

export function parseTemplate(path, text) {
  if (/\.ya?ml$/i.test(path)) {
    const form = parse(text) ?? {};
    return {
      path,
      kind: "form",
      name: String(form.name ?? ""),
      title: String(form.title ?? ""),
      type: String(form.type ?? ""),
      labels: list(form.labels),
      assignees: list(form.assignees),
      projects: list(form.projects),
      fields: Array.isArray(form.body) ? form.body : [],
    };
  }
  const match = FRONT_MATTER.exec(text);
  const meta = (match && parse(match[1])) || {};
  return {
    path,
    kind: "markdown",
    name: String(meta.name ?? ""),
    title: String(meta.title ?? ""),
    type: String(meta.type ?? ""),
    labels: list(meta.labels),
    assignees: list(meta.assignees),
    projects: list(meta.projects),
    text: (match ? text.slice(match[0].length) : text).replace(/\r\n/g, "\n").trim(),
  };
}

export function selectTaskTemplate(templates) {
  const isTask = (template) => template.type.toLowerCase() === "task" || template.name.trim().toLowerCase() === "task";
  return templates.find((template) => template.kind === "form" && isTask(template)) ?? templates.find(isTask) ?? null;
}

export function templatePrefix(template, fallback) {
  return /^([A-Z][A-Z0-9]*)-/.exec(template?.title ?? "")?.[1] ?? fallback;
}

export function templateLabels(template, repositoryLabels, fallback) {
  const labels = template && template.labels.length > 0 ? template.labels : [fallback];
  const ciLabel = repositoryLabels.find((label) => label.toLowerCase() === "ci");
  return [...new Set(labels.flatMap((label) => (label === "API" ? (ciLabel ? [ciLabel] : []) : [label])))].filter((label) =>
    repositoryLabels.includes(label),
  );
}

function sectionKind(text) {
  if (/acceptance|criteria|definition of done/i.test(text)) {
    return "criteria";
  }
  if (/descri|task|what|summary|detail/i.test(text)) {
    return "description";
  }
  return null;
}

function chooseOption(field) {
  const options = list(field.attributes?.options);
  return (
    options.find((option) => /\bCI\b/.test(option)) ??
    options.find((option) => /maint/i.test(option)) ??
    options[Number(field.attributes?.default ?? 0)] ??
    options[0]
  );
}

function renderForm(template, content) {
  const sections = [];
  for (const field of template.fields) {
    if (field.type === "markdown") {
      continue;
    }
    const label = String(field.attributes?.label ?? field.id ?? "");
    const required = field.validations?.required === true;
    let value;
    if (field.type === "dropdown") {
      value = chooseOption(field);
    } else if (field.type === "checkboxes") {
      value = (field.attributes?.options ?? []).map((option) => `- [${option.required ? "X" : " "}] ${option.label}`).join("\n");
    } else {
      const kind = sectionKind(`${field.id ?? ""} ${label}`);
      value = kind ? content[kind] : undefined;
    }
    if (!value) {
      if (required) {
        throw new Error(`the required field \`${field.id ?? label}\` of the template ${template.path} can't be filled`);
      }
      value = "_No response_";
    }
    sections.push(`### ${label}\n\n${value}`);
  }
  return sections.join("\n\n");
}

function renderMarkdown(template, content) {
  const lines = [];
  let heading = "";
  for (const line of template.text.split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) {
      heading = match[1];
      lines.push(line);
    } else if (/^\s*<!--[\s\S]*-->\s*$/.test(line)) {
      const kind = sectionKind(heading);
      if (kind) {
        lines.push(content[kind]);
      }
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function renderIssueBody(template, content) {
  if (template?.kind === "form") {
    return renderForm(template, content);
  }
  if (template?.kind === "markdown") {
    return renderMarkdown(template, content);
  }
  return ["### Description", "", content.description, "", "### Acceptance criteria", "", content.criteria].join("\n");
}
