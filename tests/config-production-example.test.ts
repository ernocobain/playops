/**
 * Stage 4C.4 — production configuration example completeness and tmpfiles /
 * configuration provisioning consistency.
 *
 * Offline and read-only: temporary fixtures only. This suite NEVER creates
 * /etc/playops (or any other host path); it remaps the declared production
 * layout under a temporary directory and exercises the existing trust/policy
 * seams. The production DEFAULT policy is not weakened.
 */
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfigYaml } from "../src/config/index.js";
import type { PlayOpsConfig } from "../src/config/index.js";
import { validateProductionDaemonConfig } from "../src/daemon/production-composition.js";
import type { FsTrustPolicy } from "../src/shared/fs-trust.js";

const root = new URL("../", import.meta.url);
const EXAMPLE_PATH = fileURLToPath(new URL("config/playops.production.example.yaml", root));
const TMPFILES_PATH = fileURLToPath(new URL("deploy/tmpfiles.d/playops.conf", root));
const SERVICE_PATH = fileURLToPath(new URL("deploy/systemd/playops.service", root));
/** A validator-acceptable stand-in for the example's `<package-name>` placeholder. */
const VALID_PACKAGE = "com.example.playops";

const PROBE = mkdtempSync(join(tmpdir(), "playops-4c4-probe-"));
const TEST_GID = lstatSync(PROBE).gid;
rmSync(PROBE, { recursive: true, force: true });
/** Module-argument seam only; never sourced from env/CLI/config. */
const TEST_POLICY: FsTrustPolicy = {
  trustedOwnerUid: process.getuid?.() ?? 0,
  processGroupIdentity: { effectiveGid: TEST_GID + 1, supplementaryGids: [TEST_GID] },
};

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-4c4-example-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const exampleText = (): string => readFileSync(EXAMPLE_PATH, "utf8");

/** Load the production example (placeholder package name substituted) as a full config. */
function loadExample(rootDir: string): { config: PlayOpsConfig; file: string } {
  const file = join(rootDir, "playops.yaml");
  writeFileSync(file, exampleText().replace('"<package-name>"', `"${VALID_PACKAGE}"`), {
    mode: 0o640,
  });
  chmodSync(file, 0o640);
  return { config: loadConfig({ configPath: file, env: {} }), file };
}

/** Absolute path scalars the example declares (double-quoted YAML values beginning with /). */
function declaredPaths(text: string): string[] {
  return [...text.matchAll(/"(\/[^"\n]*)"/gu)].map((match) => match[1] ?? "");
}

/** Paths deployed by `deploy/tmpfiles.d/playops.conf` (the `d` directives). */
function tmpfilesDirectories(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/u)[1] ?? "")
    .filter(Boolean);
}

/** Directory roots systemd provisions from the unit's directory directives. */
function systemdRoots(text: string): string[] {
  const prefixes: Record<string, string> = {
    RuntimeDirectory: "/run",
    StateDirectory: "/var/lib",
    LogsDirectory: "/var/log",
  };
  const dirs: string[] = [];
  for (const raw of text.split("\n")) {
    const match = /^(RuntimeDirectory|StateDirectory|LogsDirectory)=(\S+)$/u.exec(raw.trim());
    if (match) {
      dirs.push(`${prefixes[match[1] as string]}/${match[2] as string}`);
    }
  }
  return dirs;
}

describe("Stage 4C.4 production configuration example", () => {
  it("parses as a full config with every daemon and release path present", () => {
    const { config } = loadExample(tempRoot());
    expect(config.googlePlay.packageName).toBe(VALID_PACKAGE);
    expect(config.googlePlay.serviceAccountJson).toBe("/etc/playops/credentials/google-play.json");
    expect(config.audit.logPath).toBe("/var/log/playops/playops.audit.jsonl");
    expect(config.release.editSessionPath).toBe("/var/lib/playops/release/edit-session.json");
    expect(config.release.editCleanupJournalPath).toBe(
      "/var/lib/playops/release/edit-cleanup-journal.json",
    );
    expect(config.release.commitAttemptJournalPath).toBe(
      "/var/lib/playops/release/commit-attempt-journal.json",
    );
    expect(config.daemon).toEqual({
      socketPath: "/run/playops/playops.sock",
      pendingStorePath: "/var/lib/playops/pending",
      claimRoot: "/var/lib/playops/claims",
      writeIntentStorePath: "/var/lib/playops/write-intents",
    });
    // The example omits `llm` and `review` entirely (least-secret production config).
    const parsed = parseConfigYaml(exampleText());
    expect(parsed.llm).toBeUndefined();
    expect(parsed.review).toBeUndefined();
    expect(config.llm).toEqual(DEFAULT_CONFIG.llm);
    expect(config.review).toEqual(DEFAULT_CONFIG.review);
  });

  it("declares only absolute, non-empty security-sensitive paths", () => {
    const paths = declaredPaths(exampleText());
    // 1 credential + 1 audit + 3 release + 4 daemon paths.
    expect(paths.length).toBeGreaterThanOrEqual(9);
    for (const path of paths) {
      expect(path.trim()).toBe(path);
      expect(isAbsolute(path)).toBe(true);
    }
  });

  it("carries no secret material, host identity or development path", () => {
    const text = exampleText();
    expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/u);
    expect(text).not.toMatch(/"(?:private_key|client_email|client_secret|refresh_token)"\s*:/u);
    expect(text).not.toMatch(/\bya29\.[A-Za-z0-9_-]+/u);
    expect(text).not.toMatch(/api_key\s*:/u);
    expect(text).not.toMatch(/\/home\//u);
    expect(text).not.toMatch(/\/Users\//u);
    expect(text).not.toMatch(/\bnvm\b/iu);
    expect(text).not.toMatch(/dhikrama|surface|bizdirect|calm-drive/iu);
    // The developer credential filename must not appear in the production template.
    expect(text).not.toMatch(/service-account\.json/u);
  });

  it("passes the structural production validation with temporary fixtures and never touches /etc/playops", () => {
    const { config, file } = loadExample(tempRoot());
    const validated = validateProductionDaemonConfig(config, file, TEST_POLICY);
    expect(validated.packageName).toBe(VALID_PACKAGE);
    expect(validated.configPath).toBe(file);
    expect(validated.credentialPath).toBe(config.googlePlay.serviceAccountJson);
    expect(validated.auditLogPath).toBe(config.audit.logPath);
    expect(validated.editSessionPath).toBe(config.release.editSessionPath);
    expect(validated.editCleanupJournalPath).toBe(config.release.editCleanupJournalPath);
    expect(validated.commitAttemptJournalPath).toBe(config.release.commitAttemptJournalPath);
    expect(validated.socketPath).toBe(config.daemon.socketPath);
    expect(validated.pendingStorePath).toBe(config.daemon.pendingStorePath);
    expect(validated.claimRoot).toBe(config.daemon.claimRoot);
    expect(validated.writeIntentStorePath).toBe(config.daemon.writeIntentStorePath);
  });
});

describe("Stage 4C.4 tmpfiles / configuration consistency", () => {
  it("provisions every parent directory the production example requires, and nothing more", () => {
    const { config } = loadExample(tempRoot());
    const requiredParents = new Set<string>([
      dirname(config.audit.logPath),
      dirname(config.daemon.socketPath),
      config.daemon.pendingStorePath,
      config.daemon.claimRoot,
      config.daemon.writeIntentStorePath,
      dirname(config.release.editSessionPath),
      dirname(config.release.editCleanupJournalPath),
      dirname(config.release.commitAttemptJournalPath ?? ""),
    ]);
    const tmpDirs = tmpfilesDirectories(readFileSync(TMPFILES_PATH, "utf8"));
    const provisioned = new Set<string>([
      ...systemdRoots(readFileSync(SERVICE_PATH, "utf8")),
      ...tmpDirs,
    ]);

    // Every required parent is provisioned by systemd directory roots or tmpfiles.
    const missing = [...requiredParents].filter((path) => !provisioned.has(path));
    expect(missing).toEqual([]);

    // The exactly-0700 release-authority parent is provisioned and is required.
    expect(requiredParents.has("/var/lib/playops/release")).toBe(true);
    expect(tmpDirs).toContain("/var/lib/playops/release");

    // tmpfiles must not create a privileged path nobody needs.
    const unneeded = tmpDirs.filter((path) => !requiredParents.has(path));
    expect(unneeded).toEqual([]);

    // systemd stays the authority for the three roots; tmpfiles never duplicates them.
    const systemd = systemdRoots(readFileSync(SERVICE_PATH, "utf8"));
    expect(systemd).toEqual(
      expect.arrayContaining(["/run/playops", "/var/lib/playops", "/var/log/playops"]),
    );
    for (const path of tmpDirs) {
      expect(systemd).not.toContain(path);
    }
  });
});
