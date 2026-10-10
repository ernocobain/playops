/**
 * Operator client transport: one framed request per connection over the pinned
 * production Unix-domain socket, with a fail-closed read and NO retry logic.
 *
 * PRODUCTION ENDPOINT AUTHORITY
 * =============================
 * The production endpoint is the module-level constant
 * `PRODUCTION_OPERATOR_SOCKET_PATH`. There is deliberately no CLI flag, no
 * environment variable (`PLAYOPS_DAEMON_SOCKET_PATH` / `PLAYOPS_SOCKET` are
 * never read), no config file and no cwd discovery that can redirect it. Tests
 * inject a `socketPath` through the module API only.
 *
 * FRAMING
 * =======
 * Request: 4-byte big-endian length prefix + JSON payload, then the write side
 * is half-closed (`socket.end()`), exactly matching `encodeDaemonFrame` and the
 * daemon's one-request-per-connection contract. Response: raw JSON read until
 * EOF, bounded by `MAX_RESPONSE_BYTES` and failed closed on overflow. Framing
 * and parsing are reused from `../daemon/protocol.js`; they are never
 * re-implemented here.
 *
 * OUTCOME CLASSIFICATION
 * ======================
 * A failure before any request byte could be written is `connect_failure`
 * (exit 1, provably zero mutation). A failure after the write started is
 * `transport_unknown` (`write_failure`, `response_timeout`, `response_too_large`
 * or `malformed_response`) and is reported as an unknown mutation outcome
 * (exit 2) for a mutating request, never replayed.
 *
 * NO RETRY
 * ========
 * This module contains no retry of any kind. A lost or malformed response after
 * a possible dispatch is reported as unknown-outcome and never re-sent.
 */
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  MAX_RESPONSE_BYTES,
  MAX_CORRELATION_ID_CHARS,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  encodeDaemonFrame,
  parseDaemonResponse,
  type DaemonRequest,
  type DaemonRequestKind,
  type DaemonResponseEnvelope,
} from "../daemon/protocol.js";
import { assertKnownOutcome } from "./outcome.js";

/** The ONLY production endpoint authority. Matches the daemon production default. */
export const PRODUCTION_OPERATOR_SOCKET_PATH = "/run/playops/playops.sock";

/** Fixed short connect timeout. Never operator- or environment-controlled. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** Fixed response timeout for the read-only `status` request. */
export const READ_ONLY_RESPONSE_TIMEOUT_MS = 10_000;

/** Cadence of the human "still waiting" notice for mutating requests. */
export const WAITING_NOTICE_INTERVAL_MS = 5_000;

/**
 * Requests whose execute path can reach an external mutation once dispatched.
 *
 * Mirrors the daemon's own classification (`src/daemon/server.ts`
 * `MUTATING_REQUEST_KINDS`). It decides only how a post-dispatch failure is
 * reported — as an unknown mutation outcome versus a definite one — never
 * whether a mutation is authorized.
 */
const MUTATING_REQUEST_KINDS: readonly DaemonRequestKind[] = Object.freeze([
  "execute_open_edit",
  "attach_notes",
  "execute_commit",
  "execute_verify_committed",
  "execute_reconcile_commit",
]);

export function isMutatingRequest(kind: DaemonRequestKind): boolean {
  return MUTATING_REQUEST_KINDS.includes(kind);
}

export type DaemonTransportFailureKind =
  | "request_too_large"
  | "connect_failure"
  | "connect_timeout"
  | "write_failure"
  | "response_too_large"
  | "malformed_response"
  | "response_timeout"
  | "unknown_outcome"
  | "interrupted";

export interface DaemonTransportFailure {
  readonly kind: DaemonTransportFailureKind;
  readonly message: string;
  /** True only when a request may have reached the daemon and been dispatched. */
  readonly possibleDispatch: boolean;
  /** Used for local-pending versus remote-mutation recovery guidance. */
  readonly requestKind?: DaemonRequestKind;
  /** Conservative exit code: 2 when local or remote state may be unknown, else 1. */
  readonly exitCode: 1 | 2;
}

export type DaemonTransportResult =
  | { readonly ok: true; readonly response: DaemonResponseEnvelope }
  | { readonly ok: false; readonly failure: DaemonTransportFailure };

export interface SendDaemonRequestOptions {
  readonly socketPath: string;
  readonly request: DaemonRequest;
  /** Client-side correlation only. Defaults to a fresh `randomUUID()`. */
  readonly correlationId?: string;
  readonly connectTimeoutMs?: number;
  /** Cancels client waiting only; never cancels or replays daemon work. */
  readonly signal?: AbortSignal;
  /**
   * When set, the read is abandoned after this long. Mutating requests must
   * leave it unset so the client waits for EOF rather than manufacturing false
   * ambiguity; only read-only `status` uses a fixed value.
   */
  readonly responseTimeoutMs?: number;
  /** Periodic "still waiting" notice driver for human mode. */
  readonly onWaiting?: (elapsedMs: number) => void;
  /**
   * Dependency-injection seam for tests (D2: the testing seam is a module API
   * parameter). Production always uses `node:net` `createConnection`.
   */
  readonly connect?: (socketPath: string) => Socket;
}

function failure(
  kind: DaemonTransportFailureKind,
  message: string,
  possibleDispatch: boolean,
  requestKind?: DaemonRequestKind,
): DaemonTransportFailure {
  return Object.freeze({
    kind,
    message,
    possibleDispatch,
    ...(requestKind === undefined ? {} : { requestKind }),
    // Prepare can durably mutate local state even without a Google mutation.
    exitCode: possibleDispatch && requestKind !== "status" ? 2 : 1,
  });
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : "unknown transport error";
}

/** Consumer-only type checks missing from the reused server serializer/parser. */
function assertResponseFields(response: DaemonResponseEnvelope): void {
  if (
    typeof response.correlationId !== "string" ||
    response.correlationId.length > MAX_CORRELATION_ID_CHARS ||
    !/^[A-Za-z0-9_-]+$/u.test(response.correlationId)
  ) {
    throw new TypeError("Invalid response correlation identifier.");
  }
  if (response.summary !== undefined && typeof response.summary !== "string") {
    throw new TypeError("Invalid response summary.");
  }
  if (response.error !== undefined) {
    const error: unknown = response.error;
    if (typeof error !== "object" || error === null || Array.isArray(error))
      throw new TypeError("Invalid response error.");
    const fields = error as Record<string, unknown>;
    if (
      Object.keys(fields).length !== 2 ||
      typeof fields.code !== "string" ||
      fields.code.length === 0 ||
      fields.code.length > 128 ||
      typeof fields.message !== "string"
    ) {
      throw new TypeError("Invalid response error fields.");
    }
  }
}

function defaultConnect(socketPath: string): Socket {
  return createConnection(socketPath);
}

export function sendDaemonRequest(
  options: SendDaemonRequestOptions,
): Promise<DaemonTransportResult> {
  const { request } = options;
  const correlationId = options.correlationId ?? randomUUID();
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  if (options.signal?.aborted) {
    return Promise.resolve({
      ok: false,
      failure: failure("interrupted", "Client interrupted before dispatch.", false, request.kind),
    });
  }

  // Build and size-check the frame BEFORE any connection attempt, so an
  // over-limit request is a purely local failure with zero connection attempts.
  let frame: Buffer;
  try {
    const payload = Buffer.from(
      JSON.stringify({
        protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
        correlationId,
        request,
      }),
      "utf8",
    );
    frame = encodeDaemonFrame(payload);
  } catch (cause) {
    return Promise.resolve({
      ok: false,
      failure: failure("request_too_large", describe(cause), false),
    });
  }

  return new Promise<DaemonTransportResult>((resolve) => {
    const socket = (options.connect ?? defaultConnect)(options.socketPath);
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let writeStarted = false;
    let settled = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let responseTimer: NodeJS.Timeout | undefined;
    let waitingTimer: NodeJS.Timeout | undefined;

    const settle = (result: DaemonTransportResult): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (responseTimer !== undefined) clearTimeout(responseTimer);
      if (waitingTimer !== undefined) clearInterval(waitingTimer);
      options.signal?.removeEventListener("abort", interrupt);
      socket.removeAllListeners();
      // Keep an error sink attached: destroy() may surface a late error.
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(result);
    };

    const fail = (
      kind: DaemonTransportFailureKind,
      message: string,
      possibleDispatch: boolean,
    ): void => {
      settle({ ok: false, failure: failure(kind, message, possibleDispatch, request.kind) });
    };

    const interrupt = (): void => {
      fail(
        "interrupted",
        "Client interrupted; disconnect does not cancel daemon work.",
        writeStarted,
      );
    };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    if (options.signal?.aborted) {
      interrupt();
      return;
    }

    const finalize = (): void => {
      if (settled) return;
      const raw = Buffer.concat(chunks);
      let parsed: unknown;
      try {
        const decoded = raw.toString("utf8");
        if (!Buffer.from(decoded, "utf8").equals(raw))
          throw new TypeError("Invalid response UTF-8.");
        parsed = JSON.parse(decoded);
      } catch {
        fail("malformed_response", "The daemon response was not valid JSON.", writeStarted);
        return;
      }
      let response: DaemonResponseEnvelope;
      try {
        response = parseDaemonResponse(parsed);
        assertResponseFields(response);
      } catch (cause) {
        fail(
          "malformed_response",
          `The daemon response failed protocol validation: ${describe(cause)}`,
          writeStarted,
        );
        return;
      }
      try {
        assertKnownOutcome(response.outcome);
      } catch {
        // Closed-set check: parseDaemonResponse does not validate membership.
        fail(
          "unknown_outcome",
          "The daemon response carried an unrecognized outcome; the result is treated as a protocol failure.",
          writeStarted,
        );
        return;
      }
      settle({ ok: true, response });
    };

    connectTimer = setTimeout(() => {
      fail("connect_timeout", "Timed out connecting to the PlayOps daemon socket.", false);
    }, connectTimeoutMs);

    socket.on("connect", () => {
      if (settled) return;
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      // From here a request may reach the daemon. Be conservative about that.
      writeStarted = true;
      try {
        socket.write(frame);
        socket.end();
      } catch (cause) {
        fail("write_failure", `The request could not be written: ${describe(cause)}`, writeStarted);
        return;
      }
      if (options.responseTimeoutMs !== undefined) {
        responseTimer = setTimeout(() => {
          fail("response_timeout", "Timed out waiting for the daemon response.", writeStarted);
        }, options.responseTimeoutMs);
      } else if (options.onWaiting !== undefined) {
        const startedAt = Date.now();
        waitingTimer = setInterval(() => {
          options.onWaiting?.(Date.now() - startedAt);
        }, WAITING_NOTICE_INTERVAL_MS);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        // Fail closed: never buffer or parse an over-bound response.
        fail(
          "response_too_large",
          "The daemon response exceeded the client transport bound.",
          writeStarted,
        );
        return;
      }
      chunks.push(chunk);
    });

    socket.on("end", () => {
      finalize();
    });

    socket.on("close", () => {
      if (!settled)
        fail("write_failure", "The connection closed without a complete response.", writeStarted);
    });

    socket.on("error", (cause: Error) => {
      // Before any bytes were written this is a connect failure with provably
      // zero mutation; afterwards the outcome is unknown and never replayed.
      if (writeStarted) {
        fail(
          "write_failure",
          `The connection failed after dispatch: ${describe(cause)}`,
          writeStarted,
        );
      } else {
        fail(
          "connect_failure",
          `The daemon socket could not be reached: ${describe(cause)}`,
          false,
        );
      }
    });
  });
}
