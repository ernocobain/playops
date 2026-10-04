import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertChangelogHygiene,
  assertReleaseDocumentation,
  assertReleaseVersionConsistency,
  collectReleaseReport,
  isReleaseDate,
  parseChangelog,
  readReleaseState,
} from "./release-version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const state = (overrides = {}) => {
  const base = {
    packageVersion: "1.2.3",
    lockVersion: "1.2.3",
    lockRootVersion: "1.2.3",
    unreleased: true,
    releases: [{ version: "1.2.3", date: "2026-01-02" }],
    ...overrides,
  };
  const changelogText = [
    "# Changelog",
    "",
    ...(base.unreleased ? ["## [Unreleased]", ""] : []),
    ...base.releases.flatMap((release) => [`## [${release.version}] - ${release.date}`, ""]),
  ].join("\n");
  return {
    packageVersion: base.packageVersion,
    lockVersion: base.lockVersion,
    lockRootVersion: base.lockRootVersion,
    changelog: { unreleased: base.unreleased, releases: base.releases },
    changelogText,
  };
};

test("the prepared repository release is internally consistent and release-ready", () => {
  const report = collectReleaseReport(root);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ok, true);
  assert.match(report.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(report.latestRelease.version, report.version);
  assertReleaseVersionConsistency(readReleaseState(root));
  assertReleaseDocumentation(root);
});

test("the newest changelog release is the prepared package version", () => {
  const current = readReleaseState(root);
  assert.equal(current.changelog.unreleased, true);
  assert.equal(current.changelog.releases[0]?.version, current.packageVersion);
  assert.ok(isReleaseDate(current.changelog.releases[0]?.date));
  assertChangelogHygiene(current.changelogText);
  assert.equal(
    parseChangelog(current.changelogText).releases.length,
    current.changelog.releases.length,
  );
});

test("accepts a consistent synthetic release state", () => {
  assert.doesNotThrow(() => assertReleaseVersionConsistency(state()));
});

for (const [name, fixture, expectation] of [
  [
    "a lockfile version that disagrees with package.json",
    state({ lockVersion: "1.2.4" }),
    /package-lock\.json version/u,
  ],
  [
    "a lockfile root package that disagrees",
    state({ lockRootVersion: null }),
    /packages\[""\]\.version/u,
  ],
  ["a non-semver package version", state({ packageVersion: "1.2" }), /not MAJOR\.MINOR\.PATCH/u],
  ["a changelog without an Unreleased section", state({ unreleased: false }), /Unreleased/u],
  [
    "a changelog whose newest release is a different version",
    state({ releases: [{ version: "1.2.2", date: "2026-01-02" }] }),
    /newest CHANGELOG release/u,
  ],
  [
    "an impossible release date",
    state({ releases: [{ version: "1.2.3", date: "2026-02-31" }] }),
    /invalid date/u,
  ],
  [
    "a repeated release heading",
    state({
      releases: [
        { version: "1.2.3", date: "2026-01-02" },
        { version: "1.2.3", date: "2026-01-01" },
      ],
    }),
    /repeats release/u,
  ],
  ["a missing released heading", state({ releases: [] }), /no released version heading/u],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => assertReleaseVersionConsistency(fixture), expectation);
  });
}

for (const [name, text] of [
  ["a home path", "# Changelog\n\n## [Unreleased]\n\nSee /home/operator/notes.md\n"],
  ["a Hermes state path", "# Changelog\n\n## [Unreleased]\n\nStored under .hermes/cache/scratch\n"],
  ["a scratch path", "# Changelog\n\n## [Unreleased]\n\n/tmp/scratch/report.txt\n"],
  ["a private key", "# Changelog\n\n## [Unreleased]\n\n-----BEGIN PRIVATE KEY-----\n"],
  ["credential JSON", '# Changelog\n\n## [Unreleased]\n\n"client_secret": "x"\n'],
  ["an OAuth token", "# Changelog\n\n## [Unreleased]\n\nya29.abcdef\n"],
  ["a missing Unreleased section", "# Changelog\n\n## [0.1.0] - 2026-01-02\n"],
]) {
  test(`changelog hygiene rejects ${name}`, () => {
    assert.throws(() => assertChangelogHygiene(text));
  });
}

test("release documentation must name the prepared artifact and link the release docs", () => {
  const fixture = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-release-doc-"));
  try {
    cpSync(join(root, "package.json"), join(fixture, "package.json"));
    cpSync(join(root, "README.md"), join(fixture, "README.md"));
    assert.doesNotThrow(() => assertReleaseDocumentation(fixture));
    const readmePath = join(fixture, "README.md");
    const drifted = readFileSync(readmePath, "utf8").replace(
      /playops-\d+\.\d+\.\d+\.tgz/gu,
      "playops-9.9.9.tgz",
    );
    writeFileSync(readmePath, drifted);
    assert.throws(
      () => assertReleaseDocumentation(fixture),
      /does not name the prepared artifact/u,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a missing CHANGELOG is reported, not thrown, by the report helper", () => {
  const fixture = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-release-report-"));
  try {
    mkdirSync(join(fixture, "nested"), { recursive: true });
    writeFileSync(join(fixture, "package.json"), '{"version":"1.0.0"}');
    const report = collectReleaseReport(fixture);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.includes("could not be read")));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
