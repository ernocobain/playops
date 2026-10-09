/**
 * Operator-signed approval verification (privilege-separated operator path).
 *
 * VERIFICATION ONLY. PlayOps deliberately implements no operator private-key
 * generation and no signing: the private key stays off-host, outside the
 * automation boundary. Nothing here can produce an approval, only accept a
 * genuine one.
 *
 * The production trust anchor is a source-level constant. There is deliberately
 * no way to override it through CLI arguments, environment variables,
 * playops.yaml, request payloads, pending records, or the working directory:
 * the only exported entry point that resolves a key from disk is
 * `createProductionOperatorVerifier()`, which takes no arguments.
 */
import { createPublicKey, verify as nodeVerify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { TOOL_PERMISSION_LEVELS, type ToolPermissionLevel } from "../tools/index.js";

/** Domain separator mixed into every signed payload. Never change without a new domain. */
export const OPERATOR_APPROVAL_DOMAIN = "PLAYOPS_OPERATOR_APPROVAL_V1";

/** Canonical payload protocol version bound into the signed bytes. */
export const OPERATOR_APPROVAL_PROTOCOL_VERSION = 1;

/**
 * Production trust anchor. Root-owned, mode 0644. This constant is the only
 * production key source; it is not configurable by design.
 */
export const PRODUCTION_OPERATOR_ANCHOR_PATH = "/etc/playops/operator-approval.pub";

/** Ed25519 signatures are exactly 64 bytes; public keys are 44-byte SPKI DER. */
const ED25519_SIGNATURE_BYTES = 64;

/** Upper bound for any single payload field; larger values are rejected outright. */
const MAX_FIELD_BYTES = 512;

const REQUEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
// eslint-disable-next-line no-control-regex -- intentional: reject control characters in signed fields
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export type OperatorApprovalErrorCode =
  "INVALID_PAYLOAD" | "ANCHOR_UNREADABLE" | "ANCHOR_INVALID" | "SIGNATURE_INVALID";

export class OperatorApprovalError extends Error {
  override readonly name = "OperatorApprovalError";

  constructor(
    readonly code: OperatorApprovalErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The exact facts an operator signs. Every field is bound into the signed bytes. */
export interface OperatorApprovalPayload {
  readonly protocolVersion: number;
  readonly requestId: string;
  readonly nonce: string;
  readonly toolName: string;
  readonly permission: ToolPermissionLevel;
  readonly packageName: string;
  readonly requestDigest: string;
  readonly expiresAtUtc: string;
}

export interface OperatorApprovalVerifier {
  readonly algorithm: "ed25519";
  /** Source of the verification key, for audit records only. Never key material. */
  readonly keySource: string;
  /** Fails closed: returns false for any malformed input or invalid signature. */
  verify(payload: OperatorApprovalPayload, signatureBase64Url: string): boolean;
}

function invalid(detail: string): OperatorApprovalError {
  return new OperatorApprovalError(
    "INVALID_PAYLOAD",
    `Operator approval payload is invalid: ${detail}`,
  );
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function isPermissionLevel(value: unknown): value is ToolPermissionLevel {
  return TOOL_PERMISSION_LEVELS.some((level) => level === value);
}

function assertBoundedField(name: string, value: unknown): string {
  if (isBlank(value)) throw invalid(`${name} is required`);
  const text = value as string;
  if (CONTROL_CHARACTERS.test(text)) throw invalid(`${name} must not contain control characters`);
  if (Buffer.byteLength(text, "utf8") > MAX_FIELD_BYTES) throw invalid(`${name} is too long`);
  return text;
}

function assertCanonicalInstant(name: string, value: unknown): string {
  const text = assertBoundedField(name, value);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== text) {
    throw invalid(`${name} must be a canonical ISO-8601 UTC instant`);
  }
  return text;
}

/** Validate a payload before it is encoded or verified; throws on any deviation. */
export function assertOperatorApprovalPayload(value: unknown): OperatorApprovalPayload {
  if (typeof value !== "object" || value === null) throw invalid("expected an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.protocolVersion !== OPERATOR_APPROVAL_PROTOCOL_VERSION) {
    throw invalid("protocol version is not the supported version");
  }
  if (!isPermissionLevel(candidate.permission))
    throw invalid("permission is not a supported level");
  const requestDigest = assertBoundedField("requestDigest", candidate.requestDigest);
  if (!REQUEST_DIGEST_PATTERN.test(requestDigest)) {
    throw invalid("requestDigest must be a lowercase 64-character hex digest");
  }
  return Object.freeze({
    protocolVersion: OPERATOR_APPROVAL_PROTOCOL_VERSION,
    requestId: assertBoundedField("requestId", candidate.requestId),
    nonce: assertBoundedField("nonce", candidate.nonce),
    toolName: assertBoundedField("toolName", candidate.toolName),
    permission: candidate.permission,
    packageName: assertBoundedField("packageName", candidate.packageName),
    requestDigest,
    expiresAtUtc: assertCanonicalInstant("expiresAtUtc", candidate.expiresAtUtc),
  });
}

/**
 * Encode a payload into the canonical signed byte representation.
 *
 * Every value is length-prefixed with its UTF-8 byte count (`name=<bytes>:<value>`)
 * so that no field value can shift a field boundary, and fields appear in a fixed
 * order under the domain separator. Deterministic and byte-for-byte testable.
 */
export function encodeOperatorApprovalPayload(value: unknown): Buffer {
  const payload = assertOperatorApprovalPayload(value);
  const field = (name: string, text: string): string =>
    `${name}=${String(Buffer.byteLength(text, "utf8"))}:${text}\n`;
  const encoded =
    `${OPERATOR_APPROVAL_DOMAIN}\n` +
    `version=${String(payload.protocolVersion)}\n` +
    field("requestId", payload.requestId) +
    field("nonce", payload.nonce) +
    field("toolName", payload.toolName) +
    field("permission", payload.permission) +
    field("packageName", payload.packageName) +
    field("requestDigest", payload.requestDigest) +
    field("expiresAtUtc", payload.expiresAtUtc);
  return Buffer.from(encoded, "utf8");
}

function decodeSignature(signatureBase64Url: unknown): Buffer | undefined {
  if (isBlank(signatureBase64Url)) return undefined;
  const text = (signatureBase64Url as string).trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return undefined;
  try {
    const bytes = Buffer.from(text, "base64url");
    return bytes.length === ED25519_SIGNATURE_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function verifyWithKey(
  publicKey: KeyObject,
  payload: unknown,
  signatureBase64Url: unknown,
): boolean {
  let encoded: Buffer;
  try {
    encoded = encodeOperatorApprovalPayload(payload);
  } catch {
    return false;
  }
  const signature = decodeSignature(signatureBase64Url);
  if (!signature) return false;
  try {
    return nodeVerify(null, encoded, publicKey, signature);
  } catch {
    return false;
  }
}

/** Build a verifier around an already-resolved Ed25519 public key. */
export function createOperatorApprovalVerifier(
  publicKey: KeyObject,
  keySource: string,
): OperatorApprovalVerifier {
  if (!publicKey || publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new OperatorApprovalError(
      "ANCHOR_INVALID",
      "Operator trust anchor must be an Ed25519 public key.",
    );
  }
  return Object.freeze({
    algorithm: "ed25519" as const,
    keySource,
    verify: (payload: OperatorApprovalPayload, signatureBase64Url: string): boolean =>
      verifyWithKey(publicKey, payload, signatureBase64Url),
  });
}

/**
 * Read and resolve the pinned production anchor.
 *
 * Module-private on purpose: no caller can supply a replacement path, and the
 * resulting key can only ever come from `PRODUCTION_OPERATOR_ANCHOR_PATH`.
 */
function readPinnedProductionAnchor(): KeyObject {
  let contents: string;
  try {
    contents = readFileSync(PRODUCTION_OPERATOR_ANCHOR_PATH, "utf8");
  } catch (cause) {
    throw new OperatorApprovalError(
      "ANCHOR_UNREADABLE",
      "Operator trust anchor could not be read.",
      { cause },
    );
  }
  try {
    const key = createPublicKey(contents);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new OperatorApprovalError(
        "ANCHOR_INVALID",
        "Operator trust anchor must be an Ed25519 public key.",
      );
    }
    return key;
  } catch (cause) {
    if (cause instanceof OperatorApprovalError) throw cause;
    throw new OperatorApprovalError("ANCHOR_INVALID", "Operator trust anchor is not a valid key.", {
      cause,
    });
  }
}

/**
 * The only production entry point for signature verification.
 *
 * Takes no arguments so that no CLI flag, environment variable, configuration
 * value, request field, pending record, or working-directory file can redirect
 * the trust anchor.
 */
export function createProductionOperatorVerifier(): OperatorApprovalVerifier {
  return createOperatorApprovalVerifier(
    readPinnedProductionAnchor(),
    PRODUCTION_OPERATOR_ANCHOR_PATH,
  );
}
