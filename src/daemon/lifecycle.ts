/**
 * Stage 4A.1 — playopsd application lifecycle (in-flight tracking, drain, signals).
 *
 * SCOPE AND WHY THIS MODULE EXISTS
 * ================================
 * The daemon core deliberately owns no graceful-shutdown semantics: `close()`
 * stops the listener and drops live sockets, it never touches durable state, and
 * an already-dispatched operation keeps running inside its own durable
 * lifecycle (see `daemon/server.ts`). The released core also installs no signal
 * handler at all. A production bootstrap therefore has to own three things
 * WITHOUT changing any core semantics:
 *
 *   1. counting every dispatched operation so shutdown can wait for it,
 *   2. gating NEW dispatch once draining starts, and
 *   3. closing the listener only after the running count reaches zero.
 *
 * INVARIANTS THIS MODULE HOLDS
 * ============================
 *   - A draining gate refuses new dispatch BEFORE it reaches the operations map,
 *     using the same pre-dispatch refusal vocabulary the core already uses for
 *     its own transport-level refusals (`protocol_error` + a stable code).
 *   - `whenIdle()` resolves only when every tracked operation promise has
 *     settled. Nothing here cancels, force-completes, times out, or rejects an
 *     in-flight operation: durable authority stays with the operation-specific
 *     stores (pending record, request claim, journals, write intent).
 *   - The drain deadline is a WARNING/DEADLINE-EXCEEDED signal only. Expiry never
 *     kills an operation; the controller keeps waiting and reports a truthful
 *     non-zero shutdown status. A hard kill remains the service manager's job
 *     (`TimeoutStopSec`), never application code.
 *   - A second SIGTERM/SIGINT is never permission to shorten an in-flight
 *     mutation: it only re-emits an already-draining diagnostic.
 *
 * This module is pure application logic: no filesystem, no network, no timer
 * unless a deadline is armed, and no `process.exit` anywhere.
 */
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
} from "./protocol.js";

/** Stable refusal code for a request refused only because the daemon is draining. */
export const DAEMON_DRAINING_CODE = "DAEMON_DRAINING" as const;

/** Lifecycle diagnostics. Never carries payloads, identities or credentials. */
export type DaemonLifecycleEvent =
  | "daemon_starting"
  | "daemon_listening"
  | "daemon_draining"
  | "daemon_drain_waiting"
  | "daemon_drain_deadline_exceeded"
  | "daemon_stopped"
  | "daemon_startup_failed";

export type DaemonDiagnosticSink = (event: DaemonLifecycleEvent, detail?: string) => void;

/**
 * A pre-dispatch refusal for a request received after draining began. It mirrors
 * the core's own pre-dispatch refusals (`protocol_error` + a stable code): the
 * request was never dispatched, so no mutation can have started.
 */
export function daemonDrainingResponse(envelope: DaemonRequestEnvelope): DaemonResponseEnvelope {
  return Object.freeze({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: envelope.correlationId,
    outcome: "protocol_error" as const,
    error: Object.freeze({
      code: DAEMON_DRAINING_CODE,
      message: "The daemon is shutting down; the request was not dispatched and no mutation began.",
    }),
  });
}

export interface InFlightTrackerOptions {
  readonly diagnostics?: DaemonDiagnosticSink;
}

export interface InFlightTracker {
  /**
   * Wrap the daemon dispatcher: the operation is registered BEFORE dispatch,
   * removed in `finally`, and its promise is never left unhandled. Once draining
   * has begun, new requests are refused before reaching `handler`.
   */
  wrap(
    handler: (envelope: DaemonRequestEnvelope) => Promise<DaemonResponseEnvelope>,
  ): (envelope: DaemonRequestEnvelope) => Promise<DaemonResponseEnvelope>;
  /** Number of dispatched operations that have not settled yet. Diagnostics. */
  currentCount(): number;
  isDraining(): boolean;
  /** Idempotent. After this call every NEW request is refused pre-dispatch. */
  beginDraining(): void;
  /** Resolves once the running count is zero (immediately when already zero). */
  whenIdle(): Promise<void>;
}

export function createInFlightTracker(options: InFlightTrackerOptions = {}): InFlightTracker {
  /** Opaque per-dispatch tokens. Only the count matters; nothing awaits them here. */
  const running = new Set<object>();
  const idleWaiters: (() => void)[] = [];
  let draining = false;

  /** A broken diagnostic sink must never break dispatch or shutdown. */
  const emit = (event: DaemonLifecycleEvent, detail?: string): void => {
    try {
      if (detail === undefined) options.diagnostics?.(event);
      else options.diagnostics?.(event, detail);
    } catch {
      /* diagnostics are best-effort; never a control-flow input */
    }
  };

  const settleIfIdle = (): void => {
    if (running.size > 0) return;
    const waiters = idleWaiters.splice(0);
    for (const waiter of waiters) waiter();
  };

  const wrap: InFlightTracker["wrap"] =
    (handler) =>
    (envelope: DaemonRequestEnvelope): Promise<DaemonResponseEnvelope> => {
      if (draining) return Promise.resolve(daemonDrainingResponse(envelope));
      const token: object = {};
      running.add(token);
      // The returned promise is the dispatcher's own promise: the caller still
      // observes the real response or the real rejection.
      const tracked: Promise<DaemonResponseEnvelope> = (async () => {
        try {
          return await handler(envelope);
        } finally {
          running.delete(token);
          settleIfIdle();
        }
      })();
      // Never let a rejected dispatch become an unhandled rejection: the caller
      // still receives the original promise and its rejection.
      void tracked.catch(() => undefined);
      return tracked;
    };

  return Object.freeze({
    wrap,
    currentCount: () => running.size,
    isDraining: () => draining,
    beginDraining: () => {
      if (draining) return;
      draining = true;
      emit("daemon_draining", "no-new-dispatch");
    },
    whenIdle: () =>
      running.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          }),
  });
}

/** Injectable timer so the deadline path is testable without real waiting. */
export interface DrainTimer {
  readonly cancel: () => void;
}

export interface DrainScheduler {
  set(fn: () => void, ms: number): DrainTimer;
}

export interface DrainOutcome {
  /** True when the deadline elapsed while operations were still running. */
  readonly deadlineExceeded: boolean;
  /**
   * True when the listener could not be closed cleanly. The in-flight count had
   * already reached zero, so this is a shutdown-health signal, never a reason to
   * abandon a running operation.
   */
  readonly closeFailed: boolean;
  /** The first signal that started the shutdown. */
  readonly signal: string;
  /** Running count observed when shutdown completed (normally 0). */
  readonly remainingInFlight: number;
}

export interface DrainControllerOptions {
  readonly tracker: InFlightTracker;
  /** Closes the listener. Called ONLY after the running count reached zero. */
  readonly closeListener: () => Promise<void>;
  readonly diagnostics?: DaemonDiagnosticSink;
  /** Bootstrap-owned warning deadline. Expiry never kills an operation. */
  readonly deadlineMs: number;
  readonly scheduler?: DrainScheduler;
  readonly now?: () => Date;
}

export interface DrainController {
  /**
   * First call starts the single shutdown lifecycle; later calls (e.g. a second
   * SIGTERM) only re-emit an already-draining diagnostic and never start a
   * second lifecycle, never cancel an operation, and never exit the process.
   */
  handleSignal(signal: string): void;
  /** Shared shutdown promise; settles once the listener has been closed. */
  whenStopped(): Promise<DrainOutcome>;
  isDraining(): boolean;
}

const DEFAULT_SCHEDULER: DrainScheduler = Object.freeze({
  set(fn: () => void, ms: number): DrainTimer {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
});

export function createDrainController(options: DrainControllerOptions): DrainController {
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  let started = false;
  let firstSignal: string | undefined;
  let deadlineExceeded = false;
  let closeFailed = false;
  let resolveStopped: (outcome: DrainOutcome) => void = () => undefined;
  const stopped = new Promise<DrainOutcome>((resolve) => {
    resolveStopped = resolve;
  });

  const emit = (event: DaemonLifecycleEvent, detail?: string): void => {
    try {
      if (detail === undefined) options.diagnostics?.(event);
      else options.diagnostics?.(event, detail);
    } catch {
      /* diagnostics are best-effort; never a control-flow input */
    }
  };

  const start = (signal: string): void => {
    firstSignal ??= signal;
    if (started) {
      // A repeat signal is NOT permission to shorten an in-flight mutation.
      emit("daemon_drain_waiting", "already-draining");
      return;
    }
    started = true;
    options.tracker.beginDraining();
    emit("daemon_drain_waiting", "awaiting-in-flight-operations");
    const timer = scheduler.set(() => {
      deadlineExceeded = true;
      emit("daemon_drain_deadline_exceeded", "still-waiting");
    }, options.deadlineMs);
    void (async () => {
      try {
        await options.tracker.whenIdle();
      } finally {
        timer.cancel();
      }
      // A failing close must not hang the shutdown promise: the in-flight count
      // is already zero, so the honest outcome is "closed with an error".
      try {
        await options.closeListener();
      } catch {
        closeFailed = true;
      }
      const outcome: DrainOutcome = Object.freeze({
        deadlineExceeded,
        closeFailed,
        signal: firstSignal ?? signal,
        remainingInFlight: options.tracker.currentCount(),
      });
      emit(
        "daemon_stopped",
        closeFailed ? "close-failed" : deadlineExceeded ? "deadline-exceeded" : "clean",
      );
      resolveStopped(outcome);
    })();
  };

  return Object.freeze({
    handleSignal: start,
    whenStopped: () => stopped,
    isDraining: () => started,
  });
}

/** Minimal process-like signal source; `process` satisfies it. */
export interface SignalSource {
  on(signal: string, listener: () => void): unknown;
  off(signal: string, listener: () => void): unknown;
}

export interface ShutdownSignalBinding {
  /** Removes both handlers. Safe to call more than once. */
  dispose(): void;
}

/**
 * Install SIGTERM/SIGINT handlers that start the drain lifecycle. No handler
 * here — first or second — calls `process.exit`: the process ends only after the
 * drain promise settles, which happens after every in-flight operation does.
 */
export function installShutdownSignals(
  controller: DrainController,
  options: { readonly target?: SignalSource } = {},
): ShutdownSignalBinding {
  const target = options.target ?? (process as unknown as SignalSource);
  const onTerm = (): void => controller.handleSignal("SIGTERM");
  const onInt = (): void => controller.handleSignal("SIGINT");
  target.on("SIGTERM", onTerm);
  target.on("SIGINT", onInt);
  let disposed = false;
  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      target.off("SIGTERM", onTerm);
      target.off("SIGINT", onInt);
    },
  });
}
