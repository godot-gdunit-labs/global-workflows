const PRERELEASE_ORDER = ["dev", "alpha", "beta", "rc"];

export function normalizeVersion(version) {
  const parts = String(version).trim().split(".");
  while (parts.length > 2 && parts.at(-1) === "0") {
    parts.pop();
  }
  return parts.join(".");
}

export function parseTag(tag) {
  const match = /^(\d+(?:\.\d+)+)-([a-z]+\d*)$/i.exec(tag);
  return match ? { version: normalizeVersion(match[1]), status: match[2].toLowerCase() } : null;
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function compareStatus(left, right) {
  const rank = (status) => {
    const match = /^([a-z]+)(\d*)$/.exec(status);
    const order = status === "stable" ? PRERELEASE_ORDER.length : PRERELEASE_ORDER.indexOf(match?.[1]);
    return [order, Number(match?.[2] || 0)];
  };
  const [orderA, numberA] = rank(left);
  const [orderB, numberB] = rank(right);
  return orderA - orderB || numberA - numberB;
}

export function compareReleases(left, right) {
  return compareVersions(left.version, right.version) || compareStatus(left.status, right.status);
}

export function releaseName(release) {
  return `${release.version}-${release.status}`;
}

function line(version) {
  return version.split(".").slice(0, 2).join(".");
}

export function selectCandidates(releases) {
  const parsed = releases
    .filter((release) => !release.draft)
    .map((release) => ({ ...parseTag(release.tag_name), prerelease: release.prerelease, published: release.published_at }))
    .filter((release) => release.version && (release.status === "stable" || compareStatus(release.status, "dev") >= 0));
  const stable = parsed.filter((release) => !release.prerelease && release.status === "stable");
  const highestPerLine = new Map();
  for (const release of stable) {
    const current = highestPerLine.get(line(release.version));
    if (!current || compareVersions(release.version, current.version) > 0) {
      highestPerLine.set(line(release.version), release);
    }
  }
  const highestStable = stable.sort((a, b) => compareVersions(b.version, a.version))[0];
  const prerelease = parsed
    .filter((release) => release.prerelease && (!highestStable || compareVersions(release.version, highestStable.version) > 0))
    .sort((a, b) => compareReleases(b, a))[0];
  const candidates = [...highestPerLine.values()].sort((a, b) => compareVersions(a.version, b.version));
  return prerelease ? [...candidates, prerelease] : candidates;
}

export function normalizeTested(versions) {
  const valid = versions
    .map((entry) => ({ version: String(entry.version ?? "").trim(), status: String(entry.status ?? "").trim().toLowerCase() }))
    .filter((entry) => /^\d+(\.\d+)+$/.test(entry.version) && /^[a-z]+\d*$/.test(entry.status))
    .map((entry) => ({ version: normalizeVersion(entry.version), status: entry.status }));
  const unique = new Map(valid.map((entry) => [releaseName(entry), entry]));
  return [...unique.values()].sort(compareReleases);
}

export function versionLine(version) {
  return line(version);
}

export function planUpdates(candidates, tested) {
  if (tested.length === 0) {
    return [];
  }
  const lowest = tested.reduce((low, entry) => (compareVersions(entry.version, low) < 0 ? entry.version : low), tested[0].version);
  // A repository that tests no prerelease has no place for one, so prereleases are only planned
  // for repositories that already test one.
  const testsPrerelease = tested.some((entry) => entry.status !== "stable");
  const updates = [];
  for (const candidate of candidates) {
    if (compareVersions(candidate.version, lowest) < 0) {
      continue;
    }
    const isStable = candidate.status === "stable";
    if (!isStable && !testsPrerelease) {
      continue;
    }
    const sameLine = tested.filter((entry) => line(entry.version) === line(candidate.version));
    if (!isStable && sameLine.some((entry) => entry.status === "stable" && compareVersions(entry.version, candidate.version) >= 0)) {
      continue;
    }
    const replaced = isStable ? sameLine : sameLine.filter((entry) => entry.status !== "stable");
    if (replaced.some((entry) => compareReleases(entry, candidate) > 0)) {
      continue;
    }
    if (replaced.length === 1 && compareReleases(replaced[0], candidate) === 0) {
      continue;
    }
    updates.push({ release: candidate, replaced: replaced.filter((entry) => compareReleases(entry, candidate) !== 0), newLine: sameLine.length === 0 });
  }
  return updates;
}

const PLAN_MARKER = /<!-- godot-release-plan: ([^>]*) -->/;

export function planMarker(updates) {
  return `<!-- godot-release-plan: ${updates.map((update) => releaseName(update.release)).join(",")} -->`;
}

export function parsePlan(body) {
  const match = PLAN_MARKER.exec(body ?? "");
  return match ? match[1].split(",").filter(Boolean) : [];
}

export function withoutHandled(updates, closedBodies) {
  const handled = new Set(closedBodies.flatMap(parsePlan));
  return updates.filter((update) => !handled.has(releaseName(update.release)));
}

export function expectedTested(tested, updates) {
  const removed = new Set(updates.flatMap((update) => update.replaced.map(releaseName)));
  const kept = tested.filter((entry) => !removed.has(releaseName(entry)));
  return normalizeTested([...kept, ...updates.map((update) => update.release)]);
}

const PULL_MARKER = /<!-- godot-release-pull: ([^ >]*) ([0-9a-f]*) -->/;

export function pullMarker(plan, sha) {
  return `<!-- godot-release-pull: ${plan} ${sha} -->`;
}

export function parsePullMarker(body) {
  const match = PULL_MARKER.exec(body ?? "");
  return match ? { plan: match[1], sha: match[2] } : null;
}
