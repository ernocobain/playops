/**
 * Stage 4A.1 — production daemon configuration and path validation.
 *
 * Offline, read-only: temporary directories only, no /etc, /var or /run access,
 * no Google call, no socket bind. Synthetic credential fixtures are written by
 * this test and are never real credentials.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type PlayOpsConfig } from "../src/config/index.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  ProductionDaemonConfigError,
  validateProductionDaemonConfig,
  validateProductionDaemonFilesystem,
} from "../src/daemon/production-composition.js";

const PACKAGE = "com.example.app";
const roots: string[] = [];

function tempRoot(mode = 0o700): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-4a1-config-"));
  chmodSync(dir, mode);
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Absolute production-shaped config pointing inside one temp root. */
function daemonConfig(
  root: string,
  overrides: Partial<PlayOpsConfig["daemon"]> = {},
): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: {
      packageName: PACKAGE,
      serviceAccountJson: join(root, "service-account.json"),
    },
    audit: { logPath: join(root, "logs", "playops.audit.jsonl") },
    release: {
      editSessionPath: join(root, "state", "edit-session.json"),
      editCleanupJournalPath: join(root, "state", "edit-cleanup-journal.json"),
      commitAttemptJournalPath: join(root, "state", "commit-attempt-journal.json"),
    },
    daemon: {
      socketPath: join(root, "run", "playops.sock"),
      pendingStorePath: join(root, "pending"),
      claimRoot: join(root, "claims"),
      writeIntentStorePath: join(root, "write-intents"),
      ...overrides,
    },
  };
}

function provision(root: string): void {
  for (const dir of [
    join(root, "pending"),
    join(root, "claims"),
    join(root, "write-intents"),
    join(root, "state"),
    join(root, "logs"),
    join(root, "run"),
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  writeFileSync(join(root, "service-account.json"), "{}\n", { mode: 0o600 });
}

describe("stage 4A.1 daemon config surface", () => {
  it("keeps production-oriented defaults without changing CLI defaults", () => {
    expect(DEFAULT_CONFIG.daemon).toEqual({
      socketPath: "/run/playops/playops.sock",
      pendingStorePath: "/var/lib/playops/pending",
      claimRoot: "/var/lib/playops/claims",
      writeIntentStorePath: "/var/lib/playops/write-intents",
    });
    // The ordinary CLI must not need those directories merely because they have
    // defaults: a config file that omits the daemon section stays inert.
    const root = tempRoot();
    const file = join(root, "playops.yaml");
    writeFileSync(file, `google_play:\n  package_name: "${PACKAGE}"\n`);
    const config = loadConfig({ configPath: file, env: {} });
    expect(config.daemon.socketPath).toBe(DEFAULT_CONFIG.daemon.socketPath);
  });

  it("loads the daemon section from YAML and from the documented env names", () => {
    const root = tempRoot();
    const file = join(root, "playops.yaml");
    writeFileSync(
      file,
      [
        "google_play:",
        `  package_name: "${PACKAGE}"`,
        "daemon:",
        `  socket_path: "${join(root, "run", "playops.sock")}"`,
        `  pending_store_path: "${join(root, "pending")}"`,
        `  claim_root: "${join(root, "claims")}"`,
        `  write_intent_store_path: "${join(root, "write-intents")}"`,
        "",
      ].join("\n"),
    );
    const fromFile = loadConfig({ configPath: file, env: {} });
    expect(fromFile.daemon.pendingStorePath).toBe(join(root, "pending"));

    const fromEnv = loadConfig({
      configPath: file,
      env: {
        PLAYOPS_DAEMON_SOCKET_PATH: join(root, "env.sock"),
        PLAYOPS_DAEMON_CLAIM_ROOT: join(root, "env-claims"),
      },
    });
    expect(fromEnv.daemon.socketPath).toBe(join(root, "env.sock"));
    expect(fromEnv.daemon.claimRoot).toBe(join(root, "env-claims"));
    // Unset env keys keep the file value: env > file > default is preserved.
    expect(fromEnv.daemon.pendingStorePath).toBe(join(root, "pending"));
  });
});

describe("stage 4A.1 production path validation", () => {
  it("requires an absolute --config and rejects a relative or empty one", () => {
    const config = daemonConfig(tempRoot());
    for (const value of ["relative/playops.yaml", "", undefined, "./playops.yaml"]) {
      expect(() => validateProductionDaemonConfig(config, value)).toThrow(
        ProductionDaemonConfigError,
      );
    }
  });

  it("rejects a relative credential, audit, release or daemon path", () => {
    const root = tempRoot();
    const cases: readonly ((config: PlayOpsConfig) => PlayOpsConfig)[] = [
      (config) => ({
        ...config,
        googlePlay: { ...config.googlePlay, serviceAccountJson: "relative.json" },
      }),
      (config) => ({ ...config, audit: { logPath: "logs/audit.jsonl" } }),
      (config) => ({ ...config, release: { ...config.release, editSessionPath: "state/s.json" } }),
      (config) => ({
        ...config,
        release: { ...config.release, editCleanupJournalPath: "state/cleanup.json" },
      }),
      (config) => ({
        ...config,
        release: { ...config.release, commitAttemptJournalPath: "state/commit.json" },
      }),
      (config) => ({ ...config, daemon: { ...config.daemon, socketPath: "run/playops.sock" } }),
      (config) => ({ ...config, daemon: { ...config.daemon, pendingStorePath: "pending" } }),
      (config) => ({ ...config, daemon: { ...config.daemon, claimRoot: "claims" } }),
      (config) => ({
        ...config,
        daemon: { ...config.daemon, writeIntentStorePath: "write-intents" },
      }),
    ];
    for (const mutate of cases) {
      const config = mutate(daemonConfig(root));
      expect(() => validateProductionDaemonConfig(config, join(root, "playops.yaml"))).toThrow(
        ProductionDaemonConfigError,
      );
    }
  });

  it("rejects dot-segment escaping and a missing credential path", () => {
    const root = tempRoot();
    expect(() =>
      validateProductionDaemonConfig(
        { ...daemonConfig(root), googlePlay: { packageName: PACKAGE, serviceAccountJson: "" } },
        join(root, "playops.yaml"),
      ),
    ).toThrow(ProductionDaemonConfigError);
    // A raw string: `join` would normalize the parent segment away.
    const escaping = `${root}/../escape.json`;
    expect(() =>
      validateProductionDaemonConfig(
        {
          ...daemonConfig(root),
          googlePlay: { packageName: PACKAGE, serviceAccountJson: escaping },
        },
        join(root, "playops.yaml"),
      ),
    ).toThrow(ProductionDaemonConfigError);
  });

  it("rejects an invalid package name at startup", () => {
    const root = tempRoot();
    expect(() =>
      validateProductionDaemonConfig(
        {
          ...daemonConfig(root),
          googlePlay: { packageName: "", serviceAccountJson: join(root, "s.json") },
        },
        join(root, "playops.yaml"),
      ),
    ).toThrow(ProductionDaemonConfigError);
  });
});

describe("stage 4A.1 filesystem validation", () => {
  it("accepts a valid absolute secure temp hierarchy without writing anything", async () => {
    const root = tempRoot();
    provision(root);
    const validated = validateProductionDaemonConfig(
      daemonConfig(root),
      join(root, "playops.yaml"),
    );
    const report = await validateProductionDaemonFilesystem(validated);
    expect(report.stateDirectories).toHaveLength(3);
    // Read-only: the audited files were not created.
    expect(report.existingStateFiles).toEqual([]);
    // Read-only: the second pass still succeeds and writes nothing.
    const again = await validateProductionDaemonFilesystem(
      validateProductionDaemonConfig(daemonConfig(root), join(root, "playops.yaml")),
    );
    expect(again.existingStateFiles).toEqual([]);
  });

  it("rejects a missing state directory, a wrong mode and a symlinked parent", async () => {
    const root = tempRoot();
    provision(root);
    rmSync(join(root, "claims"), { recursive: true });

    const missing = validateProductionDaemonConfig(daemonConfig(root), join(root, "playops.yaml"));
    await expect(validateProductionDaemonFilesystem(missing)).rejects.toThrow(
      ProductionDaemonConfigError,
    );

    mkdirSync(join(root, "claims"), { mode: 0o755 });
    chmodSync(join(root, "claims"), 0o755);
    const wide = validateProductionDaemonConfig(daemonConfig(root), join(root, "playops.yaml"));
    await expect(validateProductionDaemonFilesystem(wide)).rejects.toThrow(
      ProductionDaemonConfigError,
    );

    rmSync(join(root, "claims"), { recursive: true });
    symlinkSync(join(root, "write-intents"), join(root, "claims"), "dir");
    const symlinked = validateProductionDaemonConfig(
      daemonConfig(root),
      join(root, "playops.yaml"),
    );
    await expect(validateProductionDaemonFilesystem(symlinked)).rejects.toThrow(
      ProductionDaemonConfigError,
    );
  });

  it("rejects a release state parent that is not exactly 0700 and an unwritable state directory", async () => {
    const root = tempRoot();
    provision(root);
    // The commit-attempt journal enforces an exact 0700 parent on every read, so a
    // looser parent must fail at startup instead of failing every commit attempt.
    chmodSync(join(root, "state"), 0o750);
    await expect(
      validateProductionDaemonFilesystem(
        validateProductionDaemonConfig(daemonConfig(root), join(root, "playops.yaml")),
      ),
    ).rejects.toThrow(ProductionDaemonConfigError);
    chmodSync(join(root, "state"), 0o700);

    // A 0700 directory the daemon cannot write to is still unusable.
    chmodSync(join(root, "claims"), 0o500);
    await expect(
      validateProductionDaemonFilesystem(
        validateProductionDaemonConfig(daemonConfig(root), join(root, "playops.yaml")),
      ),
    ).rejects.toThrow(ProductionDaemonConfigError);
    chmodSync(join(root, "claims"), 0o700);
  });

  it("rejects a pre-existing socket path and a symlinked credential file", async () => {
    const root = tempRoot();
    provision(root);
    writeFileSync(join(root, "run", "playops.sock"), "");
    const withSocket = validateProductionDaemonConfig(
      daemonConfig(root),
      join(root, "playops.yaml"),
    );
    await expect(validateProductionDaemonFilesystem(withSocket)).rejects.toThrow(
      ProductionDaemonConfigError,
    );

    rmSync(join(root, "run", "playops.sock"));
    rmSync(join(root, "service-account.json"));
    writeFileSync(join(root, "real-credential.json"), "{}\n", { mode: 0o600 });
    symlinkSync(join(root, "real-credential.json"), join(root, "service-account.json"));
    const withSymlink = validateProductionDaemonConfig(
      daemonConfig(root),
      join(root, "playops.yaml"),
    );
    await expect(validateProductionDaemonFilesystem(withSymlink)).rejects.toThrow(
      ProductionDaemonConfigError,
    );
  });

  it("rejects an existing state file with a wider mode", async () => {
    const root = tempRoot();
    provision(root);
    writeFileSync(join(root, "state", "edit-session.json"), "{}\n", { mode: 0o644 });
    chmodSync(join(root, "state", "edit-session.json"), 0o644);
    const validated = validateProductionDaemonConfig(
      daemonConfig(root),
      join(root, "playops.yaml"),
    );
    await expect(validateProductionDaemonFilesystem(validated)).rejects.toThrow(
      ProductionDaemonConfigError,
    );
  });
});
