/**
 * Operator client approval handling: local challenge validation, signer export,
 * safe challenge-file I/O and strict signature-token parsing.
 *
 * This module performs NO signing and holds NO private key. It loads no
 * credential, no daemon state and no `/etc/playops` anchor. It reuses the pure
 * `assertApprovalChallenge` validator from `../approvals/challenge.js` rather
 * than re-implementing the signed-payload / statement checks.
 *
 * The challenge file is an opaque, one-time approval reference. It does NOT
 * authenticate the daemon's origin: there is no daemon MAC over the challenge,
 * so a copy of the file proves only internal consistency. Integrity is
 * re-established by revalidation, never by trusting the file.
 */
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { assertApprovalChallenge, decodeApprovalPayload } from "../approvals/challenge.js";
import { approvalStatementDigest } from "../approvals/statement.js";
import {
  MAX_RESPONSE_BYTES,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  type DaemonApprovalChallenge,
} from "../daemon/protocol.js";

/** Export envelope version for the off-host signer. */
export const CLIENT_EXPORT_VERSION = 1;
/** Ed25519 signatures are exactly 64 bytes. */
export const SIGNATURE_BYTE_LENGTH = 64;
/** Allows a full bounded wire challenge plus its export wrapper/pretty whitespace. */
export const MAX_CHALLENGE_FILE_BYTES = 2 * MAX_RESPONSE_BYTES;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export type ClientApprovalErrorCode =
  | "challenge_invalid"
  | "export_exists"
  | "export_path_insecure"
  | "export_unwritable"
  | "challenge_unreadable"
  | "challenge_too_large"
  | "challenge_mismatch"
  | "signature_invalid";

export class ClientApprovalError extends Error {
  override readonly name = "ClientApprovalError";

  constructor(
    readonly code: ClientApprovalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Client-local wrapper around the pure daemon validator. MUST run before any
 * display or export so a malformed daemon challenge never reaches the operator.
 */
export function validateApprovalChallenge(value: unknown): DaemonApprovalChallenge {
  try {
    assertApprovalChallenge(value);
  } catch (cause) {
    throw new ClientApprovalError(
      "challenge_invalid",
      "The daemon approval challenge failed validation.",
      { cause },
    );
  }
  return value as DaemonApprovalChallenge;
}

/** Non-authoritative, echoed operator command input. Never treated as authority. */
export interface ClientApprovalExportOperator {
  readonly track?: string;
  readonly versionCode?: string;
  readonly locale?: string;
  readonly requestId?: string;
}

/**
 * The exact object handed to the off-host signer. The `challenge` is the
 * verbatim `DaemonApprovalChallenge`; `approvalStatementCanonical`,
 * `canonicalPayload`, `requestDigest`, `requestId`, `expiresAtUtc`, `toolName`,
 * `permission` and `packageName` are preserved byte-exact.
 */
export interface ClientApprovalExport {
  readonly clientExportVersion: typeof CLIENT_EXPORT_VERSION;
  readonly daemonProtocolVersion: number;
  readonly challenge: DaemonApprovalChallenge;
  readonly operator?: ClientApprovalExportOperator;
}

export function createApprovalExport(
  challenge: DaemonApprovalChallenge,
  operator?: ClientApprovalExportOperator,
): ClientApprovalExport {
  const validated = validateApprovalChallenge(challenge);
  return Object.freeze({
    clientExportVersion: CLIENT_EXPORT_VERSION,
    daemonProtocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    challenge: validated,
    ...(operator === undefined ? {} : { operator: Object.freeze({ ...operator }) }),
  });
}

export function serializeApprovalExport(exported: ClientApprovalExport): string {
  return `${JSON.stringify(exported, null, 2)}\n`;
}

/**
 * Create the challenge file exclusively at mode 0600. Refuses to overwrite an
 * existing file and refuses a symbolic-link target. Fails closed: a partial
 * write is removed rather than left behind.
 */
export function writeChallengeFile(path: string, contents: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    if (code === "EEXIST") {
      throw new ClientApprovalError(
        "export_exists",
        "Refusing to overwrite an existing challenge file.",
        { cause },
      );
    }
    if (code === "ELOOP" || code === "EMLINK") {
      throw new ClientApprovalError(
        "export_path_insecure",
        "Refusing to write a challenge through a symbolic link.",
        { cause },
      );
    }
    throw new ClientApprovalError(
      "export_unwritable",
      "The challenge file could not be created safely.",
      { cause },
    );
  }
  try {
    // umask may have stripped bits from the open mode: force 0600 explicitly.
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new Error("Challenge write made no progress.");
      offset += written;
    }
    closeSync(fd);
  } catch (cause) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(path);
    } catch {
      /* best effort */
    }
    throw new ClientApprovalError(
      "export_unwritable",
      "The challenge file could not be written safely.",
      { cause },
    );
  }
}

/**
 * Read a challenge file (size-capped, validated). Accepts either a bare
 * `DaemonApprovalChallenge` or a `ClientApprovalExport` wrapper. The content is
 * never trusted for integrity — the caller must still revalidate against the
 * daemon's own pending record.
 */
export function readChallengeFile(path: string): DaemonApprovalChallenge {
  let text: string;
  let fd: number | undefined;
  try {
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
      throw new ClientApprovalError(
        "challenge_unreadable",
        "Safe no-follow file reads are unavailable.",
      );
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new ClientApprovalError(
        "challenge_invalid",
        "The challenge path is not a regular file.",
      );
    }
    if (stat.size > MAX_CHALLENGE_FILE_BYTES) {
      throw new ClientApprovalError(
        "challenge_too_large",
        "The challenge file exceeds the client size bound.",
      );
    }
    // Read from the validated descriptor; cap actual bytes even if the file grows.
    const bytes = Buffer.allocUnsafe(MAX_CHALLENGE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_CHALLENGE_FILE_BYTES)
      throw new ClientApprovalError(
        "challenge_too_large",
        "The challenge file exceeds the client size bound.",
      );
    const contents = bytes.subarray(0, offset);
    text = contents.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(contents))
      throw new ClientApprovalError("challenge_invalid", "The challenge file is not valid UTF-8.");
  } catch (cause) {
    if (cause instanceof ClientApprovalError) throw cause;
    throw new ClientApprovalError("challenge_unreadable", "The challenge file could not be read.", {
      cause,
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ClientApprovalError("challenge_invalid", "The challenge file is not valid JSON.", {
      cause,
    });
  }
  let candidate = parsed;
  if (typeof parsed === "object" && parsed !== null && "challenge" in parsed) {
    const wrapper = parsed as Record<string, unknown>;
    if (
      wrapper.clientExportVersion !== CLIENT_EXPORT_VERSION ||
      wrapper.daemonProtocolVersion !== PLAYOPS_DAEMON_PROTOCOL_VERSION ||
      Object.keys(wrapper).some(
        (key) =>
          !["clientExportVersion", "daemonProtocolVersion", "challenge", "operator"].includes(key),
      )
    ) {
      throw new ClientApprovalError(
        "challenge_invalid",
        "Unsupported or invalid client export wrapper.",
      );
    }
    candidate = wrapper.challenge;
  }
  return validateApprovalChallenge(candidate);
}

/**
 * Parse one operator signature token: trim surrounding whitespace only, require
 * base64url with no padding (`^[A-Za-z0-9_-]+$`) and a decoded length of exactly
 * 64 bytes. Returns the trimmed token.
 */
export function parseSignatureToken(text: string): string {
  const token = text.trim();
  if (token.length === 0) {
    throw new ClientApprovalError("signature_invalid", "The operator signature is empty.");
  }
  if (!BASE64URL_PATTERN.test(token)) {
    throw new ClientApprovalError(
      "signature_invalid",
      "The operator signature is not unpadded base64url.",
    );
  }
  const bytes = Buffer.from(token, "base64url");
  if (bytes.byteLength !== SIGNATURE_BYTE_LENGTH) {
    throw new ClientApprovalError(
      "signature_invalid",
      `The operator signature must decode to exactly ${String(SIGNATURE_BYTE_LENGTH)} bytes.`,
    );
  }
  return token;
}

/**
 * Cross-check an operator-supplied challenge file against `--request-id` before
 * connecting. Recomputes the statement digest and re-decodes the signed payload.
 * This only revalidates internal consistency and prevents operator/requestId
 * mismatch; it never authenticates daemon origin.
 */
export function crossCheckChallenge(
  challenge: DaemonApprovalChallenge,
  expected: { readonly requestId: string },
): void {
  const validated = validateApprovalChallenge(challenge);
  if (validated.requestId !== expected.requestId) {
    throw new ClientApprovalError(
      "challenge_mismatch",
      "The challenge requestId does not match --request-id.",
    );
  }
  if (approvalStatementDigest(validated.approvalStatementCanonical) !== validated.requestDigest) {
    throw new ClientApprovalError(
      "challenge_mismatch",
      "The challenge statement digest does not match its own statement.",
    );
  }
  decodeApprovalPayload(validated.canonicalPayload);
}
