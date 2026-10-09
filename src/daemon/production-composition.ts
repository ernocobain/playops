/**
 * Stage 4A.1 — production daemon composition and startup validation.
 *
 * WHAT THIS MODULE IS
 * ===================
 * Application bootstrap for `playopsd`: it turns the released v0.3.0 core into
 * ONE production process. It is COMPOSITION ONLY — no core operation semantics,
 * schemas, protocol versions or verifier behaviour are changed here.
 *
 * Flow (see `playopsd.ts` for the entrypoint that owns process concerns):
 *
 *   explicit absolute config path
 *     -> config parse (existing loader)
 *     -> production-only path/config validation            (this module)
 *     -> filesystem safety validation for every state path  (this module)
 *     -> pinned production operator verifier (eager, fail closed)
 *     -> credential load + auth + Android Publisher client  (existing flow)
 *     -> durable stores + ONE package coordinator           (existing constructors)
 *     -> createDaemonOperations (all served operations)     (existing core)
 *
 * ZERO GOOGLE AT STARTUP
 * ======================
 * Every step above is local: file reads, JSON parsing, object construction and a
 * local socket bind. `createGoogleAuthClient` constructs a JWT client object and
 * does not fetch a token; the only token path (`getGoogleAccessToken`) is called
 * from an operation, never from composition. Constructors of every durable store
 * are I/O-free (writes happen inside operations).
 *
 * AUTHORITY RULES HONOURED HERE
 * =============================
 *   - Every security-sensitive production path must be absolute. Nothing is
 *     resolved against cwd, a user home, `NODE_PATH` or a mutable checkout.
 *   - The operator trust anchor is the source-level constant
 *     `/etc/playops/operator-approval.pub`, loaded through
 *     `createProductionOperatorVerifier()`. There is no yaml/env/CLI override.
 *     The `createVerifier` factory below exists because the repository's own live
 *     composition uses the same injectable-factory pattern for tests; the
 *     production entrypoint always uses the pinned default.
 *   - Exactly ONE package-operation coordinator instance is constructed and
 *     injected into every served operation.
 *   - Missing authority (session, cleanup journal, commit-attempt journal,
 *     pending/claim/write-intent roots) fails at startup instead of exposing a
 *     partially-wired production daemon.
 */
import { constants as fsConstants, readFileSync, type Stats } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  loadServiceAccountCredentials,
  type LoadConfigOptions,
  type PlayOpsConfig,
  type ServiceAccountCredentials,
} from "../config/index.js";
import {
  ANDROID_PUBLISHER_SCOPE,
  createGoogleAuthClient,
  type GoogleAuthClient,
} from "../googleplay/auth/index.js";
import {
  createAndroidPublisherClient,
  type AndroidPublisherClient,
} from "../googleplay/publisher/index.js";
import { createFileAgentLedger } from "../runtime/agent/index.js";
import { createFileApprovalLedger } from "../runtime/approvals/index.js";
import {
  createProductionOperatorVerifier,
  type OperatorApprovalVerifier,
} from "../runtime/approvals/operator-signature.js";
import { createFileVerificationLedger } from "../runtime/verification/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../releases/composition.js";
import { ReleaseError, validateReleasePackageName } from "../releases/index.js";
import { createFileReleaseCommitAttemptJournal } from "../releases/commit-attempt-journal.js";
import { createFileReleaseWriteIntentStore } from "../releases/release-write-intent-store.js";
import type { ReleaseWriteIntentStore } from "../releases/release-write-intent-store.js";
import type { DaemonDiagnosticSink } from "./lifecycle.js";
import {
  createDaemonOperations,
  DAEMON_SERVED_OPERATIONS,
  type DaemonOperations,
  type DaemonStatusEvidence,
} from "./operations.js";
import {
  createPackageOperationSingleFlightCoordinator,
  type PackageOperationCoordinator,
} from "./package-operation-singleflight.js";
import { createFilePendingOperationStore, type PendingOperationStore } from "./pending-store.js";
import type { DaemonRequestEnvelope } from "./protocol.js";

/** The owner-only socket contract supported by the released core. */
export const PRODUCTION_DAEMON_SOCKET_MODE = 0o600;
/** The served-operation count this composition insists on wiring. */
export const PRODUCTION_DAEMON_SERVED_OPERATION_COUNT = 10;

export type ProductionDaemonConfigErrorCode =
  | "DAEMON_CONFIG_PATH_MISSING"
  | "DAEMON_CONFIG_PATH_NOT_ABSOLUTE"
  | "DAEMON_CONFIG_INVALID"
  | "DAEMON_PATH_NOT_ABSOLUTE"
  | "DAEMON_PATH_INVALID"
  | "DAEMON_STATE_DIRECTORY_UNSAFE"
  | "DAEMON_STATE_FILE_UNSAFE"
  | "DAEMON_CREDENTIAL_PATH_UNSAFE"
  | "DAEMON_SOCKET_PATH_UNSAFE"
  | "DAEMON_COMPOSITION_INCOMPLETE";

/**
 * Typed startup failure. Messages carry only safe metadata: a field name, a
 * resolved path and the error code. Never credential material, key bytes, tokens,
 * signatures or journal contents.
 */
export class ProductionDaemonConfigError extends Error {
  override readonly name = "ProductionDaemonConfigError";

  constructor(
    readonly code: ProductionDaemonConfigErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

/** Every path the production daemon depends on, already proven absolute. */
export interface ValidatedProductionDaemonConfig {
  readonly configPath: string;
  readonly packageName: string;
  readonly credentialPath: string;
  readonly auditLogPath: string;
  readonly editSessionPath: string;
  readonly editCleanupJournalPath: string;
  readonly commitAttemptJournalPath: string;
  readonly socketPath: string;
  readonly pendingStorePath: string;
  readonly claimRoot: string;
  readonly writeIntentStorePath: string;
}

function fail(
  code: ProductionDaemonConfigErrorCode,
  message: string,
  path?: string,
): ProductionDaemonConfigError {
  return new ProductionDaemonConfigError(code, message, path);
}

/** Reject empty, relative, control-bearing or dot-segment-escaping paths. */
function assertAbsoluteSafePath(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw fail("DAEMON_PATH_INVALID", `${field} must be a non-empty absolute path.`);
  }
  if (value !== value.trim()) {
    throw fail("DAEMON_PATH_INVALID", `${field} must not carry surrounding whitespace.`, value);
  }
  // eslint-disable-next-line no-control-regex -- paths must never carry control bytes
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw fail("DAEMON_PATH_INVALID", `${field} must not contain control characters.`);
  }
  if (!isAbsolute(value)) {
    throw fail("DAEMON_PATH_NOT_ABSOLUTE", `${field} must be an absolute path.`, value);
  }
  const segments = value.split(sep);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw fail(
      "DAEMON_PATH_INVALID",
      `${field} must not contain current/parent directory segments.`,
      value,
    );
  }
  return value;
}

/**
 * Validate the production-only configuration surface. Generic CLI parsing is not
 * changed: this is a separate, stricter daemon contract, so a plain `playops`
 * command keeps working with relative example paths.
 */
export function validateProductionDaemonConfig(
  config: PlayOpsConfig,
  configPath: unknown,
): ValidatedProductionDaemonConfig {
  const resolvedConfigPath = assertAbsoluteSafePath("--config", configPath);
  let packageName: string;
  try {
    packageName = validateReleasePackageName(config.googlePlay.packageName);
  } catch (cause) {
    throw fail(
      "DAEMON_CONFIG_INVALID",
      "The daemon requires a valid Google Play package name in the configuration.",
      typeof cause === "string" ? cause : undefined,
    );
  }
  const daemon = config.daemon;
  return Object.freeze({
    configPath: resolvedConfigPath,
    packageName,
    credentialPath: assertAbsoluteSafePath(
      "google_play.service_account_json",
      config.googlePlay.serviceAccountJson,
    ),
    auditLogPath: assertAbsoluteSafePath("audit.log_path", config.audit.logPath),
    editSessionPath: assertAbsoluteSafePath(
      "release.edit_session_path",
      config.release.editSessionPath,
    ),
    editCleanupJournalPath: assertAbsoluteSafePath(
      "release.edit_cleanup_journal_path",
      config.release.editCleanupJournalPath,
    ),
    // Mandatory for the full daemon: attach/commit/verify/reconcile authority.
    commitAttemptJournalPath: assertAbsoluteSafePath(
      "release.commit_attempt_journal_path",
      config.release.commitAttemptJournalPath ?? "",
    ),
    socketPath: assertAbsoluteSafePath("daemon.socket_path", daemon.socketPath),
    pendingStorePath: assertAbsoluteSafePath("daemon.pending_store_path", daemon.pendingStorePath),
    claimRoot: assertAbsoluteSafePath("daemon.claim_root", daemon.claimRoot),
    writeIntentStorePath: assertAbsoluteSafePath(
      "daemon.write_intent_store_path",
      daemon.writeIntentStorePath,
    ),
  });
}

export interface ProductionDaemonFilesystemReport {
  /** Private 0700 state directories that must already exist. */
  readonly stateDirectories: readonly string[];
  /** Directories that must be real, non-symlink and not group/other-writable. */
  readonly guardedDirectories: readonly string[];
  /** State files checked when they already exist (regular, non-symlink, 0600). */
  readonly existingStateFiles: readonly string[];
}

async function statPath(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function assertPrivateStateDirectory(field: string, path: string): Promise<void> {
  const stat = await statPath(path);
  if (stat === undefined) {
    throw fail(
      "DAEMON_STATE_DIRECTORY_UNSAFE",
      `${field} must already exist and be provisioned by deployment.`,
      path,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw fail("DAEMON_STATE_DIRECTORY_UNSAFE", `${field} must be a real directory.`, path);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw fail("DAEMON_STATE_DIRECTORY_UNSAFE", `${field} must be mode 0700.`, path);
  }
  await assertWritable(field, path, "DAEMON_STATE_DIRECTORY_UNSAFE");
}

/**
 * A parent that holds a durable release-authority file. The commit-attempt
 * journal independently requires its parent to be exactly 0700 on every read, so
 * a looser parent here would let the daemon start and then fail every
 * commit/verify/reconcile attempt. Fail at startup instead.
 */
async function assertPrivateStateParent(field: string, path: string): Promise<void> {
  const stat = await statPath(path);
  if (stat === undefined) {
    throw fail("DAEMON_STATE_DIRECTORY_UNSAFE", `${field} parent directory must exist.`, path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw fail(
      "DAEMON_STATE_DIRECTORY_UNSAFE",
      `${field} parent must be a real directory, not a symlink.`,
      path,
    );
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw fail("DAEMON_STATE_DIRECTORY_UNSAFE", `${field} parent must be mode 0700.`, path);
  }
  await assertWritable(field, path, "DAEMON_STATE_DIRECTORY_UNSAFE");
}

async function assertGuardedDirectory(field: string, path: string): Promise<void> {
  const stat = await statPath(path);
  if (stat === undefined) {
    throw fail("DAEMON_STATE_DIRECTORY_UNSAFE", `${field} parent directory must exist.`, path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw fail(
      "DAEMON_STATE_DIRECTORY_UNSAFE",
      `${field} parent must be a real directory, not a symlink.`,
      path,
    );
  }
  if ((stat.mode & 0o022) !== 0) {
    throw fail(
      "DAEMON_STATE_DIRECTORY_UNSAFE",
      `${field} parent must not be group- or other-writable.`,
      path,
    );
  }
  await assertWritable(field, path, "DAEMON_STATE_DIRECTORY_UNSAFE");
}

/** Read-only writability probe. Creates nothing; never chmods anything. */
async function assertWritable(
  field: string,
  path: string,
  code: ProductionDaemonConfigErrorCode,
): Promise<void> {
  try {
    await access(path, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw fail(code, `${field} must be writable by the daemon user.`, path);
  }
}

async function assertExistingStateFile(field: string, path: string): Promise<boolean> {
  const stat = await statPath(path);
  if (stat === undefined) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw fail("DAEMON_STATE_FILE_UNSAFE", `${field} must be a regular file.`, path);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw fail("DAEMON_STATE_FILE_UNSAFE", `${field} must be mode 0600.`, path);
  }
  try {
    await access(path, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw fail(
      "DAEMON_STATE_FILE_UNSAFE",
      `${field} must be readable and writable by the daemon user.`,
      path,
    );
  }
  return true;
}

/**
 * Read-only filesystem validation. It never creates, chowns, chmods or removes
 * anything: deployment owns provisioning (/etc, /var, /run are untouched).
 */
export async function validateProductionDaemonFilesystem(
  validated: ValidatedProductionDaemonConfig,
): Promise<ProductionDaemonFilesystemReport> {
  await assertPrivateStateDirectory("daemon.pending_store_path", validated.pendingStorePath);
  await assertPrivateStateDirectory("daemon.claim_root", validated.claimRoot);
  await assertPrivateStateDirectory(
    "daemon.write_intent_store_path",
    validated.writeIntentStorePath,
  );

  const stateFiles: readonly (readonly [string, string])[] = [
    ["release.edit_session_path", validated.editSessionPath],
    ["release.edit_cleanup_journal_path", validated.editCleanupJournalPath],
    ["release.commit_attempt_journal_path", validated.commitAttemptJournalPath],
  ];
  const guarded = new Set<string>();
  for (const [field, file] of stateFiles) {
    const parent = file.slice(0, file.lastIndexOf(sep));
    guarded.add(parent);
    // Exact 0700: the durable release-authority contract the core journals
    // themselves enforce on read.
    await assertPrivateStateParent(field, parent);
    await assertExistingStateFile(field, file);
  }
  const auditParent = validated.auditLogPath.slice(0, validated.auditLogPath.lastIndexOf(sep));
  guarded.add(auditParent);
  // The audit log lives where an operator chooses; a log directory is commonly
  // root-owned 0750, so this one keeps the core's own not-group/other-writable
  // rule instead of an exact 0700 requirement.
  await assertGuardedDirectory("audit.log_path", auditParent);
  const auditExisted = await assertExistingStateFile("audit.log_path", validated.auditLogPath);

  // Credential: a real, non-symlink regular file. Content validation (JSON +
  // service-account shape) belongs to the existing credential loader.
  const credential = await statPath(validated.credentialPath);
  if (credential === undefined || credential.isSymbolicLink() || !credential.isFile()) {
    throw fail(
      "DAEMON_CREDENTIAL_PATH_UNSAFE",
      "google_play.service_account_json must be an existing regular file, not a symlink.",
      validated.credentialPath,
    );
  }
  try {
    await access(validated.credentialPath, fsConstants.R_OK);
  } catch {
    throw fail(
      "DAEMON_CREDENTIAL_PATH_UNSAFE",
      "google_play.service_account_json must be readable by the daemon user.",
      validated.credentialPath,
    );
  }

  // Socket parent: real directory, non-symlink, not group/other-writable.
  const socketParent = validated.socketPath.slice(0, validated.socketPath.lastIndexOf(sep));
  guarded.add(socketParent);
  await assertGuardedDirectory("daemon.socket_path", socketParent);
  // Any pre-existing socket path in any form is a startup failure; the core's
  // own `start()` refuses it too, and nothing here ever unlinks a stale socket.
  const existingSocket = await statPath(validated.socketPath);
  if (existingSocket !== undefined) {
    throw fail(
      "DAEMON_SOCKET_PATH_UNSAFE",
      "daemon.socket_path already exists; the daemon never replaces a socket or file.",
      validated.socketPath,
    );
  }

  return Object.freeze({
    stateDirectories: Object.freeze([
      validated.pendingStorePath,
      validated.claimRoot,
      validated.writeIntentStorePath,
    ]),
    guardedDirectories: Object.freeze([...guarded].sort()),
    existingStateFiles: Object.freeze(auditExisted ? [validated.auditLogPath] : []),
  });
}

/** Injectable construction seam. Defaults are the production implementations. */
export interface ProductionDaemonFactories {
  readonly loadConfig?: (options: LoadConfigOptions) => PlayOpsConfig;
  readonly loadCredentials?: (config: PlayOpsConfig) => ServiceAccountCredentials;
  readonly authenticate?: (
    credentials: ServiceAccountCredentials,
    scopes: string[],
  ) => GoogleAuthClient;
  readonly createPublisher?: (auth: GoogleAuthClient) => AndroidPublisherClient;
  /**
   * Deliberately a factory with the PINNED default. Tests use it to inject a
   * lower-level verifier; production never overrides it, and no yaml/env/CLI/cwd
   * value can reach it.
   */
  readonly createVerifier?: () => OperatorApprovalVerifier;
}

export interface ProductionDaemonApplication {
  readonly configPath: string;
  readonly config: PlayOpsConfig;
  readonly validated: ValidatedProductionDaemonConfig;
  readonly filesystem: ProductionDaemonFilesystemReport;
  readonly composition: ProductionDaemonComposition;
}

/**
 * Full production startup: config -> validation -> verifier -> credentials ->
 * auth -> publisher -> composition. Every failure here happens BEFORE the socket
 * is bound and performs zero Google calls.
 */
export async function createProductionDaemonApplication(options: {
  readonly configPath: string;
  readonly env?: Record<string, string | undefined>;
  readonly factories?: ProductionDaemonFactories;
  readonly now?: () => Date;
  readonly diagnostics?: DaemonDiagnosticSink;
}): Promise<ProductionDaemonApplication> {
  const factories = options.factories ?? {};
  const configPath = assertAbsoluteSafePath("--config", options.configPath);
  const config = (factories.loadConfig ?? loadConfig)({
    configPath,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const validated = validateProductionDaemonConfig(config, configPath);
  const filesystem = await validateProductionDaemonFilesystem(validated);
  // Eager, fail-closed trust anchor: a missing/malformed/ non-Ed25519 anchor must
  // stop startup before anything is served.
  const operatorVerifier = (factories.createVerifier ?? createProductionOperatorVerifier)();
  const credentials = (factories.loadCredentials ?? loadServiceAccountCredentials)(config);
  const auth = (factories.authenticate ?? createGoogleAuthClient)(credentials, [
    ANDROID_PUBLISHER_SCOPE,
  ]);
  const publisher = (factories.createPublisher ?? createAndroidPublisherClient)(auth);
  const installedVersion = readInstalledPackageVersion();
  const composition = createProductionDaemonComposition({
    config,
    validated,
    publisher,
    operatorVerifier,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(installedVersion === undefined ? {} : { packageVersion: installedVersion }),
  });
  return Object.freeze({ configPath, config, validated, filesystem, composition });
}

/**
 * Installed package version, read relative to this module — never cwd, never the
 * environment. `dist/daemon/production-composition.js` and
 * `src/daemon/production-composition.ts` are both two levels below the package
 * root, so this resolves to the installed manifest in both layouts.
 */
export function readInstalledPackageVersion(): string | undefined {
  try {
    const manifest = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export interface ProductionDaemonCompositionDeps {
  readonly config: PlayOpsConfig;
  readonly validated: ValidatedProductionDaemonConfig;
  readonly publisher: AndroidPublisherClient;
  readonly operatorVerifier: OperatorApprovalVerifier;
  readonly now?: () => Date;
  readonly diagnostics?: DaemonDiagnosticSink;
  readonly packageVersion?: string;
}

export interface ProductionDaemonComposition {
  readonly config: PlayOpsConfig;
  readonly validated: ValidatedProductionDaemonConfig;
  readonly packageName: string;
  readonly release: ReleaseComposition;
  readonly coordinator: PackageOperationCoordinator;
  readonly pendingStore: PendingOperationStore;
  readonly writeIntentStore: ReleaseWriteIntentStore;
  readonly commitAttemptJournalPath: string;
  readonly operations: DaemonOperations;
  /** Dispatcher to hand to `createDaemonServer` (wrapped by the drain tracker). */
  readonly handle: DaemonOperations["handle"];
  readonly socketPath: string;
  readonly socketMode: typeof PRODUCTION_DAEMON_SOCKET_MODE;
  readonly servedOperationCount: number;
  readonly readStatusEvidence: () => Promise<DaemonStatusEvidence>;
}

/**
 * Pure composition: builds every production dependency for the ten served
 * operations from already-constructed injectables. Performs no network work.
 */
export function createProductionDaemonComposition(
  deps: ProductionDaemonCompositionDeps,
): ProductionDaemonComposition {
  const { config, validated } = deps;
  const packageName = validated.packageName;
  const nowOption = deps.now === undefined ? {} : { now: deps.now };

  // One gateway/composition graph per daemon process. No operation-scoped tool
  // options are supplied: the daemon drives the narrow gateways, not the
  // operator-facing CLI tools.
  const release = createReleaseComposition(config, {
    publisher: deps.publisher,
    ...nowOption,
  });
  const cleanupJournal = release.cleanupJournal;
  if (cleanupJournal === undefined) {
    throw fail(
      "DAEMON_COMPOSITION_INCOMPLETE",
      "Release composition did not provide the edit cleanup journal required by verify/reconcile.",
    );
  }

  // Durable stores. Every constructor is I/O-free at construction.
  const pendingStore = createFilePendingOperationStore(validated.pendingStorePath, nowOption);
  const writeIntentStore = createFileReleaseWriteIntentStore(
    validated.writeIntentStorePath,
    nowOption,
  );
  // The daemon must never retain a stale parsed journal snapshot: each operation
  // re-opens the journal file through this bound factory.
  const openCommitAttemptJournal = (): ReturnType<typeof createFileReleaseCommitAttemptJournal> =>
    createFileReleaseCommitAttemptJournal(validated.commitAttemptJournalPath, {
      expectedPackageName: packageName,
      ...nowOption,
    });

  // Three ledger views over the configured audit log, using the existing
  // constructors and their own record discrimination.
  const ledger = createFileAgentLedger(validated.auditLogPath);
  const approvalLedger = createFileApprovalLedger(validated.auditLogPath);
  const verificationLedger = createFileVerificationLedger(validated.auditLogPath);

  // EXACTLY ONE shared package-operation coordinator for the whole process.
  const coordinator = createPackageOperationSingleFlightCoordinator();

  /**
   * Read-only status evidence. Never infers local safety state from filenames:
   * only facts a store itself exposes are reported, everything else stays
   * `unavailable` (cleanup/recovery classification needs a reviewed read of the
   * journal state machines and is deliberately not guessed here).
   */
  const readStatusEvidence = async (): Promise<DaemonStatusEvidence> => {
    let managedSessionPresent: boolean | "unavailable";
    try {
      managedSessionPresent = (await release.store.load()) !== undefined;
    } catch {
      managedSessionPresent = "unavailable";
    }
    return {
      packageVersion: deps.packageVersion ?? "unavailable",
      managedSessionPresent,
      pendingCleanup: "unavailable",
      unresolvedCommitRecovery: "unavailable",
    };
  };

  const operations = createDaemonOperations({
    packageName,
    pendingStore,
    claimRoot: validated.claimRoot,
    packageOperations: coordinator,
    registry: release.registry,
    openEdit: { binding: release.openBinding, input: {} },
    attachNotes: {
      packageName,
      managedSessionStore: release.store,
      releaseGateway: release.gateway,
      writeIntentStore,
      ledger,
      verificationLedger,
      ...nowOption,
    },
    commit: {
      packageName,
      pendingStore,
      claimRoot: validated.claimRoot,
      managedSessionStore: release.store,
      releaseGateway: release.gateway,
      writeIntentStore,
      commitAuditLedger: ledger,
      openCommitAttemptJournal,
      operatorVerifier: deps.operatorVerifier,
      ledger,
      approvalLedger,
      verificationLedger,
      ...nowOption,
    },
    verifyCommitted: {
      packageName,
      pendingStore,
      claimRoot: validated.claimRoot,
      managedSessionStore: release.store,
      summaryGateway: release.gateway,
      temporaryEditGateway: release.gateway,
      cleanupJournal,
      verifyAuditLedger: ledger,
      openCommitAttemptJournal,
      operatorVerifier: deps.operatorVerifier,
      ledger,
      approvalLedger,
      verificationLedger,
      ...nowOption,
    },
    reconcileCommit: {
      packageName,
      pendingStore,
      claimRoot: validated.claimRoot,
      managedSessionStore: release.store,
      gateway: release.gateway,
      cleanupJournal,
      openCommitAttemptJournal,
      reconcileAuditLedger: ledger,
      finalizationAuditLedger: ledger,
      operatorVerifier: deps.operatorVerifier,
      ledger,
      approvalLedger,
      verificationLedger,
      ...nowOption,
    },
    operatorVerifier: deps.operatorVerifier,
    ledger,
    approvalLedger,
    verificationLedger,
    ...nowOption,
    readStatusEvidence,
  });

  if (DAEMON_SERVED_OPERATIONS.length !== PRODUCTION_DAEMON_SERVED_OPERATION_COUNT) {
    throw fail(
      "DAEMON_COMPOSITION_INCOMPLETE",
      `The daemon must serve exactly ${String(PRODUCTION_DAEMON_SERVED_OPERATION_COUNT)} operations.`,
    );
  }

  return Object.freeze({
    config,
    validated,
    packageName,
    release,
    coordinator,
    pendingStore,
    writeIntentStore,
    commitAttemptJournalPath: validated.commitAttemptJournalPath,
    operations,
    handle: (envelope: DaemonRequestEnvelope) => operations.handle(envelope),
    socketPath: validated.socketPath,
    socketMode: PRODUCTION_DAEMON_SOCKET_MODE,
    servedOperationCount: DAEMON_SERVED_OPERATIONS.length,
    readStatusEvidence,
  });
}

/** Narrow, safe classification for startup failures. Never echoes credentials. */
export function classifyStartupFailure(cause: unknown): string {
  if (cause instanceof ProductionDaemonConfigError) return `daemon:${cause.code}`;
  if (cause instanceof ReleaseError) return "release:configuration-invalid";
  if (cause instanceof Error) return cause.name;
  return "unknown";
}

export { isAbsolute as isAbsolutePath };
