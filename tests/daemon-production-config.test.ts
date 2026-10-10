/**
 * Stage 4A.1 + Stage 4C.1 — production daemon configuration, path and
 * filesystem-trust validation.
 *
 * Offline, read-only: temporary directories only, no /etc, /var or /run access,
 * no Google call, no socket bind. Synthetic credential fixtures are written by
 * this test and are never real credentials. The Stage 4C.1 owner/mode checks use
 * the module-argument trust-policy seam (a non-root uid) so no privilege is
 * required; the production DEFAULT policy stays exactly `trustedOwnerUid: 0`.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type PlayOpsConfig } from "../src/config/index.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  ProductionDaemonConfigError,
  validateProductionDaemonConfig,
  validateProductionDaemonFilesystem,
  type ValidatedProductionDaemonConfig,
} from "../src/daemon/production-composition.js";
import type { FsTrustPolicy } from "../src/shared/fs-trust.js";

const PACKAGE = "com.example.app";
const CONFIG_TEXT = `google_play:\n  package_name: "${PACKAGE}"\n`;
/**
 * Module-argument seam: a temp fixture is owned by the test uid, not root. The
 * injected process group identity stands in for the production daemon's effective
 * (socket capability) group so the secret-service policy accepts an unprivileged
 * fixture; it is a module argument only, never env/CLI/config.
 */
const PROBE = mkdtempSync(join(tmpdir(), "playops-4c1a-config-probe-"));
const TEST_GID = lstatSync(PROBE).gid;
rmSync(PROBE, { recursive: true, force: true });
const TEST_POLICY: FsTrustPolicy = {
  trustedOwnerUid: process.getuid?.() ?? 0,
  processGroupIdentity: { effectiveGid: TEST_GID + 1, supplementaryGids: [TEST_GID] },
};
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
  // Stage 4C.1A: the config file and the credential are secret-bearing
  // production inputs, so the fixtures use the enforced secret-service mode.
  writeFileSync(join(root, "service-account.json"), "{}\n", { mode: 0o640 });
  chmodSync(join(root, "service-account.json"), 0o640);
  writeFileSync(join(root, "playops.yaml"), CONFIG_TEXT, { mode: 0o640 });
  chmodSync(join(root, "playops.yaml"), 0o640);
}

function validatedConfig(root: string): ValidatedProductionDaemonConfig {
  return validateProductionDaemonConfig(
    daemonConfig(root),
    join(root, "playops.yaml"),
    TEST_POLICY,
  );
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
    const report = await validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY);
    expect(report.stateDirectories).toHaveLength(3);
    // Read-only: the audited files were not created.
    expect(report.existingStateFiles).toEqual([]);
    // Read-only: the second pass still succeeds and writes nothing.
    const again = await validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY);
    expect(again.existingStateFiles).toEqual([]);
  });

  it("rejects a missing state directory, a wrong mode and a symlinked parent", async () => {
    const root = tempRoot();
    provision(root);
    rmSync(join(root, "claims"), { recursive: true });

    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);

    mkdirSync(join(root, "claims"), { mode: 0o755 });
    chmodSync(join(root, "claims"), 0o755);
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);

    rmSync(join(root, "claims"), { recursive: true });
    symlinkSync(join(root, "write-intents"), join(root, "claims"), "dir");
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);
  });

  it("rejects a release state parent that is not exactly 0700 and an unwritable state directory", async () => {
    const root = tempRoot();
    provision(root);
    // The commit-attempt journal enforces an exact 0700 parent on every read, so a
    // looser parent must fail at startup instead of failing every commit attempt.
    chmodSync(join(root, "state"), 0o750);
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);
    chmodSync(join(root, "state"), 0o700);

    // A 0700 directory the daemon cannot write to is still unusable.
    chmodSync(join(root, "claims"), 0o500);
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);
    chmodSync(join(root, "claims"), 0o700);
  });

  it("rejects a pre-existing socket path and a symlinked credential file", async () => {
    const root = tempRoot();
    provision(root);
    writeFileSync(join(root, "run", "playops.sock"), "");
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);

    rmSync(join(root, "run", "playops.sock"));
    rmSync(join(root, "service-account.json"));
    writeFileSync(join(root, "real-credential.json"), "{}\n", { mode: 0o600 });
    symlinkSync(join(root, "real-credential.json"), join(root, "service-account.json"));
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);
  });

  it("rejects an existing state file with a wider mode", async () => {
    const root = tempRoot();
    provision(root);
    writeFileSync(join(root, "state", "edit-session.json"), "{}\n", { mode: 0o644 });
    chmodSync(join(root, "state", "edit-session.json"), 0o644);
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);
  });
});

describe("stage 4C.1 configuration-file and credential trust", () => {
  it("accepts a secure fixture and refuses a symlinked, wrong-owner or group-writable config", () => {
    const root = tempRoot();
    provision(root);
    const config = daemonConfig(root);
    expect(validatedConfig(root).configPath).toBe(join(root, "playops.yaml"));

    // Symlinked config file: refused by the O_NOFOLLOW leaf open.
    const real = join(root, "real-config.yaml");
    writeFileSync(real, CONFIG_TEXT, { mode: 0o640 });
    chmodSync(real, 0o640);
    const link = join(root, "linked.yaml");
    symlinkSync(real, link);
    expect(() => validateProductionDaemonConfig(config, link, TEST_POLICY)).toThrow(
      ProductionDaemonConfigError,
    );
    expect(() => validateProductionDaemonConfig(config, link, TEST_POLICY)).toThrow(/integrity/u);

    // Wrong owner: the production-declared trusted uid does not match.
    expect(() =>
      validateProductionDaemonConfig(config, join(root, "playops.yaml"), {
        trustedOwnerUid: (process.getuid?.() ?? 0) + 1,
      }),
    ).toThrow(ProductionDaemonConfigError);

    // Group/other-writable config file.
    const wide = join(root, "wide.yaml");
    writeFileSync(wide, CONFIG_TEXT, { mode: 0o600 });
    chmodSync(wide, 0o666);
    expect(() => validateProductionDaemonConfig(config, wide, TEST_POLICY)).toThrow(
      ProductionDaemonConfigError,
    );

    // Unsafe parent directory (group/other-writable).
    const unsafeDir = join(root, "unsafe");
    mkdirSync(unsafeDir, { mode: 0o700 });
    const inUnsafe = join(unsafeDir, "playops.yaml");
    writeFileSync(inUnsafe, CONFIG_TEXT, { mode: 0o640 });
    chmodSync(inUnsafe, 0o640);
    chmodSync(unsafeDir, 0o777);
    expect(() => validateProductionDaemonConfig(config, inUnsafe, TEST_POLICY)).toThrow(
      ProductionDaemonConfigError,
    );
    chmodSync(unsafeDir, 0o700);
  });

  it("enforces the production default (root-owned) with no environment seam", () => {
    const root = tempRoot();
    provision(root);
    // No policy argument: the DEFAULT production policy is `trustedOwnerUid: 0`,
    // so the test-owned config file is refused. Nothing in the CLI or the
    // environment can supply this policy; it is a module argument only.
    expect(() =>
      validateProductionDaemonConfig(daemonConfig(root), join(root, "playops.yaml")),
    ).toThrow(ProductionDaemonConfigError);
  });

  it("refuses an unsafe credential leaf (symlink, group-writable, wrong owner)", async () => {
    const root = tempRoot();
    provision(root);

    rmSync(join(root, "service-account.json"));
    const realCredential = join(root, "real-credential.json");
    writeFileSync(realCredential, "{}\n", { mode: 0o640 });
    chmodSync(realCredential, 0o640);
    symlinkSync(realCredential, join(root, "service-account.json"));
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);

    rmSync(join(root, "service-account.json"));
    writeFileSync(join(root, "service-account.json"), "{}\n", { mode: 0o640 });
    chmodSync(join(root, "service-account.json"), 0o666);
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).rejects.toThrow(ProductionDaemonConfigError);

    chmodSync(join(root, "service-account.json"), 0o640);
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), {
        trustedOwnerUid: (process.getuid?.() ?? 0) + 1,
      }),
    ).rejects.toThrow(ProductionDaemonConfigError);

    // With the correct policy the same fixture is accepted.
    await expect(
      validateProductionDaemonFilesystem(validatedConfig(root), TEST_POLICY),
    ).resolves.toBeDefined();
  });

  it("refuses a credential inside a group/other-writable parent directory", async () => {
    const root = tempRoot();
    provision(root);
    const credDir = join(root, "creds");
    mkdirSync(credDir, { mode: 0o700 });
    const credentialPath = join(credDir, "service-account.json");
    writeFileSync(credentialPath, "{}\n", { mode: 0o640 });
    chmodSync(credentialPath, 0o640);
    chmodSync(credDir, 0o777);
    const config: PlayOpsConfig = {
      ...daemonConfig(root),
      googlePlay: { packageName: PACKAGE, serviceAccountJson: credentialPath },
    };
    const validated = validateProductionDaemonConfig(
      config,
      join(root, "playops.yaml"),
      TEST_POLICY,
    );
    await expect(validateProductionDaemonFilesystem(validated, TEST_POLICY)).rejects.toThrow(
      ProductionDaemonConfigError,
    );
    chmodSync(credDir, 0o700);
  });
});
