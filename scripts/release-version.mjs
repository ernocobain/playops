/**
 * Phase 6.6 release-identity checks (Node built-ins only, no framework).
 *
 * A prepared release has ONE version. This module is the single place that
 * decides whether the repository agrees with itself:
 *
 *   package.json version == package-lock.json version == newest CHANGELOG release
 *
 * It also checks that the changelog is release-ready: an `## [Unreleased]`
 * section exists, every release date is a real `YYYY-MM-DD` date, release
 * headings are unique, and no machine-specific path or credential material is
 * embedded in shipped text. Add `0.1.0` in one place — `package.json` — and let
 * these checks carry the rest.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Exact `MAJOR.MINOR.PATCH` with no leading zeros, prefix or suffix. */
export const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

export const RELEASE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const UNRELEASED_HEADING = "## [Unreleased]";

const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\S+)$/u;

/** Text that must never appear in a release-consumer document. */
export const UNSAFE_RELEASE_TEXT = Object.freeze([
  { pattern: /\/home\//u, description: "an absolute home path" },
  { pattern: /\/Users\//u, description: "an absolute macOS home path" },
  { pattern: /\.hermes\//u, description: "a Hermes state path" },
  { pattern: /\.omh\//u, description: "an OMH state path" },
  { pattern: /\/scratch\//u, description: "a scratch path" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, description: "a private key" },
  {
    pattern: /"(?:private_key|client_email|client_secret|refresh_token)"\s*:/u,
    description: "service-account credential JSON",
  },
  { pattern: /\bya29\.[A-Za-z0-9_-]+/u, description: "an OAuth access token" },
]);

/** Parse the `[Unreleased]` marker and every release heading, in file order. */
export function parseChangelog(text) {
  const lines = text.split(/\r?\n/u);
  const releases = [];
  for (const line of lines) {
    const match = RELEASE_HEADING.exec(line.trim());
    if (match) releases.push({ version: match[1], date: match[2] });
  }
  return { unreleased: lines.includes(UNRELEASED_HEADING), releases };
}

/** Read the three files that must agree on the prepared version. */
export function readReleaseState(root) {
  const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
  const changelogText = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  return {
    packageVersion: metadata.version,
    lockVersion: lock.version,
    lockRootVersion: lock.packages?.[""]?.version ?? null,
    changelog: parseChangelog(changelogText),
    changelogText,
  };
}

/** True only for a real calendar date in `YYYY-MM-DD` form. */
export function isReleaseDate(value) {
  if (typeof value !== "string" || !RELEASE_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Version identity: package.json, package-lock.json and the newest release entry. */
export function collectVersionProblems(state) {
  const problems = [];
  const { packageVersion, lockVersion, lockRootVersion, changelog } = state;
  if (typeof packageVersion !== "string" || !SEMVER_PATTERN.test(packageVersion)) {
    problems.push(
      `package.json version is not MAJOR.MINOR.PATCH: ${JSON.stringify(packageVersion)}`,
    );
  }
  if (lockVersion !== packageVersion) {
    problems.push(
      `package-lock.json version ${JSON.stringify(lockVersion)} != package.json ${JSON.stringify(packageVersion)}`,
    );
  }
  if (lockRootVersion !== packageVersion) {
    problems.push(
      `package-lock.json packages[""].version ${JSON.stringify(lockRootVersion)} != package.json ${JSON.stringify(packageVersion)}`,
    );
  }
  if (!changelog.unreleased) {
    problems.push(`CHANGELOG.md is missing the ${JSON.stringify(UNRELEASED_HEADING)} section`);
  }
  const [newest] = changelog.releases;
  if (newest === undefined) {
    problems.push("CHANGELOG.md has no released version heading");
  } else if (newest.version !== packageVersion) {
    problems.push(
      `newest CHANGELOG release ${JSON.stringify(newest.version)} != package.json ${JSON.stringify(packageVersion)}`,
    );
  }
  return problems;
}

/** Changelog hygiene: safety, Unreleased marker, real unique release dates. */
export function collectChangelogProblems(text) {
  const problems = [];
  const parsed = parseChangelog(text);
  if (!parsed.unreleased) {
    problems.push(`CHANGELOG.md is missing the ${JSON.stringify(UNRELEASED_HEADING)} section`);
  }
  for (const { pattern, description } of UNSAFE_RELEASE_TEXT) {
    if (pattern.test(text)) problems.push(`CHANGELOG.md contains ${description}`);
  }
  const seen = new Set();
  for (const release of parsed.releases) {
    if (seen.has(release.version)) problems.push(`CHANGELOG.md repeats release ${release.version}`);
    seen.add(release.version);
    if (!isReleaseDate(release.date)) {
      problems.push(
        `CHANGELOG.md release ${release.version} has an invalid date: ${JSON.stringify(release.date)}`,
      );
    }
  }
  return problems;
}

/** Every version + changelog problem at once, so one run reports everything. */
export function collectReleaseProblems(state) {
  return [...collectVersionProblems(state), ...collectChangelogProblems(state.changelogText)];
}

/** Throw unless package.json, package-lock.json and CHANGELOG.md all agree and the changelog is release-ready. */
export function assertReleaseVersionConsistency(state) {
  const problems = collectReleaseProblems(state);
  if (problems.length > 0) {
    throw new Error(`release version inconsistency:\n- ${problems.join("\n- ")}`);
  }
  return state;
}

/** Throw unless the changelog is safe to ship and release-ready. */
export function assertChangelogHygiene(text) {
  const problems = collectChangelogProblems(text);
  if (problems.length > 0) {
    throw new Error(`changelog is not release-ready:\n- ${problems.join("\n- ")}`);
  }
  return parseChangelog(text);
}

/** Non-throwing report used by tests, evidence scripts and maintainers. */
export function collectReleaseReport(root) {
  let state;
  try {
    state = readReleaseState(root);
  } catch (error) {
    return {
      ok: false,
      version: null,
      latestRelease: null,
      problems: [
        `release files could not be read: ${String(error instanceof Error ? error.message : error)}`,
      ],
    };
  }
  const problems = collectReleaseProblems(state);
  return {
    ok: problems.length === 0,
    version: state.packageVersion,
    latestRelease: state.changelog.releases[0] ?? null,
    problems,
  };
}

/** The installed README must name the prepared tarball and link the release docs. */
export function assertReleaseDocumentation(root) {
  const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const problems = [];
  const expected = `playops-${metadata.version}.tgz`;
  if (!readme.includes(expected)) {
    problems.push(`README.md does not name the prepared artifact ${JSON.stringify(expected)}`);
  }
  for (const link of ["(CHANGELOG.md)", "(docs/release-process.md)"]) {
    if (!readme.includes(link)) problems.push(`README.md does not link ${link.slice(1, -1)}`);
  }
  if (problems.length > 0) {
    throw new Error(`release documentation is incomplete:\n- ${problems.join("\n- ")}`);
  }
  return { artifact: expected };
}
