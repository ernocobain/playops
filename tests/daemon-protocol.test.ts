/**
 * Typed daemon protocol: versioning, closed-world operations, forbidden
 * client-controlled identities, scalar strictness, size bounds and framing.
 * Entirely offline; no socket, no daemon, no Google.
 */
import { describe, expect, it } from "vitest";
import type { PendingOperationStateName } from "../src/daemon/pending-store.js";
import {
  DAEMON_REQUEST_KINDS,
  type DaemonRequestKind,
  type DaemonResponseOutcome,
  MAX_NOTE_TEXT_BYTES,
  MAX_REQUEST_BYTES,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  ProtocolError,
  assertRequestSize,
  decodeDaemonFrame,
  encodeDaemonFrame,
  parseDaemonRequest,
  parseDaemonResponse,
  serializeDaemonResponse,
} from "../src/daemon/protocol.js";

const CORRELATION = "corr-1";
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

function envelope(request: unknown, protocolVersion: number = PLAYOPS_DAEMON_PROTOCOL_VERSION) {
  return { protocolVersion, correlationId: CORRELATION, request };
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    return cause instanceof ProtocolError ? cause.code : `UNEXPECTED:${String(cause)}`;
  }
}

describe("daemon protocol request parsing", () => {
  it("accepts every declared operation kind", () => {
    const samples: Record<string, unknown> = {
      status: { kind: "status" },
      prepare_open_edit: { kind: "prepare_open_edit" },
      execute_open_edit: { kind: "execute_open_edit", requestId: REQUEST_ID, signature: "c2ln" },
      attach_notes: {
        kind: "attach_notes",
        track: "internal",
        versionCode: "3",
        locale: "en-US",
        noteText: "Probe note.",
      },
      prepare_commit: { kind: "prepare_commit", track: "internal", versionCode: "3" },
      execute_commit: { kind: "execute_commit", requestId: REQUEST_ID, signature: "c2ln" },
      prepare_verify_committed: {
        kind: "prepare_verify_committed",
        track: "internal",
        versionCode: "3",
      },
      execute_verify_committed: {
        kind: "execute_verify_committed",
        requestId: REQUEST_ID,
        signature: "c2ln",
      },
      prepare_reconcile_commit: { kind: "prepare_reconcile_commit" },
      execute_reconcile_commit: {
        kind: "execute_reconcile_commit",
        requestId: REQUEST_ID,
        signature: "c2ln",
      },
    };
    expect(Object.keys(samples).sort()).toEqual([...DAEMON_REQUEST_KINDS].sort());
    for (const sample of Object.values(samples)) {
      const parsed = parseDaemonRequest(envelope(sample));
      expect(parsed.protocolVersion).toBe(PLAYOPS_DAEMON_PROTOCOL_VERSION);
    }
  });

  it("exposes no blocked maturity capability", () => {
    for (const blocked of [
      "update_rollout_fraction",
      "halt_rollout",
      "resume_rollout",
      "upload_bundle",
      "configure_release",
    ]) {
      expect(DAEMON_REQUEST_KINDS.some((kind) => kind.includes(blocked))).toBe(false);
    }
  });

  it("accepts protocol version 4 and fails closed on v3, v2 and v5", () => {
    expect(PLAYOPS_DAEMON_PROTOCOL_VERSION).toBe(4);
    expect(parseDaemonRequest(envelope({ kind: "status" })).protocolVersion).toBe(4);
    for (const version of [3, 2, 1, 5, 0]) {
      expect(errorCode(() => parseDaemonRequest(envelope({ kind: "status" }, version)))).toBe(
        "UNSUPPORTED_PROTOCOL_VERSION",
      );
    }
    // The wire version and the persisted pending-record version are independent.
    expect(PLAYOPS_DAEMON_PROTOCOL_VERSION).not.toBe(1);
  });

  it("rejects unknown operations and a missing kind", () => {
    expect(errorCode(() => parseDaemonRequest(envelope({ kind: "execute_tool" })))).toBe(
      "UNKNOWN_OPERATION",
    );
    expect(errorCode(() => parseDaemonRequest(envelope({ kind: "halt_rollout" })))).toBe(
      "UNKNOWN_OPERATION",
    );
    expect(errorCode(() => parseDaemonRequest(envelope({})))).toBe("UNKNOWN_OPERATION");
  });

  it("rejects unknown keys instead of discarding them", () => {
    expect(errorCode(() => parseDaemonRequest(envelope({ kind: "status", extra: 1 })))).toBe(
      "UNKNOWN_FIELD",
    );
    expect(
      errorCode(() =>
        parseDaemonRequest({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          request: { kind: "status" },
          unexpected: true,
        }),
      ),
    ).toBe("UNKNOWN_FIELD");
  });

  it("rejects every server-owned identity field the client must never supply", () => {
    const forbidden: Record<string, unknown>[] = [
      { kind: "prepare_commit", track: "internal", versionCode: "3", editId: "abc" },
      { kind: "prepare_commit", track: "internal", versionCode: "3", stateDigest: "a".repeat(64) },
      { kind: "execute_commit", requestId: REQUEST_ID, signature: "c2ln", requestDigest: "x" },
      { kind: "execute_commit", requestId: REQUEST_ID, signature: "c2ln", nonce: "n" },
      { kind: "execute_commit", requestId: REQUEST_ID, signature: "c2ln", expiresAtUtc: "z" },
      { kind: "execute_commit", requestId: REQUEST_ID, signature: "c2ln", packageName: "p" },
      { kind: "execute_commit", requestId: REQUEST_ID, signature: "c2ln", toolName: "t" },
      { kind: "execute_commit", requestId: REQUEST_ID, signature: "c2ln", intent: {} },
      {
        kind: "attach_notes",
        track: "internal",
        versionCode: "3",
        locale: "en-US",
        noteText: "x",
        path: "/etc",
      },
      {
        kind: "attach_notes",
        track: "internal",
        versionCode: "3",
        locale: "en-US",
        noteText: "x",
        textFile: "/tmp/n",
      },
      {
        kind: "prepare_commit",
        track: "internal",
        versionCode: "3",
        validationExpiryTimeSeconds: "1",
      },
      { kind: "prepare_commit", track: "internal", versionCode: "3", priorStateDigest: "d" },
      { kind: "prepare_commit", track: "internal", versionCode: "3", method: "edits.commit" },
    ];
    for (const request of forbidden) {
      expect(errorCode(() => parseDaemonRequest(envelope(request)))).toBe("FORBIDDEN_FIELD");
    }
  });

  it("rejects forbidden fields nested inside the request", () => {
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({
            kind: "prepare_commit",
            track: "internal",
            versionCode: "3",
            nested: { editId: "x" },
          }),
        ),
      ),
    ).toBe("FORBIDDEN_FIELD");
  });

  it("rejects unsafe scalar coercions and wrong types", () => {
    expect(
      errorCode(() =>
        parseDaemonRequest(envelope({ kind: "prepare_commit", track: 123, versionCode: "3" })),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(envelope({ kind: "prepare_commit", track: null, versionCode: "3" })),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "prepare_commit", track: ["internal"], versionCode: "3" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "prepare_commit", track: "INTERNAL!", versionCode: "3" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "prepare_commit", track: "internal", versionCode: "3.5" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "prepare_commit", track: "internal", versionCode: "NaN" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({
            kind: "attach_notes",
            track: "internal",
            versionCode: "3",
            locale: "en-US",
          }),
        ),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("rejects an invalid request id and an invalid signature encoding", () => {
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "execute_commit", requestId: "../../etc", signature: "c2ln" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "execute_commit", requestId: REQUEST_ID, signature: "not base64!" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "execute_commit", requestId: REQUEST_ID, signature: "" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("rejects a malformed envelope", () => {
    expect(errorCode(() => parseDaemonRequest("not-an-object"))).toBe("MALFORMED_REQUEST");
    expect(errorCode(() => parseDaemonRequest(null))).toBe("MALFORMED_REQUEST");
    expect(errorCode(() => parseDaemonRequest(envelope({ kind: "status" }, Number.NaN)))).toBe(
      "UNSUPPORTED_PROTOCOL_VERSION",
    );
    expect(
      errorCode(() =>
        parseDaemonRequest({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: "bad correlation!",
          request: { kind: "status" },
        }),
      ),
    ).toBe("INVALID_FIELD");
  });
});

describe("daemon protocol size bounds", () => {
  it("accepts note text at the bound and rejects over it", () => {
    const atBound = "a".repeat(MAX_NOTE_TEXT_BYTES);
    const parsed = parseDaemonRequest(
      envelope({
        kind: "attach_notes",
        track: "internal",
        versionCode: "3",
        locale: "en-US",
        noteText: atBound,
      }),
    );
    expect(parsed.request.kind).toBe("attach_notes");
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({
            kind: "attach_notes",
            track: "internal",
            versionCode: "3",
            locale: "en-US",
            noteText: "a".repeat(MAX_NOTE_TEXT_BYTES + 1),
          }),
        ),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("rejects multi-byte note text that exceeds the byte bound even under the char bound", () => {
    const multibyte = "é".repeat(MAX_NOTE_TEXT_BYTES / 2 + 1);
    expect(multibyte.length).toBeLessThanOrEqual(MAX_NOTE_TEXT_BYTES);
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({
            kind: "attach_notes",
            track: "internal",
            versionCode: "3",
            locale: "en-US",
            noteText: multibyte,
          }),
        ),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("enforces the request byte bound at the boundary", () => {
    expect(() => assertRequestSize(MAX_REQUEST_BYTES)).not.toThrow();
    expect(errorCode(() => assertRequestSize(MAX_REQUEST_BYTES + 1))).toBe("REQUEST_TOO_LARGE");
    expect(errorCode(() => assertRequestSize(-1))).toBe("MALFORMED_REQUEST");
  });

  it("round-trips frames and refuses an over-bound declared length", () => {
    const payload = Buffer.from(JSON.stringify({ kind: "status" }), "utf8");
    const framed = encodeDaemonFrame(payload);
    const decoded = decodeDaemonFrame(framed);
    expect(decoded?.payload.toString("utf8")).toBe(payload.toString("utf8"));
    expect(decoded?.rest.byteLength).toBe(0);
    expect(decodeDaemonFrame(Buffer.from([0, 0, 0, 3, 1, 2]))).toBeUndefined();
    expect(decodeDaemonFrame(Buffer.from([0, 0]))).toBeUndefined();
    const overBound = Buffer.alloc(4);
    overBound.writeUInt32BE(MAX_REQUEST_BYTES + 1, 0);
    expect(errorCode(() => decodeDaemonFrame(overBound))).toBe("REQUEST_TOO_LARGE");
  });
});

describe("daemon protocol response model", () => {
  it("serializes a distinct outcome per materially different result", () => {
    const outcomes = [
      "success",
      "approval_required",
      "approval_mismatch",
      "local_state_failure",
      "approval_expired",
      "request_not_found",
      "request_already_consumed",
      "request_claim_held",
      "operation_in_progress",
      "operation_unavailable",
      "config_invalid",
      "capability_blocked",
      "remote_failure",
      "external_state_ambiguous",
      "cleanup_pending",
      "protocol_error",
    ] as const;
    for (const outcome of outcomes) {
      const bytes = serializeDaemonResponse({
        protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
        correlationId: CORRELATION,
        outcome,
      });
      const parsed = parseDaemonResponse(JSON.parse(bytes.toString("utf8")) as unknown);
      expect(parsed.outcome).toBe(outcome);
    }
  });

  it("refuses to emit secret-bearing response fields", () => {
    for (const key of [
      "private_key",
      "privateKey",
      "access_token",
      "refresh_token",
      "client_secret",
      "authorization",
      "credentials",
      "apiKey",
      "serviceAccountJson",
      "releaseNotes",
    ]) {
      expect(
        errorCode(() =>
          serializeDaemonResponse({
            protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
            correlationId: CORRELATION,
            outcome: "success",
            summary: "ok",
            ...({ [key]: "secret" } as Record<string, unknown>),
          } as never),
        ),
      ).toBe("INVALID_FIELD");
    }
  });

  it("refuses secret fields nested in a response", () => {
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          outcome: "success",
          ...({ nested: { access_token: "x" } } as Record<string, unknown>),
        } as never),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("rejects an oversized summary and unknown response keys on parse", () => {
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          outcome: "success",
          summary: "x".repeat(2001),
        }),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        parseDaemonResponse({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          outcome: "success",
          extra: 1,
        }),
      ),
    ).toBe("UNKNOWN_FIELD");
  });
});

/**
 * STAGE 2.2 — response-outcome taxonomy.
 *
 * `operation_unavailable` and `request_not_found` must stay distinguishable from
 * `protocol_error`, `capability_blocked` and `config_invalid`, and must carry
 * only narrow safe payloads. Everything below is a protocol-level fixture: no
 * daemon dispatcher exists yet (Stage 3 remains paused), and none of this
 * classifies a real release capability. The authoritative maturity map is not
 * read, modified or duplicated here.
 */
const MISSING_REQUEST_ID = "99999999-8888-4777-8666-555555555555";
const MALFORMED_REQUEST_ID = "not-a-canonical-request-id";

/** Fixture only — NOT production routing. */
const FIXTURE_MATURITY_BLOCKED: readonly DaemonRequestKind[] = ["prepare_commit"];
/** Fixture only — the operations a hypothetical build happens to serve. */
const FIXTURE_SERVED_BY_THIS_BUILD: readonly DaemonRequestKind[] = ["status", "prepare_open_edit"];

function fixtureClassify(kind: string): DaemonResponseOutcome {
  // Unknown operation: not recognized by the protocol at all.
  if (!DAEMON_REQUEST_KINDS.includes(kind as DaemonRequestKind)) return "protocol_error";
  const known = kind as DaemonRequestKind;
  // Recognized + implemented, but blocked by authoritative capability policy.
  if (FIXTURE_MATURITY_BLOCKED.includes(known)) return "capability_blocked";
  // Recognized, but this build intentionally does not serve it.
  if (!FIXTURE_SERVED_BY_THIS_BUILD.includes(known)) return "operation_unavailable";
  return "success";
}

/** Fixture only — proving only a canonical absent id yields `request_not_found`. */
const FIXTURE_STATE_OUTCOMES: Readonly<
  Record<PendingOperationStateName, DaemonResponseOutcome | undefined>
> = Object.freeze({
  absent: "request_not_found",
  pending: undefined,
  claimed: "request_claim_held",
  consumed: "request_already_consumed",
  completed: "request_already_consumed",
  recovery_required: "external_state_ambiguous",
  expired: "approval_expired",
});

describe("daemon protocol response-outcome taxonomy", () => {
  it("does not collapse any materially different outcome", () => {
    const vocabulary: readonly DaemonResponseOutcome[] = [
      "status",
      "approval_required",
      "success",
      "approval_mismatch",
      "local_state_failure",
      "approval_expired",
      "request_not_found",
      "request_already_consumed",
      "request_claim_held",
      "operation_in_progress",
      "operation_unavailable",
      "config_invalid",
      "capability_blocked",
      "remote_failure",
      "external_state_ambiguous",
      "cleanup_pending",
      "protocol_error",
    ];
    expect(new Set(vocabulary).size).toBe(vocabulary.length);
    expect(vocabulary).toHaveLength(17);
  });

  it("round-trips the two new outcomes with their narrow safe payloads", () => {
    const notFoundBytes = serializeDaemonResponse({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
      outcome: "request_not_found",
      requestId: MISSING_REQUEST_ID,
    });
    const notFound = parseDaemonResponse(JSON.parse(notFoundBytes.toString("utf8")) as unknown);
    expect(notFound.outcome).toBe("request_not_found");
    expect(notFound.requestId).toBe(MISSING_REQUEST_ID);
    expect(notFound.operation).toBeUndefined();

    const unavailableBytes = serializeDaemonResponse({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
      outcome: "operation_unavailable",
      operation: "execute_commit",
    });
    const unavailable = parseDaemonResponse(
      JSON.parse(unavailableBytes.toString("utf8")) as unknown,
    );
    expect(unavailable.outcome).toBe("operation_unavailable");
    expect(unavailable.operation).toBe("execute_commit");
    expect(unavailable.requestId).toBeUndefined();
  });

  it("refuses each new payload field on any other outcome, and vice versa", () => {
    const base = {
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
    } as const;
    // requestId belongs to request_not_found only.
    expect(
      errorCode(() =>
        serializeDaemonResponse({ ...base, outcome: "success", requestId: MISSING_REQUEST_ID }),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          ...base,
          outcome: "config_invalid",
          requestId: MISSING_REQUEST_ID,
        }),
      ),
    ).toBe("INVALID_FIELD");
    // operation belongs to operation_unavailable only.
    expect(
      errorCode(() =>
        serializeDaemonResponse({ ...base, outcome: "success", operation: "status" }),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          ...base,
          outcome: "capability_blocked",
          operation: "prepare_commit",
        }),
      ),
    ).toBe("INVALID_FIELD");
    // The parse side enforces the same constraint.
    expect(
      errorCode(() =>
        parseDaemonResponse({
          ...base,
          outcome: "success",
          requestId: MISSING_REQUEST_ID,
        }),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("refuses an out-of-vocabulary operation name and a non-canonical request id", () => {
    const base = {
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
    } as const;
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          ...base,
          outcome: "operation_unavailable",
          operation: "execute_tool" as never,
        }),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          ...base,
          outcome: "request_not_found",
          requestId: MALFORMED_REQUEST_ID,
        }),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("keeps operation_unavailable, capability_blocked and protocol_error distinct", () => {
    // Unknown operation: not part of the request vocabulary at all.
    expect(fixtureClassify("execute_tool")).toBe("protocol_error");
    expect(fixtureClassify("halt_rollout")).toBe("protocol_error");
    // Recognized + implemented + capability-policy blocked.
    expect(fixtureClassify("prepare_commit")).toBe("capability_blocked");
    // Recognized but not served by this build.
    expect(fixtureClassify("execute_commit")).toBe("operation_unavailable");
    expect(fixtureClassify("prepare_verify_committed")).toBe("operation_unavailable");
    expect(fixtureClassify("prepare_reconcile_commit")).toBe("operation_unavailable");
    // Recognized and served.
    expect(fixtureClassify("status")).toBe("success");
    expect(fixtureClassify("prepare_open_edit")).toBe("success");
    // A client cannot manufacture the outcome vocabulary as an operation.
    expect(errorCode(() => parseDaemonRequest(envelope({ kind: "operation_unavailable" })))).toBe(
      "UNKNOWN_OPERATION",
    );
    expect(errorCode(() => parseDaemonRequest(envelope({ kind: "request_not_found" })))).toBe(
      "UNKNOWN_OPERATION",
    );
  });

  it("keeps a malformed request id out of the request_not_found path", () => {
    // Malformed id: rejected at protocol validation, never reaching the store.
    expect(
      errorCode(() =>
        parseDaemonRequest(
          envelope({ kind: "execute_commit", requestId: MALFORMED_REQUEST_ID, signature: "c2ln" }),
        ),
      ),
    ).toBe("INVALID_FIELD");
    // Canonical but absent id: parses successfully, so absence stays a store fact
    // rather than a parse error. Parser/store separation is preserved.
    const parsed = parseDaemonRequest(
      envelope({ kind: "execute_commit", requestId: MISSING_REQUEST_ID, signature: "c2ln" }),
    );
    expect(parsed.request.kind).toBe("execute_commit");
    expect("requestId" in parsed.request && parsed.request.requestId).toBe(MISSING_REQUEST_ID);
    // Only the absent state may ever yield request_not_found.
    const producingNotFound = Object.entries(FIXTURE_STATE_OUTCOMES)
      .filter(([, outcome]) => outcome === "request_not_found")
      .map(([state]) => state);
    expect(producingNotFound).toEqual(["absent"]);
    expect(FIXTURE_STATE_OUTCOMES.pending).toBeUndefined();
  });

  it("keeps every durable pending state on its own existing outcome", () => {
    expect(FIXTURE_STATE_OUTCOMES.expired).toBe("approval_expired");
    expect(FIXTURE_STATE_OUTCOMES.claimed).toBe("request_claim_held");
    expect(FIXTURE_STATE_OUTCOMES.consumed).toBe("request_already_consumed");
    expect(FIXTURE_STATE_OUTCOMES.completed).toBe("request_already_consumed");
    expect(FIXTURE_STATE_OUTCOMES.recovery_required).toBe("external_state_ambiguous");
    const used = Object.values(FIXTURE_STATE_OUTCOMES).filter(
      (outcome): outcome is DaemonResponseOutcome => outcome !== undefined,
    );
    // Five distinct outcomes for six non-pending states; no collapsing into one.
    expect(new Set(used).size).toBe(5);
    expect(used).not.toContain("config_invalid");
    expect(used).not.toContain("capability_blocked");
    expect(used).not.toContain("protocol_error");
  });

  it("still refuses secret-bearing fields on the two new outcomes", () => {
    for (const outcome of [
      "request_not_found",
      "operation_unavailable",
      "operation_in_progress",
      "local_state_failure",
    ] as const) {
      expect(
        errorCode(() =>
          serializeDaemonResponse({
            protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
            correlationId: CORRELATION,
            outcome,
            ...({ releaseNotes: "secret" } as Record<string, unknown>),
          } as never),
        ),
      ).toBe("INVALID_FIELD");
    }
  });

  it("carries a narrow safe payload for local_state_failure", () => {
    const bytes = serializeDaemonResponse({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
      outcome: "local_state_failure",
      error: { code: "APPROVAL_CONSUMPTION_PERSIST_FAILED", message: "local persistence failed" },
    });
    const parsed = parseDaemonResponse(JSON.parse(bytes.toString("utf8")) as unknown);
    expect(parsed.outcome).toBe("local_state_failure");
    expect(parsed.error?.code).toBe("APPROVAL_CONSUMPTION_PERSIST_FAILED");
    // The outcome is distinct from every outcome it could be confused with.
    expect(parsed.outcome).not.toBe("approval_mismatch");
    expect(parsed.outcome).not.toBe("config_invalid");
    expect(parsed.outcome).not.toBe("remote_failure");
    expect(parsed.outcome).not.toBe("external_state_ambiguous");
    expect(parsed.outcome).not.toBe("cleanup_pending");
  });

  it("keeps requestId and operation constrained to their own outcomes", () => {
    const base = {
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
    } as const;
    // The envelope policy permits requestId only for request_not_found, so a
    // local_state_failure may not carry one.
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          ...base,
          outcome: "local_state_failure",
          requestId: MISSING_REQUEST_ID,
        }),
      ),
    ).toBe("INVALID_FIELD");
    expect(
      errorCode(() =>
        serializeDaemonResponse({ ...base, outcome: "local_state_failure", operation: "status" }),
      ),
    ).toBe("INVALID_FIELD");
  });

  it("requires an explicit canonical versionCode for attach_notes", () => {
    const base = { track: "internal", locale: "en-US", noteText: "x" };
    // Missing entirely.
    expect(errorCode(() => parseDaemonRequest(envelope({ kind: "attach_notes", ...base })))).toBe(
      "INVALID_FIELD",
    );
    // Malformed, non-canonical or out-of-bound values. No coercion, no float, no
    // negative, no overflow into a Google resource.
    for (const versionCode of [
      "",
      "-1",
      "1.5",
      " 3",
      "3\u0000",
      "abc",
      "1e5",
      "0x10",
      "0o7",
      "٣",
      "9".repeat(21),
    ]) {
      expect(
        errorCode(() =>
          parseDaemonRequest(envelope({ kind: "attach_notes", ...base, versionCode })),
        ),
      ).toBe("INVALID_FIELD");
    }
    // A numeric value is never coerced into a string.
    expect(
      errorCode(() =>
        parseDaemonRequest(envelope({ kind: "attach_notes", ...base, versionCode: 3 })),
      ),
    ).toBe("INVALID_FIELD");
    // The canonical decimal form the other release operations already use is
    // accepted and preserved verbatim.
    const parsed = parseDaemonRequest(
      envelope({ kind: "attach_notes", ...base, versionCode: "42" }),
    );
    expect(parsed.request.kind).toBe("attach_notes");
    expect("versionCode" in parsed.request && parsed.request.versionCode).toBe("42");
  });

  it("rejects every internal targeting object the client must never supply", () => {
    const base = {
      kind: "attach_notes",
      track: "internal",
      versionCode: "3",
      locale: "en-US",
      noteText: "x",
    };
    for (const forbidden of [
      { configuredRelease: {} },
      { uploadedBundle: {} },
      { bundle: {} },
      { bundleSha256: "a".repeat(64) },
      { release: {} },
      { packageName: "com.example.app" },
      { editId: "edit-1" },
      { stateDigest: "a".repeat(64) },
      { requestDigest: "a".repeat(64) },
      { validationExpiryTimeSeconds: "1" },
      { path: "/etc/passwd" },
    ]) {
      expect(errorCode(() => parseDaemonRequest(envelope({ ...base, ...forbidden })))).toBe(
        "FORBIDDEN_FIELD",
      );
    }
  });

  it("carries a narrow safe payload for operation_in_progress", () => {
    const bytes = serializeDaemonResponse({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
      outcome: "operation_in_progress",
      summary: "Another write attempt holds the gate for this edit.",
    });
    const parsed = parseDaemonResponse(JSON.parse(bytes.toString("utf8")) as unknown);

    expect(parsed.outcome).toBe("operation_in_progress");
    // Distinct from every outcome it could be confused with.
    expect(parsed.outcome).not.toBe("request_claim_held");
    expect(parsed.outcome).not.toBe("external_state_ambiguous");
    expect(parsed.outcome).not.toBe("local_state_failure");
    expect(parsed.outcome).not.toBe("protocol_error");
    // No requestId/operation payload is permitted on this outcome.
    expect(
      errorCode(() =>
        serializeDaemonResponse({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          outcome: "operation_in_progress",
          requestId: MISSING_REQUEST_ID,
        }),
      ),
    ).toBe("INVALID_FIELD");
  });
});
