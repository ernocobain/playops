/**
 * Stage 3B — Unix-domain socket server core.
 *
 * This is a LIBRARY/CORE server. It has no bootstrap, no credential access, no
 * publisher and no cwd-relative configuration, so nothing in this checkout can
 * start a live Google-capable daemon. Everything is injected.
 *
 * TRANSPORT CONTRACT (deliberately simple and bounded)
 * ====================================================
 *   one accepted connection -> exactly one framed request -> exactly one framed
 *   response -> close.
 *
 * No streaming, no pipelining, no multiplexing, no subscriptions.
 *
 * REQUEST COMPLETION — the important part
 * ---------------------------------------
 * A single 4-byte length prefix plus payload is NOT self-delimiting from the
 * server's point of view: after reading a complete frame the server cannot know
 * whether more bytes are still in flight. Dispatching on "frame looks complete"
 * would allow an attacker to append trailing bytes that are only noticed after a
 * mutation had already started.
 *
 * Therefore the request is delimited by the client half-closing its write side
 * (`shutdown(SHUT_WR)` / `socket.end()`): the server reads until end-of-request,
 * and only then validates that the accumulated bytes are EXACTLY one frame with
 * no trailing data. Only after that validation does it dispatch.
 *
 * Consequences, all tested:
 *   - trailing junk after a valid frame -> rejected, zero dispatch
 *   - two concatenated frames            -> rejected, zero dispatch
 *   - truncated frame                    -> rejected, zero dispatch
 *   - never half-closing                 -> bounded by the request timeout, zero dispatch
 *
 * The server is created with `allowHalfOpen: true` so it can still write the
 * response after receiving the client's FIN.
 *
 * KNOWN LIMITATION (unchanged from earlier stages): peer credentials are not
 * available through the Node API, so this server performs no peer authorization.
 * Connecting to the socket is NOT authorization: every destructive/publish
 * operation still needs a valid pending request and a real human signature.
 */
import { chmod, lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  MAX_REQUEST_BYTES,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  ProtocolError,
  decodeDaemonFrame,
  parseDaemonRequest,
  serializeDaemonResponse,
  type DaemonRequest,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
} from "./protocol.js";

/** Default socket file mode after bind. Production Stage 6 may use 0660 + group. */
export const DEFAULT_DAEMON_SOCKET_MODE = 0o600;
/** Default bounded request/read timeout. */
export const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 5_000;
/** Correlation id used for transport-level errors, before an envelope exists. */
const TRANSPORT_CORRELATION_ID = "transport-error";

export type DaemonServerErrorCode =
  | "DAEMON_SOCKET_PATH_EXISTS"
  | "DAEMON_SOCKET_PARENT_INVALID"
  | "DAEMON_SOCKET_PARENT_INSECURE"
  | "DAEMON_SOCKET_MODE_INVALID"
  | "DAEMON_SERVER_ALREADY_STARTED"
  | "DAEMON_SERVER_NOT_STARTED";

export class DaemonServerError extends Error {
  override readonly name = "DaemonServerError";

  constructor(
    readonly code: DaemonServerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Audit-safe diagnostic. Contains no payloads, identities or credentials. */
export interface DaemonServerDiagnostic {
  readonly event: "rejected" | "dispatched" | "timed_out" | "transport_error";
  readonly code: string;
}

export interface DaemonServerOptions {
  /** The dispatcher. Called at most once per accepted connection. */
  readonly handle: (envelope: DaemonRequestEnvelope) => Promise<DaemonResponseEnvelope>;
  readonly socketPath: string;
  /** Applied after bind and verified. Never rely on Node's default. */
  readonly socketMode?: number;
  readonly requestTimeoutMs?: number;
  readonly diagnosticSink?: (event: DaemonServerDiagnostic) => void;
}

export interface DaemonServer {
  readonly socketPath: string;
  start(): Promise<void>;
  /**
   * Graceful close: stops accepting new connections and drops live sockets.
   *
   * It never touches durable operation state — no pending record, claim or
   * managed session is deleted or released, and an in-flight operation is not
   * cancelled.
   */
  close(): Promise<void>;
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === code;
}

/** A response that is guaranteed to serialize: no summary, no approval, no error. */
function transportResponse(
  outcome: DaemonResponseEnvelope["outcome"],
  code: string,
  message: string,
): DaemonResponseEnvelope {
  return Object.freeze({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: TRANSPORT_CORRELATION_ID,
    outcome,
    error: { code, message },
  });
}

/**
 * Operations that may reach an external mutation once dispatched.
 *
 * This classification decides how an UNEXPECTED dispatcher throw is reported:
 * `external_state_ambiguous` (a remote effect may already exist) versus
 * `local_state_failure` (provably nothing remote began). Every served operation
 * whose execute path can mutate Google Play state MUST be listed, or the daemon
 * would understate a real mutation risk as a definite local failure. Future
 * `execute_verify_committed` / `execute_reconcile_commit` kinds must be added
 * here when they are served.
 */
const MUTATING_REQUEST_KINDS: readonly DaemonRequest["kind"][] = Object.freeze([
  "execute_open_edit",
  "attach_notes",
  "execute_commit",
  // Stage 3E.3: the verification execute path creates and deletes a temporary
  // Google Play edit, so an unexpected post-dispatch throw is never reported as
  // definitely non-mutating. `prepare_verify_committed` stays non-mutating.
  "execute_verify_committed",
  // Stage 3F.2: approved expired reconciliation may insert and delete exactly
  // one temporary Google Play edit, so an unexpected post-dispatch throw is
  // never reported as definitely non-mutating. `prepare_reconcile_commit` stays
  // outside: its local continuation mutates only local durable state.
  "execute_reconcile_commit",
]);

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const socketPath = options.socketPath;
  const socketMode = options.socketMode ?? DEFAULT_DAEMON_SOCKET_MODE;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new DaemonServerError("DAEMON_SOCKET_PARENT_INVALID", "A socket path is required.");
  }
  if (!Number.isInteger(socketMode) || socketMode <= 0 || (socketMode & 0o077) !== 0) {
    // Stage 3B requires a socket that is not reachable by group/other.
    throw new DaemonServerError(
      "DAEMON_SOCKET_MODE_INVALID",
      "Socket mode must be a restrictive owner-only mode.",
    );
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new DaemonServerError(
      "DAEMON_SERVER_NOT_STARTED",
      "Request timeout must be a positive integer.",
    );
  }

  const sockets = new Set<Socket>();
  let started = false;
  let closed = false;

  const diagnose = (event: DaemonServerDiagnostic): void => {
    options.diagnosticSink?.(event);
  };

  const server: Server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    handleConnection(socket);
  });

  /** Write one framed response and close. Never throws. */
  const respond = (socket: Socket, response: DaemonResponseEnvelope): void => {
    let bytes: Buffer;
    try {
      bytes = serializeDaemonResponse(response);
    } catch {
      // Serialization failed: fall back to a payload we know is safe and small.
      try {
        bytes = serializeDaemonResponse(
          transportResponse(
            "protocol_error",
            "RESPONSE_SERIALIZATION_FAILED",
            "Response could not be serialized.",
          ),
        );
      } catch {
        return;
      }
    }
    socket.on("error", () => undefined);
    try {
      socket.write(bytes);
    } catch {
      return;
    }
    try {
      socket.end();
    } catch {
      /* socket already gone */
    }
  };

  function handleConnection(socket: Socket): void {
    let buffered: Buffer = Buffer.alloc(0);
    /** Nothing further will be dispatched on this connection. */
    let decided = false;
    /** The dispatched request may have reached an external mutation. */
    let possiblyMutating = false;

    const timer = setTimeout(() => {
      if (decided) return;
      decided = true;
      diagnose({ event: "timed_out", code: "DAEMON_REQUEST_TIMEOUT" });
      sockets.delete(socket);
      socket.destroy();
    }, requestTimeoutMs);

    const reject = (code: string, message: string): void => {
      if (decided) return;
      decided = true;
      clearTimeout(timer);
      diagnose({ event: "rejected", code });
      respond(socket, transportResponse("protocol_error", code, message));
    };

    socket.on("error", () => {
      // Transport failure. Pre-dispatch: zero execution. Post-dispatch: the
      // operation owns its own lifecycle and is NOT cancelled or retried.
      diagnose({ event: "transport_error", code: "DAEMON_CONNECTION_ERROR" });
    });

    socket.on("data", (chunk: Buffer) => {
      if (decided) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength >= 4) {
        const declared = buffered.readUInt32BE(0);
        if (declared > MAX_REQUEST_BYTES) {
          // Reject on the prefix alone: never wait for, or allocate, the declared size.
          reject("REQUEST_TOO_LARGE", "Daemon request exceeds the transport bound.");
          return;
        }
      }
      if (buffered.byteLength > 4 + MAX_REQUEST_BYTES) {
        // More bytes than any single legitimate frame can hold.
        reject("MALFORMED_REQUEST", "Daemon connection carried more than one request frame.");
      }
    });

    socket.on("end", () => {
      void finalize();
    });

    async function finalize(): Promise<void> {
      if (decided) return;
      clearTimeout(timer);

      const decoded = ((): { payload: Buffer; rest: Buffer } | undefined => {
        try {
          return decodeDaemonFrame(buffered);
        } catch {
          reject("REQUEST_TOO_LARGE", "Daemon request exceeds the transport bound.");
          return undefined;
        }
      })();
      if (decided || decoded === undefined) {
        // Incomplete frame: a truncated or empty request. Never dispatch.
        reject("FRAME_INCOMPLETE", "Daemon connection did not carry exactly one complete request.");
        return;
      }
      if (decoded.rest.byteLength !== 0) {
        // Trailing bytes: a second frame or junk. The request is rejected BEFORE
        // dispatch, so no mutation can have started.
        reject(
          "MALFORMED_REQUEST",
          "Daemon connection carried trailing data after the request frame.",
        );
        return;
      }

      let request: DaemonRequest;
      let envelope: ReturnType<typeof parseDaemonRequest>;
      try {
        const parsed: unknown = JSON.parse(decoded.payload.toString("utf8"));
        envelope = parseDaemonRequest(parsed);
        request = envelope.request;
      } catch (cause) {
        const code = cause instanceof ProtocolError ? cause.code : "MALFORMED_REQUEST";
        reject(code, "Daemon request was rejected.");
        return;
      }

      decided = true;
      possiblyMutating = MUTATING_REQUEST_KINDS.includes(request.kind);
      diagnose({ event: "dispatched", code: request.kind });

      let response: DaemonResponseEnvelope;
      try {
        response = await options.handle(envelope);
      } catch {
        // The dispatcher threw. Do NOT invent a definite failure if the operation
        // may already have reached an external mutation: preserve ambiguity and
        // let the durable pending/claim state remain the authority.
        response = possiblyMutating
          ? transportResponse(
              "external_state_ambiguous",
              "OPERATION_OUTCOME_UNRECORDED",
              "The operation outcome could not be recorded; operator recovery is required.",
            )
          : transportResponse(
              "local_state_failure",
              "OPERATION_DISPATCH_FAILED",
              "The operation failed before any external mutation could begin.",
            );
      }
      respond(socket, response);
    }
  }

  return Object.freeze({
    socketPath,
    async start(): Promise<void> {
      if (started) {
        throw new DaemonServerError(
          "DAEMON_SERVER_ALREADY_STARTED",
          "The daemon server has already been started.",
        );
      }
      started = true;

      // Refuse to touch an existing path in ANY form: regular file, directory,
      // symlink or another server's socket. Stale-socket recovery belongs to the
      // deployment lifecycle, not to a generic unlink here.
      try {
        await lstat(socketPath);
        throw new DaemonServerError(
          "DAEMON_SOCKET_PATH_EXISTS",
          "Refusing to start: the socket path already exists.",
        );
      } catch (cause) {
        if (cause instanceof DaemonServerError) throw cause;
        if (!isErrno(cause, "ENOENT")) throw cause;
      }

      const parent = dirname(socketPath);
      const parentStat = await lstat(parent).catch((cause: unknown) => {
        if (isErrno(cause, "ENOENT")) {
          throw new DaemonServerError(
            "DAEMON_SOCKET_PARENT_INVALID",
            "The socket parent directory does not exist.",
          );
        }
        throw cause;
      });
      if (!parentStat.isDirectory()) {
        throw new DaemonServerError(
          "DAEMON_SOCKET_PARENT_INVALID",
          "The socket parent must be a real directory.",
        );
      }
      // A group/other-writable parent lets another user replace the socket.
      if ((parentStat.mode & 0o022) !== 0) {
        throw new DaemonServerError(
          "DAEMON_SOCKET_PARENT_INSECURE",
          "The socket parent directory must not be group- or other-writable.",
        );
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (cause: Error): void => {
          server.off("listening", onListening);
          reject(cause);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });

      // Never trust the mode Node created.
      await chmod(socketPath, socketMode);
      const bound = await lstat(socketPath);
      if (!bound.isSocket() || (bound.mode & 0o777) !== socketMode) {
        throw new DaemonServerError(
          "DAEMON_SOCKET_MODE_INVALID",
          "The bound socket did not have the required file type and mode.",
        );
      }
    },
    async close(): Promise<void> {
      if (!started || closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  });
}
