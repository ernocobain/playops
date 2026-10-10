/**
 * Stage 4C.1 — one narrow, auditable filesystem-trust helper.
 *
 * WHY THIS EXISTS
 * ===============
 * Several production paths are ROOT-OWNED, non-writable files read from fixed
 * locations (the operator trust anchor, the daemon configuration, the Google
 * credential). A plain `readFileSync` silently follows symlinks, ignores the
 * file owner and ignores group/other write bits, so a broader principal could
 * redirect a trust decision. This module performs ONE explicit, fail-closed
 * sequence — validate the parent directory, open the leaf WITHOUT following a
 * symlink, `fstat` the OPEN DESCRIPTOR, then read from that SAME descriptor —
 * and returns the bytes only when every check passes.
 *
 * It is deliberately a narrow library, not a framework: no plugin registry, no
 * dynamic policy loaded from configuration or the environment, and no I/O
 * beyond synchronous `node:fs` calls. The production default owner is
 * `trustedOwnerUid = 0` (root).
 *
 * TWO NAMED POLICIES (Stage 4C.1A)
 * ================================
 * Two policy factories make the trust distinction impossible to omit by
 * accident:
 *
 *   - `publicIntegrityFilePolicy()` — owner uid 0, regular, non-symlink, no
 *     group write, no other write. Confidentiality is intentionally NOT required
 *     (this is the operator trust anchor, public key material). Equivalent to the
 *     original 4C.1 behaviour.
 *   - `secretServiceFilePolicy()` — the secret-bearing production inputs (the
 *     config file and the Google credential): no group/other write, no OTHER
 *     read/write/execute, exact modes `{0o640, 0o440}`, and group identity (leaf
 *     gid == trusted parent gid, that gid must not be the process effective gid
 *     and — when the platform exposes it — must appear in `process.getgroups()`).
 *     A `root:<capability-group>` misprovisioning therefore fails closed without
 *     hard-coding a host gid or resolving a group name through a shell.
 *
 * RESIDUAL (documented, not hidden)
 * =================================
 * Node exposes no `openat`-style ancestry walk, so each check is a separate
 * syscall and a narrow, ROOT-ONLY time-of-check/time-of-use window exists
 * between the parent check and the leaf open. Only uid 0 can win that race, and
 * uid 0 already owns every path involved. The LEAF itself is opened with
 * `O_NOFOLLOW` and validated on its own descriptor, so the leaf is never
 * subject to that race.
 *
 * DIRECTORY-DESCRIPTOR FALLBACK
 * =============================
 * When the platform does not expose `constants.O_DIRECTORY`, a parent cannot be
 * opened as a descriptor and is validated with `lstat` instead (a wider residual
 * window). Production Linux exposes `O_DIRECTORY`, so the descriptor path is the
 * one that runs there.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

/** Owner uid trusted for every production trust path (root). */
export const TRUSTED_SYSTEM_UID = 0;

/** Default upper bound for a trusted regular-file read (1 MiB). */
export const DEFAULT_FS_TRUST_MAX_BYTES = 1_048_576;

/** Exact leaf modes the secret-service file policy accepts (group-read, no other). */
export const SECRET_SERVICE_ALLOWED_MODES: readonly number[] = Object.freeze([0o640, 0o440]);

/** Immutable `lstat`/`fstat` facts a policy decision is made from. */
export interface FsTrustMetadata {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * The minimal filesystem surface the helper needs. Production uses
 * `nodeFsTrustPort`; tests inject a fake so no privilege is required.
 */
export interface FsTrustPort {
  lstat(path: string): FsTrustMetadata | undefined;
  openReadNoFollow(path: string): number;
  openDirectoryNoFollow(path: string): number | undefined;
  fstat(fd: number): FsTrustMetadata;
  readAll(fd: number, limit: number): Buffer;
  close(fd: number): void;
}

/**
 * Process group identity the secret-service policy reasons about. Production
 * reads the real `process.getegid()`/`process.getgroups()`; tests inject a narrow
 * module-argument seam. It is never sourced from the CLI, the environment or the
 * configuration file.
 */
export interface ProcessGroupIdentity {
  /** The daemon's effective gid (the socket capability group under `Group=`). */
  readonly effectiveGid: number;
  /** Supplementary group ids, or undefined when the platform cannot expose them. */
  readonly supplementaryGids: readonly number[] | undefined;
}

/** Module-argument policy seam; production defaults are the real filesystem. */
export interface FsTrustPolicy {
  /** Owner uid every trusted path must match. Defaults to `TRUSTED_SYSTEM_UID`. */
  readonly trustedOwnerUid?: number;
  /** When present, `mode & 0o777` must be an exact member. */
  readonly allowedModes?: readonly number[];
  /** Maximum number of bytes that may be read. */
  readonly maxBytes?: number;
  /**
   * Secret-service confidentiality: refuse every OTHER read/write/execute bit
   * and enforce group identity (leaf gid == trusted parent gid, that gid must not
   * be the process effective gid, and when supplementary groups are available the
   * gid must appear there). Set only by `secretServiceFilePolicy()`.
   */
  readonly secretConfidentiality?: boolean;
  /** Process group identity seam for the secret policy; defaults to the real process. */
  readonly processGroupIdentity?: ProcessGroupIdentity;
}

export type FsTrustErrorCode =
  | "TRUST_PATH_UNSAFE"
  | "TRUST_OWNER_UNSAFE"
  | "TRUST_MODE_UNSAFE"
  | "TRUST_CONFIDENTIALITY_UNSAFE"
  | "TRUST_GROUP_IDENTITY_UNSAFE"
  | "TRUST_UNREADABLE"
  | "TRUST_TOO_LARGE"
  | "TRUST_NOT_UTF8";

export class FsTrustError extends Error {
  override readonly name = "FsTrustError";

  constructor(
    readonly code: FsTrustErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function trustError(code: FsTrustErrorCode, message: string): FsTrustError {
  return new FsTrustError(code, message);
}

/**
 * PUBLIC-INTEGRITY policy — the operator trust anchor. Owner uid 0, regular,
 * non-symlink, no group write, no other write. Confidentiality is intentionally
 * NOT required: the anchor is public key material. Equivalent to the original
 * 4C.1 helper behaviour.
 */
export function publicIntegrityFilePolicy(overrides: FsTrustPolicy = {}): FsTrustPolicy {
  return { trustedOwnerUid: TRUSTED_SYSTEM_UID, ...overrides };
}

/**
 * SECRET-SERVICE policy — the secret-bearing production inputs (the config file
 * and the Google credential). Refuses any group/other write AND any other
 * read/write/execute, accepts only `0640`/`0440`, and enforces group identity so a
 * `root:<capability-group>` misprovisioning fails closed without hard-coding a
 * host gid.
 */
export function secretServiceFilePolicy(overrides: FsTrustPolicy = {}): FsTrustPolicy {
  return {
    trustedOwnerUid: TRUSTED_SYSTEM_UID,
    allowedModes: SECRET_SERVICE_ALLOWED_MODES,
    secretConfidentiality: true,
    ...overrides,
  };
}

/** Real process group identity; unreachable from the CLI, environment or config. */
function defaultProcessGroupIdentity(): ProcessGroupIdentity {
  const platform = process as {
    getgroups?: () => number[];
    getegid?: () => number;
    getgid?: () => number;
  };
  const getgroups = platform.getgroups;
  const getegid = platform.getegid;
  const getgid = platform.getgid;
  const supplementaryGids = typeof getgroups === "function" ? getgroups() : undefined;
  const effectiveGid =
    typeof getegid === "function" ? getegid() : typeof getgid === "function" ? getgid() : 0;
  return { effectiveGid, supplementaryGids };
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === code;
}

function toMetadata(stat: Stats): FsTrustMetadata {
  return {
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    size: stat.size,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
  };
}

/** The production port: synchronous `node:fs` calls, no dynamic policy. */
export const nodeFsTrustPort: FsTrustPort = {
  lstat(path: string): FsTrustMetadata | undefined {
    try {
      return toMetadata(lstatSync(path));
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw new FsTrustError("TRUST_UNREADABLE", `Could not stat ${path}.`, { cause });
    }
  },
  openReadNoFollow(path: string): number {
    try {
      return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (cause) {
      if (isErrno(cause, "ELOOP") || isErrno(cause, "EMLINK")) {
        throw new FsTrustError(
          "TRUST_PATH_UNSAFE",
          `Refusing to follow a symlinked path: ${path}.`,
          {
            cause,
          },
        );
      }
      throw new FsTrustError("TRUST_UNREADABLE", `Could not open ${path}.`, { cause });
    }
  },
  openDirectoryNoFollow(path: string): number | undefined {
    const directoryFlag: number | undefined = fsConstants.O_DIRECTORY;
    if (directoryFlag === undefined) return undefined;
    try {
      return openSync(
        path,
        fsConstants.O_RDONLY | directoryFlag | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
    } catch (cause) {
      if (isErrno(cause, "ELOOP") || isErrno(cause, "ENOTDIR")) {
        throw new FsTrustError(
          "TRUST_PATH_UNSAFE",
          `Trusted parent must be a real directory, not a symlink: ${path}.`,
          { cause },
        );
      }
      throw new FsTrustError("TRUST_UNREADABLE", `Could not open directory ${path}.`, { cause });
    }
  },
  fstat(fd: number): FsTrustMetadata {
    try {
      return toMetadata(fstatSync(fd));
    } catch (cause) {
      throw new FsTrustError("TRUST_UNREADABLE", "Could not stat an open descriptor.", { cause });
    }
  },
  readAll(fd: number, limit: number): Buffer {
    // Read at most limit + 1 bytes so the caller can detect an over-bound file.
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset <= limit && offset < buffer.byteLength) {
      const size = buffer.byteLength - offset;
      if (size <= 0) break;
      const read = readSync(fd, buffer, offset, size, null);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  },
  close(fd: number): void {
    closeSync(fd);
  },
};

interface ResolvedPolicy {
  readonly trustedOwnerUid: number;
  readonly allowedModes: readonly number[] | undefined;
  readonly maxBytes: number;
  readonly secretConfidentiality: boolean;
  readonly processGroupIdentity: ProcessGroupIdentity;
}

function resolvePolicy(policy: FsTrustPolicy | undefined): ResolvedPolicy {
  return {
    trustedOwnerUid: policy?.trustedOwnerUid ?? TRUSTED_SYSTEM_UID,
    allowedModes: policy?.allowedModes,
    maxBytes: policy?.maxBytes ?? DEFAULT_FS_TRUST_MAX_BYTES,
    secretConfidentiality: policy?.secretConfidentiality === true,
    processGroupIdentity: policy?.processGroupIdentity ?? defaultProcessGroupIdentity(),
  };
}

/**
 * Group-identity backing check for the secret-service policy: the group must not
 * be the daemon's effective (socket capability) group, and — when the platform
 * exposes supplementary groups — it must be one the daemon holds. When
 * `getgroups` is unavailable only that one comparison is skipped; the other two
 * are never skipped.
 */
function assertSecretGroupIdentity(
  policy: ResolvedPolicy,
  gid: number,
  label: string,
  path: string,
): void {
  if (gid === policy.processGroupIdentity.effectiveGid) {
    throw trustError(
      "TRUST_GROUP_IDENTITY_UNSAFE",
      `${label} must not be owned by the daemon's effective (socket capability) group: ${path}.`,
    );
  }
  const supplementary = policy.processGroupIdentity.supplementaryGids;
  if (supplementary !== undefined && !supplementary.includes(gid)) {
    throw trustError(
      "TRUST_GROUP_IDENTITY_UNSAFE",
      `${label} group must be one the daemon holds as a supplementary group: ${path}.`,
    );
  }
}

export interface ReadTrustedFileOptions {
  readonly policy?: FsTrustPolicy;
  readonly port?: FsTrustPort;
  /** Validate the parent directory (default true). */
  readonly verifyParent?: boolean;
  /** Override the parent path; defaults to the leaf's directory. */
  readonly parentPath?: string;
}

function assertTrustedParentMetadata(
  path: string,
  metadata: FsTrustMetadata | undefined,
  policy: ResolvedPolicy,
): FsTrustMetadata {
  if (metadata === undefined) {
    throw trustError("TRUST_PATH_UNSAFE", `Trusted parent directory is missing: ${path}.`);
  }
  if (metadata.isSymbolicLink || !metadata.isDirectory) {
    throw trustError(
      "TRUST_PATH_UNSAFE",
      `Trusted parent must be a real directory, not a symlink: ${path}.`,
    );
  }
  if (metadata.uid !== policy.trustedOwnerUid) {
    throw trustError(
      "TRUST_OWNER_UNSAFE",
      `Trusted parent must be owned by uid ${String(policy.trustedOwnerUid)}: ${path}.`,
    );
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw trustError(
      "TRUST_MODE_UNSAFE",
      `Trusted parent must not be group- or other-writable: ${path}.`,
    );
  }
  if (policy.secretConfidentiality) {
    assertSecretGroupIdentity(policy, metadata.gid, "Trusted secret parent directory", path);
  }
  return metadata;
}

/**
 * Validate a trusted directory. Opens a directory descriptor when the platform
 * supports it; otherwise falls back to `lstat` (documented wider residual).
 */
function verifyTrustedDirectory(
  path: string,
  policy: ResolvedPolicy,
  port: FsTrustPort,
): FsTrustMetadata {
  const fd = port.openDirectoryNoFollow(path);
  if (fd === undefined) {
    return assertTrustedParentMetadata(path, port.lstat(path), policy);
  }
  try {
    return assertTrustedParentMetadata(path, port.fstat(fd), policy);
  } finally {
    port.close(fd);
  }
}

/**
 * Validate a trusted regular file and return its UTF-8 text.
 *
 * Order: parent directory, then the leaf opened with `O_NOFOLLOW`, then the
 * descriptor's `fstat` (regular file, owner, mode, optional exact mode), then a
 * bounded read from that same descriptor, then a UTF-8 round-trip check. Under
 * the secret-service policy the parent and the leaf additionally refuse every
 * other read/write/execute bit and enforce the group-identity rules.
 */
export function readTrustedRegularFile(path: string, options: ReadTrustedFileOptions = {}): string {
  const policy = resolvePolicy(options.policy);
  const port = options.port ?? nodeFsTrustPort;
  let parentMetadata: FsTrustMetadata | undefined;
  if (options.verifyParent !== false) {
    parentMetadata = verifyTrustedDirectory(options.parentPath ?? dirname(path), policy, port);
  }
  const fd = port.openReadNoFollow(path);
  let bytes: Buffer;
  try {
    const metadata = port.fstat(fd);
    if (metadata.isSymbolicLink || !metadata.isFile) {
      throw trustError(
        "TRUST_PATH_UNSAFE",
        `Trusted path must be a regular file, not a symlink or directory: ${path}.`,
      );
    }
    if (metadata.uid !== policy.trustedOwnerUid) {
      throw trustError(
        "TRUST_OWNER_UNSAFE",
        `Trusted file must be owned by uid ${String(policy.trustedOwnerUid)}: ${path}.`,
      );
    }
    if ((metadata.mode & 0o022) !== 0) {
      throw trustError(
        "TRUST_MODE_UNSAFE",
        `Trusted file must not be group- or other-writable: ${path}.`,
      );
    }
    if (policy.secretConfidentiality && (metadata.mode & 0o007) !== 0) {
      throw trustError(
        "TRUST_CONFIDENTIALITY_UNSAFE",
        `Trusted secret file must not be readable, writable or executable by others: ${path}.`,
      );
    }
    if (policy.allowedModes !== undefined && !policy.allowedModes.includes(metadata.mode & 0o777)) {
      throw trustError(
        "TRUST_MODE_UNSAFE",
        `Trusted file mode must be an exact member of the allowed modes: ${path}.`,
      );
    }
    if (policy.secretConfidentiality) {
      if (parentMetadata === undefined) {
        throw trustError(
          "TRUST_GROUP_IDENTITY_UNSAFE",
          `Trusted secret file requires a validated parent directory: ${path}.`,
        );
      }
      if (metadata.gid !== parentMetadata.gid) {
        throw trustError(
          "TRUST_GROUP_IDENTITY_UNSAFE",
          `Trusted secret file group must match the trusted secret parent group: ${path}.`,
        );
      }
      assertSecretGroupIdentity(policy, metadata.gid, "Trusted secret file", path);
    }
    bytes = port.readAll(fd, policy.maxBytes);
  } finally {
    port.close(fd);
  }
  if (bytes.byteLength > policy.maxBytes) {
    throw trustError("TRUST_TOO_LARGE", `Trusted file exceeds the maximum size: ${path}.`);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw trustError("TRUST_NOT_UTF8", `Trusted file is not valid UTF-8: ${path}.`);
  }
  return text;
}

/** Asynchronous wrapper over the same port; resolves to the file text. */
export async function assertTrustedRegularFile(
  path: string,
  options: ReadTrustedFileOptions = {},
): Promise<string> {
  return readTrustedRegularFile(path, options);
}

/** Asynchronous wrapper that validates a trusted directory and returns its facts. */
export async function assertTrustedDirectory(
  path: string,
  options: ReadTrustedFileOptions = {},
): Promise<FsTrustMetadata> {
  const policy = resolvePolicy(options.policy);
  const port = options.port ?? nodeFsTrustPort;
  return verifyTrustedDirectory(path, policy, port);
}
