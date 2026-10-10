/**
 * Stage 4C.1A — production-consumer secret-file confidentiality.
 *
 * Exercises the REAL consumer entry points (`validateProductionDaemonConfig` and
 * `validateProductionDaemonFilesystem`) on temporary fixtures only: no /etc,
 * /var or /run access, no Google call, no socket bind and no host path creation.
 * The config file and the Google credential are the secret-bearing production
 * inputs, so the confidentiality / ownership / group matrix is asserted at the
 * consumer level, not only against the helper.
 *
 * The process group identity is injected through the module-argument policy seam
 * (never the CLI, environment or configuration) so an unprivileged fixture can be
 * accepted without a real second group; the production DEFAULT reads the real
 * process metadata. Precise leaf-vs-parent gid isolation (a leaf whose gid equals
 * the capability gid while its parent differs, and a leaf whose gid differs from
 * its parent) needs two different group ids on one fixture; that cannot be
 * provisioned unprivileged, so it is covered against the fully deterministic fake
 * port in `tests/fs-trust.test.ts`, while the consumer-level gid identity is
 * asserted here by seaming the effective group id.
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
import type { PlayOpsConfig } from "../src/config/index.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import {
  ProductionDaemonConfigError,
  validateProductionDaemonConfig,
  validateProductionDaemonFilesystem,
  type ValidatedProductionDaemonConfig,
} from "../src/daemon/production-composition.js";
import type { FsTrustPolicy } from "../src/shared/fs-trust.js";

const PACKAGE = "com.example.secret";
const CONFIG_TEXT = `google_play:\n  package_name: "${PACKAGE}"\n`;
const TEST_UID = process.getuid?.() ?? 0;

// Probe the gid a freshly created temp entry carries, so the injected process
// group identity matches the fixture without hard-coding a host gid.
const PROBE = mkdtempSync(join(tmpdir(), "playops-secret-probe-"));
const TEST_GID = lstatSync(PROBE).gid;
rmSync(PROBE, { recursive: true, force: true });
/** The daemon's effective (socket capability) group is a DIFFERENT id. */
const OTHER_GID = TEST_GID + 1;

function testPolicy(overrides: Partial<FsTrustPolicy> = {}): FsTrustPolicy {
  return {
    trustedOwnerUid: TEST_UID,
    processGroupIdentity: { effectiveGid: OTHER_GID, supplementaryGids: [TEST_GID] },
    ...overrides,
  };
}

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-secret-"));
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

function daemonConfig(root: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: {
      packageName: PACKAGE,
      serviceAccountJson: join(root, "creds", "google-play.json"),
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
    },
  };
}

function setMode(path: string, content: string, mode: number): void {
  // Recreate rather than truncate: a previous iteration may have left the file
  // owner-read-only, where O_WRONLY would fail EACCES for this unprivileged uid.
  rmSync(path, { force: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function provision(root: string): void {
  for (const dir of ["pending", "claims", "write-intents", "state", "logs", "run"]) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    chmodSync(join(root, dir), 0o700);
  }
  for (const dir of ["etc", "creds"]) {
    mkdirSync(join(root, dir), { mode: 0o750 });
    chmodSync(join(root, dir), 0o750);
  }
  setMode(join(root, "etc", "playops.yaml"), CONFIG_TEXT, 0o640);
  setMode(join(root, "creds", "google-play.json"), "{}\n", 0o640);
}

const configPath = (root: string): string => join(root, "etc", "playops.yaml");
const credentialPath = (root: string): string => join(root, "creds", "google-play.json");

const CONFIG_MATRIX_MODES = [0o644, 0o444, 0o646, 0o660, 0o664, 0o666, 0o600, 0o400] as const;

function expectConfigError(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(ProductionDaemonConfigError);
  expect((caught as ProductionDaemonConfigError).code).toBe("DAEMON_CONFIG_FILE_UNSAFE");
}

async function expectCredentialError(
  validated: ValidatedProductionDaemonConfig,
  policy: FsTrustPolicy,
): Promise<void> {
  let caught: unknown;
  try {
    await validateProductionDaemonFilesystem(validated, policy);
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBeInstanceOf(ProductionDaemonConfigError);
  expect((caught as ProductionDaemonConfigError).code).toBe("DAEMON_CREDENTIAL_PATH_UNSAFE");
}

/** Validate the config with the SECURE policy and return the parsed surface. */
function validatedSecure(root: string): ValidatedProductionDaemonConfig {
  return validateProductionDaemonConfig(daemonConfig(root), configPath(root), testPolicy());
}

describe("stage 4C.1A config-file confidentiality (production consumer)", () => {
  it("accepts an exact 0640/0440 config in a group-readable, non-capability parent", () => {
    const root = tempRoot();
    provision(root);
    expect(validatedSecure(root).configPath).toBe(configPath(root));
    setMode(configPath(root), CONFIG_TEXT, 0o440);
    expect(validatedSecure(root).configPath).toBe(configPath(root));
  });

  it("refuses a world-readable, world-writable or loose-mode config leaf", () => {
    const root = tempRoot();
    provision(root);
    for (const mode of CONFIG_MATRIX_MODES) {
      setMode(configPath(root), CONFIG_TEXT, mode);
      expectConfigError(() =>
        validateProductionDaemonConfig(daemonConfig(root), configPath(root), testPolicy()),
      );
    }
  });

  it("refuses a wrongly-owned config leaf", () => {
    const root = tempRoot();
    provision(root);
    expectConfigError(() =>
      validateProductionDaemonConfig(
        daemonConfig(root),
        configPath(root),
        testPolicy({ trustedOwnerUid: TEST_UID + 1 }),
      ),
    );
  });

  it("refuses a symlinked or directory config leaf", () => {
    const root = tempRoot();
    provision(root);
    const real = join(root, "etc", "real.yaml");
    setMode(real, CONFIG_TEXT, 0o640);
    const link = join(root, "etc", "linked.yaml");
    symlinkSync(real, link);
    expectConfigError(() => validateProductionDaemonConfig(daemonConfig(root), link, testPolicy()));
    const dirLeaf = join(root, "etc", "dir.yaml");
    mkdirSync(dirLeaf, { mode: 0o640 });
    chmodSync(dirLeaf, 0o640);
    expectConfigError(() =>
      validateProductionDaemonConfig(daemonConfig(root), dirLeaf, testPolicy()),
    );
  });

  it("refuses a group- or other-writable config parent directory", () => {
    const root = tempRoot();
    provision(root);
    chmodSync(join(root, "etc"), 0o777);
    expectConfigError(() =>
      validateProductionDaemonConfig(daemonConfig(root), configPath(root), testPolicy()),
    );
    chmodSync(join(root, "etc"), 0o770);
    expectConfigError(() =>
      validateProductionDaemonConfig(daemonConfig(root), configPath(root), testPolicy()),
    );
    chmodSync(join(root, "etc"), 0o750);
  });

  it("refuses a config whose trusted secret gid is the socket capability gid", () => {
    const root = tempRoot();
    provision(root);
    // The leaf and its parent share the trusted secret gid, so seaming that gid as
    // the effective (socket capability) gid makes the consumer refuse it. The
    // parent is validated first, then the leaf would refuse too.
    expectConfigError(() =>
      validateProductionDaemonConfig(
        daemonConfig(root),
        configPath(root),
        testPolicy({
          processGroupIdentity: { effectiveGid: TEST_GID, supplementaryGids: [TEST_GID] },
        }),
      ),
    );
  });

  it("refuses a trusted secret group the daemon does not hold", () => {
    const root = tempRoot();
    provision(root);
    expectConfigError(() =>
      validateProductionDaemonConfig(
        daemonConfig(root),
        configPath(root),
        testPolicy({ processGroupIdentity: { effectiveGid: OTHER_GID, supplementaryGids: [] } }),
      ),
    );
  });

  it("skips only the supplementary-group comparison when getgroups is unavailable", () => {
    const root = tempRoot();
    provision(root);
    // getgroups unavailable: acceptance is allowed only when the trusted gid is
    // not the effective gid; the effective-gid comparison is never skipped.
    expect(
      validateProductionDaemonConfig(
        daemonConfig(root),
        configPath(root),
        testPolicy({
          processGroupIdentity: { effectiveGid: OTHER_GID, supplementaryGids: undefined },
        }),
      ).configPath,
    ).toBe(configPath(root));
    expectConfigError(() =>
      validateProductionDaemonConfig(
        daemonConfig(root),
        configPath(root),
        testPolicy({
          processGroupIdentity: { effectiveGid: TEST_GID, supplementaryGids: undefined },
        }),
      ),
    );
  });
});

describe("stage 4C.1A credential confidentiality (production consumer)", () => {
  it("accepts an exact 0640/0440 credential in a group-readable parent", async () => {
    const root = tempRoot();
    provision(root);
    await expect(
      validateProductionDaemonFilesystem(validatedSecure(root), testPolicy()),
    ).resolves.toBeDefined();
    setMode(credentialPath(root), "{}\n", 0o440);
    await expect(
      validateProductionDaemonFilesystem(validatedSecure(root), testPolicy()),
    ).resolves.toBeDefined();
  });

  it("refuses a world-readable, world-writable or loose-mode credential leaf", async () => {
    const root = tempRoot();
    provision(root);
    for (const mode of CONFIG_MATRIX_MODES) {
      setMode(credentialPath(root), "{}\n", mode);
      await expectCredentialError(validatedSecure(root), testPolicy());
    }
  });

  it("refuses a wrongly-owned credential leaf", async () => {
    const root = tempRoot();
    provision(root);
    await expectCredentialError(
      validatedSecure(root),
      testPolicy({ trustedOwnerUid: TEST_UID + 1 }),
    );
  });

  it("refuses a symlinked credential leaf", async () => {
    const root = tempRoot();
    provision(root);
    const real = join(root, "creds", "real.json");
    setMode(real, "{}\n", 0o640);
    rmSync(credentialPath(root));
    symlinkSync(real, credentialPath(root));
    await expectCredentialError(validatedSecure(root), testPolicy());
  });

  it("refuses a group- or other-writable credential parent directory", async () => {
    const root = tempRoot();
    provision(root);
    chmodSync(join(root, "creds"), 0o777);
    await expectCredentialError(validatedSecure(root), testPolicy());
  });

  it("refuses a credential whose trusted secret gid is the socket capability gid", async () => {
    const root = tempRoot();
    provision(root);
    await expectCredentialError(
      validatedSecure(root),
      testPolicy({
        processGroupIdentity: { effectiveGid: TEST_GID, supplementaryGids: [TEST_GID] },
      }),
    );
  });

  it("refuses a trusted secret group the daemon does not hold", async () => {
    const root = tempRoot();
    provision(root);
    await expectCredentialError(
      validatedSecure(root),
      testPolicy({ processGroupIdentity: { effectiveGid: OTHER_GID, supplementaryGids: [] } }),
    );
  });

  it("keeps the readable-by-the-daemon-user probe as a separate check", async () => {
    const root = tempRoot();
    provision(root);
    // A secure, correctly-grouped and readable leaf passes; the trust check and the
    // readability probe are independent and both required.
    setMode(credentialPath(root), "{}\n", 0o440);
    await expect(
      validateProductionDaemonFilesystem(validatedSecure(root), testPolicy()),
    ).resolves.toBeDefined();
  });
});
