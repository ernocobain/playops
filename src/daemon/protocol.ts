/**
 * Typed local daemon protocol (privilege-separated operator path).
 *
 * Closed-world, versioned, semantic. This is NOT a generic RPC executor: the
 * client can only name one of a fixed set of operator intents, and the server
 * owns every internal identity (edit id, digests, expiry, package, tool).
 *
 * Parsing is explicit and fail-closed. TypeScript types are documentation only;
 * every field is validated at runtime, unknown keys are rejected rather than
 * dropped, and no coercion is performed (a number is never accepted where a
 * string is required).
 *
 * Known limitation: after `JSON.parse` duplicate JSON object keys are not
 * detectable (last value wins). Strict key-set enforcement plus explicit scalar
 * validation is the control; duplicate-key rejection would require a streaming
 * JSON parser and is deliberately out of scope.
 */
import type { ToolPermissionLevel } from "../runtime/tools/index.js";

/**
 * Wire protocol version.
 *
 * Bumped 1 -> 2 because `DaemonResponseOutcome` is a closed response union whose
 * semantic vocabulary changed: a recognized-but-unserved operation and an absent
 * pending request are now distinguishable instead of being overloaded onto
 * `config_invalid`.
 *
 * Bumped 2 -> 3 for the same reason: `local_state_failure` was added so that a
 * daemon-local durable-state persistence failure (mutation provably not started)
 * is no longer conflated with a genuine `approval_mismatch`.
 *
 * Bumped 3 -> 4 because the `attach_notes` request gains a semantic target
 * (`versionCode`) and the closed response vocabulary gains `operation_in_progress`.
 *
 * There is no deployed production client or server, so no migration is required
 * and older versions fail closed through the existing unsupported-version path.
 * No compatibility fallback exists.
 *
 * Deliberately independent of `PENDING_RECORD_SCHEMA_VERSION` and of
 * `RELEASE_WRITE_INTENT_SCHEMA_VERSION`: the wire contract, the signed
 * approval-record contract and the release write-intent contract are three
 * separate version domains, and none is derived from another.
 */
export const PLAYOPS_DAEMON_PROTOCOL_VERSION = 4;

/** Maximum serialized request size accepted by the daemon, in bytes. */
export const MAX_REQUEST_BYTES = 64 * 1024;
/** Maximum serialized response size the daemon will produce, in bytes. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Maximum request id length (server-generated UUIDs are 36 characters). */
export const MAX_REQUEST_ID_CHARS = 128;
/** Maximum operator-supplied release-note text, in UTF-8 bytes.
 *  This is TRANSPORT PROTECTION ONLY, not a Google semantic limit. */
export const MAX_NOTE_TEXT_BYTES = 4000;
/** Maximum base64url signature length (an Ed25519 signature is 64 bytes / 86 chars). */
export const MAX_SIGNATURE_CHARS = 128;
/** Maximum correlation id length. */
export const MAX_CORRELATION_ID_CHARS = 128;
const MAX_TRACK_CHARS = 64;
const MAX_LOCALE_CHARS = 35;
const MAX_VERSION_CODE_CHARS = 20;
/** Bound on the canonical signed payload echoed to the operator. */
const MAX_CANONICAL_PAYLOAD_BYTES = 2048;
const MAX_SUMMARY_CHARS = 2000;
const MAX_ERROR_MESSAGE_CHARS = 400;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TRACK_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const VERSION_CODE_PATTERN = /^[0-9]{1,20}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
// eslint-disable-next-line no-control-regex -- intentional: reject control characters in protocol strings
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export type ProtocolErrorCode =
  | "MALFORMED_REQUEST"
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "UNKNOWN_OPERATION"
  | "UNKNOWN_FIELD"
  | "FORBIDDEN_FIELD"
  | "INVALID_FIELD"
  | "REQUEST_TOO_LARGE"
  | "RESPONSE_TOO_LARGE"
  | "FRAME_INCOMPLETE";

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";

  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function malformed(detail: string): ProtocolError {
  return new ProtocolError("MALFORMED_REQUEST", `Daemon request is invalid: ${detail}`);
}

function invalid(detail: string): ProtocolError {
  return new ProtocolError("INVALID_FIELD", `Daemon request field is invalid: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fields the client must never supply. They are server-owned and are rejected
 * anywhere in the request, not merely at the top level.
 */
export const FORBIDDEN_CLIENT_FIELDS: readonly string[] = Object.freeze([
  "tool",
  "toolName",
  "method",
  "googleMethod",
  "endpoint",
  "module",
  "moduleName",
  "command",
  "shell",
  "path",
  "file",
  "textFile",
  "filename",
  "editId",
  "stateDigest",
  "requestDigest",
  "priorStateDigest",
  "verificationEditId",
  "validationExpiryTimeSeconds",
  "intent",
  "nonce",
  "expiresAt",
  "expiresAtUtc",
  "package",
  "packageName",
  "credentials",
  "token",
  "privateKey",
  "private_key",
  // Release-targeting objects. The client names a semantic versionCode instead;
  // the server derives every Google resource itself.
  "configuredRelease",
  "uploadedBundle",
  "bundle",
  "bundleSha256",
  "release",
]);

function assertNoForbiddenFields(value: unknown, trail = "request"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoForbiddenFields(item, `${trail}[${String(index)}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CLIENT_FIELDS.includes(key)) {
      throw new ProtocolError(
        "FORBIDDEN_FIELD",
        `Daemon request must not carry server-owned field "${key}" (at ${trail}).`,
      );
    }
    assertNoForbiddenFields(nested, `${trail}.${key}`);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ProtocolError("UNKNOWN_FIELD", `Unknown daemon request field "${key}".`);
    }
  }
}

/** Reject anything that is not already a plain JSON string. No coercion. */
function readString(value: unknown, field: string, maxChars: number, pattern?: RegExp): string {
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  if (value.length === 0) throw invalid(`${field} must not be empty`);
  if (CONTROL_CHARACTERS.test(value)) throw invalid(`${field} must not contain control characters`);
  if (value.length > maxChars) throw invalid(`${field} exceeds ${String(maxChars)} characters`);
  if (pattern && !pattern.test(value)) throw invalid(`${field} does not match the expected format`);
  return value;
}

export type DaemonRequestKind =
  | "status"
  | "prepare_open_edit"
  | "execute_open_edit"
  | "attach_notes"
  | "prepare_commit"
  | "execute_commit"
  | "prepare_verify_committed"
  | "execute_verify_committed"
  | "prepare_reconcile_commit"
  | "execute_reconcile_commit";

export const DAEMON_REQUEST_KINDS: readonly DaemonRequestKind[] = Object.freeze([
  "status",
  "prepare_open_edit",
  "execute_open_edit",
  "attach_notes",
  "prepare_commit",
  "execute_commit",
  "prepare_verify_committed",
  "execute_verify_committed",
  "prepare_reconcile_commit",
  "execute_reconcile_commit",
]);

export interface PrepareOpenEditRequest {
  readonly kind: "prepare_open_edit";
}
export interface ExecuteSignedRequest {
  readonly kind:
    | "execute_open_edit"
    | "execute_commit"
    | "execute_verify_committed"
    | "execute_reconcile_commit";
  readonly requestId: string;
  readonly signature: string;
}
export interface AttachNotesRequest {
  readonly kind: "attach_notes";
  readonly track: string;
  /** Semantic operator intent: which release on the track receives the note. */
  readonly versionCode: string;
  readonly locale: string;
  readonly noteText: string;
}
export interface PrepareTrackScopedRequest {
  readonly kind: "prepare_commit" | "prepare_verify_committed";
  readonly track: string;
  readonly versionCode: string;
}
export interface StatusRequest {
  readonly kind: "status";
}
export interface PrepareReconcileCommitRequest {
  readonly kind: "prepare_reconcile_commit";
}

export type DaemonRequest =
  | StatusRequest
  | PrepareOpenEditRequest
  | ExecuteSignedRequest
  | AttachNotesRequest
  | PrepareTrackScopedRequest
  | PrepareReconcileCommitRequest;

export interface DaemonRequestEnvelope {
  readonly protocolVersion: number;
  /** Client-side correlation only. Never the server-owned pending requestId. */
  readonly correlationId: string;
  readonly request: DaemonRequest;
}

function parseRequest(request: unknown): DaemonRequest {
  if (!isRecord(request)) throw malformed("request must be an object");
  const requestKind = request.kind;
  if (
    typeof requestKind !== "string" ||
    !DAEMON_REQUEST_KINDS.includes(requestKind as DaemonRequestKind)
  ) {
    throw new ProtocolError("UNKNOWN_OPERATION", "Daemon request names an unknown operation.");
  }
  const kind: DaemonRequestKind = requestKind as DaemonRequestKind;
  switch (kind) {
    case "status":
      exactKeys(request, ["kind"]);
      return Object.freeze({ kind: "status" });
    case "prepare_open_edit":
      exactKeys(request, ["kind"]);
      return Object.freeze({ kind: "prepare_open_edit" });
    case "prepare_reconcile_commit":
      exactKeys(request, ["kind"]);
      return Object.freeze({ kind: "prepare_reconcile_commit" });
    case "execute_open_edit":
    case "execute_commit":
    case "execute_verify_committed":
    case "execute_reconcile_commit": {
      exactKeys(request, ["kind", "requestId", "signature"]);
      return Object.freeze({
        kind,
        requestId: readString(
          request.requestId,
          "requestId",
          MAX_REQUEST_ID_CHARS,
          REQUEST_ID_PATTERN,
        ),
        signature: readString(
          request.signature,
          "signature",
          MAX_SIGNATURE_CHARS,
          BASE64URL_PATTERN,
        ),
      });
    }
    case "attach_notes": {
      exactKeys(request, ["kind", "track", "versionCode", "locale", "noteText"]);
      const noteText = readString(request.noteText, "noteText", MAX_NOTE_TEXT_BYTES);
      if (Buffer.byteLength(noteText, "utf8") > MAX_NOTE_TEXT_BYTES) {
        throw invalid(`noteText exceeds ${String(MAX_NOTE_TEXT_BYTES)} UTF-8 bytes`);
      }
      return Object.freeze({
        kind: "attach_notes",
        track: readString(request.track, "track", MAX_TRACK_CHARS, TRACK_PATTERN),
        // Semantic target, validated with the same canonical versionCode rule the
        // other release operations already use. It selects a release; it is never
        // converted into a Google resource object by the client.
        versionCode: readString(
          request.versionCode,
          "versionCode",
          MAX_VERSION_CODE_CHARS,
          VERSION_CODE_PATTERN,
        ),
        locale: readString(request.locale, "locale", MAX_LOCALE_CHARS, LOCALE_PATTERN),
        noteText,
      });
    }
    case "prepare_commit":
    case "prepare_verify_committed": {
      exactKeys(request, ["kind", "track", "versionCode"]);
      return Object.freeze({
        kind,
        track: readString(request.track, "track", MAX_TRACK_CHARS, TRACK_PATTERN),
        versionCode: readString(
          request.versionCode,
          "versionCode",
          MAX_VERSION_CODE_CHARS,
          VERSION_CODE_PATTERN,
        ),
      });
    }
    default:
      throw new ProtocolError("UNKNOWN_OPERATION", "Daemon request names an unknown operation.");
  }
}

/** Parse untrusted input into a validated envelope. Throws on any deviation. */
export function parseDaemonRequest(value: unknown): DaemonRequestEnvelope {
  assertNoForbiddenFields(value);
  if (!isRecord(value)) throw malformed("envelope must be an object");
  exactKeys(value, ["protocolVersion", "correlationId", "request"]);
  if (value.protocolVersion !== PLAYOPS_DAEMON_PROTOCOL_VERSION) {
    throw new ProtocolError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      "Daemon protocol version is not supported.",
    );
  }
  return Object.freeze({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: readString(
      value.correlationId,
      "correlationId",
      MAX_CORRELATION_ID_CHARS,
      BASE64URL_PATTERN,
    ),
    request: parseRequest(value.request),
  });
}

/**
 * Closed response vocabulary. Every materially different result keeps its own
 * member; none of these may be collapsed into another.
 *
 * `operation_unavailable` and `request_not_found` are NOT overloadings of
 * `config_invalid`, `capability_blocked` or `protocol_error` — see their
 * individual documentation below.
 */
export type DaemonResponseOutcome =
  | "status"
  | "approval_required"
  | "success"
  | "approval_mismatch"
  /**
   * Required daemon-local state validation or durable persistence failed and the
   * operation failed closed. Runtime evidence proves the external mutation did
   * NOT begin, so there is no remote ambiguity.
   *
   * Example: the `CLAIMED -> CONSUMED` transition could not be persisted before
   * the resolver would have returned an approved grant.
   *
   * NOT for: a human signature mismatch, wrong digest/package/tool binding
   * (`approval_mismatch`), a definite remote API failure (`remote_failure`), a
   * possible external mutation (`external_state_ambiguous` /
   * `cleanup_pending`), or invalid daemon configuration (`config_invalid`).
   */
  | "local_state_failure"
  | "approval_expired"
  /**
   * The execute request carried a syntactically valid canonical request id and
   * the server-owned pending store has no matching request. No mutation occurred.
   *
   * NOT for: a malformed request id (protocol validation error), an expired
   * request (`approval_expired`), a consumed request
   * (`request_already_consumed`), or a claim-held request (`request_claim_held`).
   */
  | "request_not_found"
  | "request_already_consumed"
  | "request_claim_held"
  /**
   * A valid operation cannot begin because an exclusive daemon-managed write
   * attempt for the relevant write scope currently owns the durable gate. This
   * request performs zero remote mutation.
   *
   * It does NOT itself mean the previous remote result is ambiguous — see
   * `external_state_ambiguous` for that — and it is not `request_claim_held`,
   * which is specifically about an approval-gated pending request.
   */
  | "operation_in_progress"
  /**
   * The request kind is syntactically valid and the protocol recognizes the
   * operation, but this daemon build/runtime intentionally does not expose or
   * serve it. No mutation occurred.
   *
   * NOT for: an operation blocked by authoritative product capability/policy
   * (`capability_blocked`), an invalid configuration (`config_invalid`), or
   * malformed/unknown request syntax (`protocol_error`).
   */
  | "operation_unavailable"
  | "config_invalid"
  | "capability_blocked"
  | "remote_failure"
  | "external_state_ambiguous"
  | "cleanup_pending"
  | "protocol_error";

/** Keys that must never appear in a serialized response. */
export const RESPONSE_SECRET_KEYS: readonly string[] = Object.freeze([
  "privateKey",
  "private_key",
  "client_secret",
  "refresh_token",
  "access_token",
  "authorization",
  "credentials",
  "apiKey",
  "api_key",
  "serviceAccountJson",
  "releaseNotes",
]);

export interface DaemonApprovalChallenge {
  readonly requestId: string;
  readonly toolName: string;
  readonly permission: ToolPermissionLevel;
  readonly packageName: string;
  readonly requestDigest: string;
  readonly expiresAtUtc: string;
  /** Exact canonical bytes the operator must sign (Stage 1 encoding). */
  readonly canonicalPayload: string;
}

export interface DaemonResponseEnvelope {
  readonly protocolVersion: number;
  readonly correlationId: string;
  readonly outcome: DaemonResponseOutcome;
  /** Operator-facing, already-safe summary. Never credentials or raw remote payloads. */
  readonly summary?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly approval?: DaemonApprovalChallenge;
  /**
   * Safe narrow payload for `request_not_found` ONLY: the canonical request id
   * the server looked for. Never carries pending intent, edit id, state digest,
   * validation expiry, note text or any server-owned identity.
   */
  readonly requestId?: string;
  /**
   * Safe narrow payload for `operation_unavailable` ONLY: the recognized
   * semantic operation name this build does not serve. Never a tool name, module
   * name, publisher method, endpoint or path.
   */
  readonly operation?: DaemonRequestKind;
}

/**
 * Outcome-constrained safe payloads.
 *
 * Both optional fields are permitted only for their own outcome and are fully
 * re-validated, so a response can never use them to carry identity or intent
 * belonging to a different result. This is what keeps `request_not_found` and
 * `operation_unavailable` narrow rather than becoming a disclosure channel.
 */
function assertSafeOutcomePayload(response: DaemonResponseEnvelope): void {
  const raw: { readonly requestId?: unknown; readonly operation?: unknown } = response;

  if (raw.requestId !== undefined) {
    if (response.outcome !== "request_not_found") {
      throw new ProtocolError(
        "INVALID_FIELD",
        'Daemon response may carry "requestId" only for outcome "request_not_found".',
      );
    }
    const requestId = raw.requestId;
    if (
      typeof requestId !== "string" ||
      requestId.length > MAX_REQUEST_ID_CHARS ||
      !REQUEST_ID_PATTERN.test(requestId)
    ) {
      throw new ProtocolError(
        "INVALID_FIELD",
        'Daemon response "requestId" must be a canonical request id.',
      );
    }
  }

  if (raw.operation !== undefined) {
    if (response.outcome !== "operation_unavailable") {
      throw new ProtocolError(
        "INVALID_FIELD",
        'Daemon response may carry "operation" only for outcome "operation_unavailable".',
      );
    }
    const operation = raw.operation;
    if (
      typeof operation !== "string" ||
      !DAEMON_REQUEST_KINDS.includes(operation as DaemonRequestKind)
    ) {
      throw new ProtocolError(
        "INVALID_FIELD",
        'Daemon response "operation" must be a recognized daemon operation.',
      );
    }
  }
}

function assertNoSecretFields(value: unknown, trail = "response"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoSecretFields(item, `${trail}[${String(index)}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (RESPONSE_SECRET_KEYS.includes(key)) {
      throw new ProtocolError(
        "INVALID_FIELD",
        `Daemon response must not carry secret field "${key}" (at ${trail}).`,
      );
    }
    assertNoSecretFields(nested, `${trail}.${key}`);
  }
}

/** Serialize a response, refusing to emit secret-bearing fields or oversized output. */
export function serializeDaemonResponse(response: DaemonResponseEnvelope): Buffer {
  assertNoSecretFields(response);
  assertSafeOutcomePayload(response);
  if (
    response.summary !== undefined &&
    typeof response.summary === "string" &&
    response.summary.length > MAX_SUMMARY_CHARS
  ) {
    throw new ProtocolError("INVALID_FIELD", "Daemon response summary is too long.");
  }
  if (
    response.error !== undefined &&
    typeof response.error.message === "string" &&
    response.error.message.length > MAX_ERROR_MESSAGE_CHARS
  ) {
    throw new ProtocolError("INVALID_FIELD", "Daemon response error message is too long.");
  }
  if (
    response.approval !== undefined &&
    Buffer.byteLength(response.approval.canonicalPayload, "utf8") > MAX_CANONICAL_PAYLOAD_BYTES
  ) {
    throw new ProtocolError("INVALID_FIELD", "Daemon approval challenge is too large.");
  }
  const bytes = Buffer.from(JSON.stringify(response), "utf8");
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new ProtocolError("RESPONSE_TOO_LARGE", "Daemon response exceeds the transport bound.");
  }
  return bytes;
}

/** Enforce the request bound against the raw received byte count. */
export function assertRequestSize(byteLength: number): void {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw malformed("request byte length must be a non-negative integer");
  }
  if (byteLength > MAX_REQUEST_BYTES) {
    throw new ProtocolError("REQUEST_TOO_LARGE", "Daemon request exceeds the transport bound.");
  }
}

/** Length-prefixed framing: 4-byte big-endian length followed by the payload. */
export function encodeDaemonFrame(payload: Buffer): Buffer {
  assertRequestSize(payload.byteLength);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export interface DecodedFrame {
  readonly payload: Buffer;
  readonly rest: Buffer;
}

/** Decode one frame if complete. Throws when the declared length is over-bound. */
export function decodeDaemonFrame(buffer: Buffer): DecodedFrame | undefined {
  if (buffer.byteLength < 4) return undefined;
  const declared = buffer.readUInt32BE(0);
  assertRequestSize(declared);
  if (buffer.byteLength < 4 + declared) return undefined;
  return {
    payload: buffer.subarray(4, 4 + declared),
    rest: buffer.subarray(4 + declared),
  };
}

/** Parse a response for tests and clients; never used to trust server output. */
export function parseDaemonResponse(value: unknown): DaemonResponseEnvelope {
  if (!isRecord(value)) throw malformed("response must be an object");
  exactKeys(value, [
    "protocolVersion",
    "correlationId",
    "outcome",
    "summary",
    "error",
    "approval",
    "requestId",
    "operation",
  ]);
  if (value.protocolVersion !== PLAYOPS_DAEMON_PROTOCOL_VERSION) {
    throw new ProtocolError(
      "UNSUPPORTED_PROTOCOL_VERSION",
      "Daemon protocol version is not supported.",
    );
  }
  assertNoSecretFields(value);
  const response = value as unknown as DaemonResponseEnvelope;
  assertSafeOutcomePayload(response);
  return response;
}
