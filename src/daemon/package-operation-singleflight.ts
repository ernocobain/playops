/**
 * Stage 3E.2D — process-local per-package operation execution single flight.
 *
 * WHY THIS EXISTS (accepted Stage-3D blocker, generalized by Stage-3E.2D)
 * `commit-attempt-journal.ts` documents that its atomic rename prevents torn
 * records "not multi-process distributed races", and that CALLERS must
 * serialize operations. Its `prepare()` is therefore check-then-act: two
 * interleaved approved attempts can both pass its guard and both reach the
 * single commit transport (proved empirically in Stage 3D:
 * `fulfilled=2`, journal left with 1 record, the loser's stale snapshot silently
 * destroying the winner's durable attempt).
 *
 * The Stage-3E.2C audit then proved the same class of check-then-act TOCTOU
 * across DIFFERENT operations that share one Google Play edit lifecycle:
 * `execute_open_edit`, `attach_notes` and `execute_commit` all read the managed
 * session / write-intent / commit journal and only afterwards mutate remotely,
 * with no primitive shared between them. Two approved `execute_open_edit`
 * requests could therefore both observe "no managed session" and both call
 * `edits.insert`; `attach_notes` could acquire its write-intent gate AFTER
 * `execute_commit` had already rechecked that gate and still reach
 * `tracks.update` while the commit was validating/committing.
 *
 * This module is the single missing primitive: an in-process, per-PACKAGE,
 * fail-fast exclusive lease shared by every daemon operation whose remote effect
 * can mutate or invalidate the package's Google Play edit lifecycle.
 *
 * Members of the exclusion domain (one shared instance for all of them):
 *   - `execute_open_edit`        (edits.insert + managed-session durability)
 *   - `attach_notes`             (tracks.update + write-intent lifecycle)
 *   - `execute_commit`           (edits.commit + commit-attempt journal)
 * and the future, not-yet-implemented:
 *   - `execute_verify_committed` (destructive temporary edit + evidence journal)
 *   - `execute_reconcile_commit` (temporary edit + commit-attempt journal)
 *
 * WHY THE KEY IS THE WHOLE PACKAGE (never editId, requestId or global)
 * The durable authorities these operations share are package-wide, not
 * edit-scoped: the commit-attempt journal rejects ANY unresolved record for the
 * package, the write-intent gate is only per-(package, edit), Google allows one
 * active edit per application and API user, and a new `edits.insert` invalidates
 * any other open edit for that application. An edit-scoped mutex is therefore
 * unsound: two edit keys, or two operations holding different artifacts, can
 * mutate the same package lifecycle concurrently. Different packages may proceed
 * independently.
 *
 * WHY THE LEASE IS NOT DURABLE
 * Crash/restart safety stays with the operation-specific durable authority, so
 * there is exactly ONE durable recovery lifecycle per operation and no second
 * orphan-lock problem:
 *   - open_edit: the managed-session store and exact-ID cleanup journal
 *   - attach_notes: the release write-intent store
 *   - commit: the commit-attempt journal
 *   - verify (future): the verification cleanup journal plus the commit
 *     verification evidence bridge
 * Adding a durable package lock here would create a second recovery lifecycle
 * the daemon cannot reconcile.
 *
 * CRASH / RESTART PROOF — the lease is intentionally NOT durable
 *   A. Dies BEFORE the operation's own durable marker
 *      -> no durable operation evidence exists and the production tools require
 *         that evidence before their transport (source-order tests pin the
 *         journal prepare / write-intent barrier before the remote call), so no
 *         remote mutation can have started and a new process may freely acquire
 *         a fresh lease.
 *   B. Dies AFTER a durable marker
 *      -> the operation-specific durable record survives as unresolved and the
 *         corresponding recheck (commit journal, write-intent gate, managed
 *         session) must block the next attempt for ANY edit before transport.
 * Restart safety therefore comes from those stores, never from this memory.
 *
 * SINGLE-DAEMON PRODUCTION INVARIANT
 * Exactly one `playopsd` instance may own the live Google credential and the
 * production state directory; all live mutating execution enters through it and
 * there is no direct live CLI execution path. Stage 6 systemd packaging must
 * enforce a single non-template unit and single production socket ownership.
 * This coordinator relies on that invariant: it excludes concurrency INSIDE the
 * one owning process. That daemon MUST share ONE coordinator instance across all
 * operations above; constructing a coordinator per request, per operation type,
 * per socket or inside an execute handler reintroduces the audited race.
 *
 * THREAT MODEL BOUNDARY
 * This does NOT claim safety against two independent privileged daemon processes
 * started by root against the same state directory. Root/admin is outside the
 * PlayOps operator isolation boundary. The modelled adversary is unprivileged
 * automation that controls the client user `me` but neither root nor the
 * `playops` service process.
 *
 * NO QUEUE, NO TIMER, NO EXPIRY, NO STALE-PID RECOVERY
 * Acquisition is non-blocking and fail-fast: a competing same-package request
 * learns the `PACKAGE_OPERATION_IN_PROGRESS` verdict immediately and performs no
 * remote mutation, no claim and no approval consumption of its own. Nothing
 * waits, nothing expires, nothing is stolen.
 *
 * FUTURE CALLER ORDERING CONTRACT — COMMIT
 * See `PLAYOPS_COMMIT_EXECUTION_ORDER`. The authoritative journal precondition
 * must be re-checked WHILE the lease is held; reading the journal before
 * acquisition and trusting that stale result is forbidden. The lease is held
 * across the ENTIRE approved commit execution — journal check, request claim /
 * approval lifecycle, journal prepare, validation, TRANSPORT_ATTEMPTED, the
 * commit transport, ACK/AMBIGUOUS recording and daemon pending settlement —
 * released only at request completion, not when `edits.commit` returns.
 * ACKNOWLEDGED and AMBIGUOUS remain unresolved durable package-wide blockers
 * after the process-local lease is released.
 *
 * FUTURE CALLER ORDERING CONTRACT — OPEN EDIT
 *   protocol/request/signature prechecks
 *   -> acquire package lease
 *   -> authoritative "no managed session" recheck while holding the lease
 *   -> claim / approval lifecycle
 *   -> production open tool: edits.insert
 *   -> durable managed-session save
 *   -> pending settlement
 *   -> release package lease
 *
 * FUTURE CALLER ORDERING CONTRACT — ATTACH NOTES
 *   protocol/local input validation
 *   -> acquire package lease
 *   -> managed-session load/recheck
 *   -> trusted target derivation
 *   -> write-intent gate acquisition
 *   -> post-acquisition drift check
 *   -> production attach tool (durable TRANSPORT_ATTEMPTED barrier, then one
 *      tracks.update) + read-back settlement
 *   -> release write intent where legal
 *   -> daemon response settlement
 *   -> release package lease
 * The package lease MUST be acquired BEFORE the write-intent gate; acquiring it
 * afterwards leaves the audited attach-vs-commit window open.
 *
 * FUTURE CALLER ORDERING CONTRACT — VERIFY COMMITTED (not implemented)
 * `execute_verify_committed` MUST acquire this same package coordinator BEFORE
 * its commit-journal correlation/recheck, its managed-session absence check, its
 * destructive temporary-edit insertion, its verification-evidence bridge writes
 * and its pending settlement, and MUST hold it until all of those complete.
 *
 * FUTURE CALLER ORDERING CONTRACT — RECONCILE COMMIT (not implemented)
 * `execute_reconcile_commit` MUST acquire this same package coordinator BEFORE
 * any original-edit probe, temporary-edit insert/delete and commit-attempt
 * journal recovery activity, and MUST hold it through reconciliation settlement.
 *
 * PREPARE OPERATIONS DO NOT ACQUIRE THE LEASE
 * `prepare_open_edit`, `prepare_commit` and the future
 * `prepare_verify_committed` / `prepare_reconcile_commit` are preparation /
 * read-only: they take no package lease, and the matching execute path must
 * revalidate every authoritative input while holding it.
 *
 * ONE AUTHORIZED EXCEPTION (Stage 3E.3): continuing an already-durable
 * verification-evidence prefix from `prepare_verify_committed` mutates the
 * commit-attempt journal, so that single step acquires this coordinator first
 * and releases it immediately. It performs zero Google operations and never
 * creates an approval challenge; every other preparation path stays lease-free.
 *
 * This module is pure in-process logic: no filesystem, no clock, no timer, no
 * network, no durable artifact.
 */

/** Fail-fast outcome code for a second operation against a held package. */
export const PACKAGE_OPERATION_BUSY_CODE = "PACKAGE_OPERATION_IN_PROGRESS" as const;

/** Opaque lease marker; ownership is proved by object identity, not this field. */
export const PACKAGE_OPERATION_LEASE_KIND = "playops.package-operation-lease" as const;

export type PackageOperationAcquisition =
  | { readonly acquired: true; readonly lease: PackageExecutionLease }
  | { readonly acquired: false; readonly code: typeof PACKAGE_OPERATION_BUSY_CODE };

export type PackageOperationRelease =
  | { readonly released: true }
  | { readonly released: false; readonly code: "LEASE_NOT_HELD" | "LEASE_NOT_OWNER" };

/**
 * Opaque process-local lease handle. It carries no scope, key, path, token or
 * timer: ownership is proved by object identity against this coordinator.
 */
export interface PackageExecutionLease {
  readonly kind: typeof PACKAGE_OPERATION_LEASE_KIND;
}

export interface PackageOperationCoordinator {
  /** Non-blocking acquisition. Never queues behind the current holder. */
  tryAcquirePackageOperation(packageName: string): PackageOperationAcquisition;
  /** Only the current holder's own lease object may release. Idempotent-safe. */
  releasePackageOperation(lease: PackageExecutionLease): PackageOperationRelease;
  /** Read-only diagnostics; performs no acquisition. */
  isPackageOperationHeld(packageName: string): boolean;
  /** Number of packages currently leased. Diagnostics only. */
  heldPackageOperationCount(): number;
}

export type PackageOperationSingleFlightErrorCode = "SINGLEFLIGHT_SCOPE_INVALID";

export class PackageOperationSingleFlightError extends Error {
  override readonly name = "PackageOperationSingleFlightError";

  constructor(
    readonly code: PackageOperationSingleFlightErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The pinned commit execution ordering contract. Exporting it as data lets a
 * test fail loudly if anyone reorders these steps in the commit path. The other
 * operations have their own documented orders above; every one of them begins by
 * acquiring the same package lease and ends by releasing it.
 */
export const PLAYOPS_COMMIT_EXECUTION_ORDER: readonly string[] = Object.freeze([
  "execute_commit_safe_prechecks",
  "acquire_per_package_singleflight",
  "recheck_package_commit_journal_while_holding_lease",
  "request_claim_and_approval_lifecycle",
  "existing_production_commit_tool",
  "journal_prepare",
  "journal_transport_attempted",
  "edits_commit_at_most_once",
  "settle_daemon_pending_lifecycle",
  "release_package_operation",
]);

const MAX_SCOPE_CHARS = 256;

/** Reject control characters and absurd lengths in trusted scope inputs. */
function assertScopePart(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new PackageOperationSingleFlightError(
      "SINGLEFLIGHT_SCOPE_INVALID",
      `The trusted ${label} is invalid.`,
    );
  }
  if (value.length > MAX_SCOPE_CHARS) {
    throw new PackageOperationSingleFlightError(
      "SINGLEFLIGHT_SCOPE_INVALID",
      `The trusted ${label} is too long.`,
    );
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new PackageOperationSingleFlightError(
        "SINGLEFLIGHT_SCOPE_INVALID",
        `The trusted ${label} contains control characters.`,
      );
    }
  }
  return value;
}

export function createPackageOperationSingleFlightCoordinator(): PackageOperationCoordinator {
  /** Trusted package name -> its one active lease. No edit, client scope or path. */
  const held = new Map<string, PackageExecutionLease>();
  /** lease -> its package key, so release cannot target another package's entry. */
  const leaseScopes = new WeakMap<PackageExecutionLease, string>();

  const tryAcquirePackageOperation = (packageName: string): PackageOperationAcquisition => {
    // Exact trusted package name is the entire exclusion key. Memory only;
    // never exposed, accepted as a client-supplied key, or written to disk.
    const key = assertScopePart(packageName, "package name");
    // Fail fast: no queue, no await, no timer. A second caller learns `busy`
    // immediately rather than discovering it after a hidden wait.
    if (held.has(key)) {
      return Object.freeze({ acquired: false, code: PACKAGE_OPERATION_BUSY_CODE });
    }
    const lease: PackageExecutionLease = Object.freeze({
      kind: PACKAGE_OPERATION_LEASE_KIND,
    });
    held.set(key, lease);
    leaseScopes.set(lease, key);
    return Object.freeze({ acquired: true, lease });
  };

  const releasePackageOperation = (lease: PackageExecutionLease): PackageOperationRelease => {
    if (typeof lease !== "object" || lease === null) {
      return Object.freeze({ released: false, code: "LEASE_NOT_OWNER" });
    }
    const key = leaseScopes.get(lease);
    // Not issued by THIS coordinator instance (forged handle, or a handle from a
    // previous process after restart): never touches any package's entry.
    if (key === undefined) {
      return Object.freeze({ released: false, code: "LEASE_NOT_OWNER" });
    }
    const current = held.get(key);
    // Already released, or never actually held.
    if (current === undefined) {
      return Object.freeze({ released: false, code: "LEASE_NOT_HELD" });
    }
    // The key is now held by someone else: this stale handle must not free it.
    if (current !== lease) {
      return Object.freeze({ released: false, code: "LEASE_NOT_OWNER" });
    }
    held.delete(key);
    return Object.freeze({ released: true });
  };

  const isPackageOperationHeld = (packageName: string): boolean =>
    held.has(assertScopePart(packageName, "package name"));

  const heldPackageOperationCount = (): number => held.size;

  return Object.freeze({
    tryAcquirePackageOperation,
    releasePackageOperation,
    isPackageOperationHeld,
    heldPackageOperationCount,
  });
}
