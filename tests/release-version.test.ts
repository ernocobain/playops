import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, root), "utf8");

describe("Phase 6.6 release identity and changelog", () => {
  it("runs the native release-identity checks without a framework", () => {
    const output = execFileSync(
      process.execPath,
      ["--test", fileURLToPath(new URL("scripts/release-version.test.mjs", root))],
      { encoding: "utf8" },
    );
    expect(output).toContain("fail 0");
  });

  it("agrees on one prepared version across manifest, lockfile and changelog", () => {
    const metadata = JSON.parse(read("package.json")) as { version: string; private: boolean };
    const lock = JSON.parse(read("package-lock.json")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(metadata.private).toBe(true);
    expect(lock.version).toBe(metadata.version);
    expect(lock.packages[""]?.version).toBe(metadata.version);

    const changelog = read("CHANGELOG.md");
    expect(changelog).toContain("## [Unreleased]");
    const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\S+)$/gmu)];
    expect(releases.length).toBeGreaterThan(0);
    expect(releases[0]?.[1]).toBe(metadata.version);
    expect(releases[0]?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it("keeps the shipped changelog free of host paths and credential material", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).not.toMatch(/\/home\/|\/Users\/|\.hermes\/|\.omh\/|\/scratch\//u);
    expect(changelog).not.toMatch(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:private_key|client_email|client_secret)"\s*:|\bya29\./u,
    );
  });

  it("names the prepared artifact and the release documents from the README", () => {
    const metadata = JSON.parse(read("package.json")) as { version: string };
    const readme = read("README.md");
    expect(readme).toContain(`playops-${metadata.version}.tgz`);
    expect(readme).toContain("(CHANGELOG.md)");
    expect(readme).toContain("(docs/release-process.md)");
  });

  it("documents the annotated-tag contract, tag safety and the release order", () => {
    const process_ = read("docs/release-process.md");
    // The procedure must stay version-generic: it derives the tag from the
    // prepared manifest instead of pinning one obsolete release line.
    expect(process_).toContain('git tag -a "v${VERSION}" -m "PlayOps v${VERSION}"');
    expect(process_).toContain("git status --short");
    expect(process_).toContain("git rev-parse HEAD");
    expect(process_).toContain('git tag --list "v${VERSION}"');
    expect(process_).toContain("CURRENT_VERSION");
    expect(process_).toContain("NEXT_VERSION");
    expect(process_).not.toMatch(/prepared package version[^\n]*0\.1\.0/u);
    expect(process_).toMatch(/Never use `git tag -f`/u);
    expect(process_).toContain("prepare version + changelog");
    expect(process_).toMatch(/annotated/iu);
    // The process must not promise automation or publication.
    expect(process_).toMatch(/no release automation/iu);
    expect(process_).toMatch(/out of scope/iu);
  });
});
