/**
 * Stage 4A.1 — playopsd lifecycle: in-flight tracking, drain, signals.
 *
 * Offline: a fake dispatcher stands in for the operations map so a signal can be
 * delivered while a "mutating" operation is deliberately still running. No
 * Google call, no /run or /var access, temp directories only.
 */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDrainController,
  createInFlightTracker,
  DAEMON_DRAINING_CODE,
  installShutdownSignals,
  type DrainScheduler,
  type DaemonLifecycleEvent,
} from "../src/daemon/lifecycle.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  encodeDaemonFrame,
  parseDaemonResponse,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { createDaemonServer } from "../src/daemon/server.js";

const roots: string[] = [];

function tempSocketDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-4a1-life-"));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function response(envelope: DaemonRequestEnvelope, summary: string): DaemonResponseEnvelope {
  return {
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: envelope.correlationId,
    outcome: "status",
    summary,
  };
}

/** A protocol-valid request for one kind; the fake dispatcher never mutates. */
function requestFor(kind: string): unknown {
  if (kind === "attach_notes") {
    return { kind, track: "production", versionCode: "1", locale: "en-US", noteText: "note" };
  }
  if (kind === "prepare_commit" || kind === "prepare_verify_committed") {
    return { kind, track: "production", versionCode: "1" };
  }
  if (kind.startsWith("execute_")) {
    // Canonical server-shaped request id and an 86-char base64url signature.
    return { kind, requestId: randomUUID(), signature: "A".repeat(86) };
  }
  return { kind };
}

function frame(request: unknown): Buffer {
  return encodeDaemonFrame(
    Buffer.from(
      JSON.stringify({
        protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
        correlationId: "stage-4a1-lifecycle",
        request,
      }),
      "utf8",
    ),
  );
}

/** Send one request and leave the promise unresolved until the response arrives. */
function send(socketPath: string, request: unknown): Promise<DaemonResponseEnvelope> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    socket.on("connect", () => socket.end(frame(request)));
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
    });
    socket.on("end", () => {
      try {
        resolve(parseDaemonResponse(JSON.parse(buffered.toString("utf8"))));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error("bad response"));
      }
    });
    socket.on("error", reject);
  });
}

function sendThenDisconnect(socketPath: string, request: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.on("connect", () => {
      socket.write(frame(request));
      // Half-close the write side so the server dispatches, then drop the client
      // entirely: an already-dispatched operation must not be cancelled.
      socket.end();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 5);
    });
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    setTimeout(() => reject(new Error("disconnect helper never connected")), 1_000);
  });
}

function recordingScheduler(): {
  readonly scheduler: DrainScheduler;
  readonly armed: number[];
  readonly cancelled: number[];
} {
  const armed: number[] = [];
  const cancelled: number[] = [];
  return {
    scheduler: {
      set: (_fn: () => void, ms: number) => {
        armed.push(ms);
        return { cancel: () => cancelled.push(ms) };
      },
    },
    armed,
    cancelled,
  };
}

interface Harness {
  readonly socketPath: string;
  readonly dispatched: string[];
  readonly completed: string[];
  readonly events: DaemonLifecycleEvent[];
  readonly tracker: ReturnType<typeof createInFlightTracker>;
  readonly server: ReturnType<typeof createDaemonServer>;
  release(kind: string): void;
  start(): Promise<void>;
}

async function harness(
  options: { readonly gateKinds: readonly string[] } = { gateKinds: [] },
): Promise<Harness> {
  const dir = tempSocketDir();
  const socketPath = join(dir, "playops.sock");
  const gates = new Map<string, Deferred<undefined>>();
  for (const kind of options.gateKinds) gates.set(kind, deferred<undefined>());
  const dispatched: string[] = [];
  const completed: string[] = [];
  const events: DaemonLifecycleEvent[] = [];
  const tracker = createInFlightTracker({ diagnostics: (event) => events.push(event) });
  const server = createDaemonServer({
    socketPath,
    socketMode: 0o600,
    handle: tracker.wrap(async (envelope) => {
      dispatched.push(envelope.request.kind);
      const gate = gates.get(envelope.request.kind);
      if (gate !== undefined) await gate.promise;
      completed.push(envelope.request.kind);
      return response(envelope, "ok");
    }),
  });
  return {
    socketPath,
    dispatched,
    completed,
    events,
    tracker,
    server,
    release: (kind) => gates.get(kind)?.resolve(undefined),
    start: () => server.start(),
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Evidence that the listener is no longer serving operations. Accepts either a
 * connection failure (listener closed) or the draining refusal; it only forbids
 * the operations map from serving a new operation.
 */
async function expectNotServing(socketPath: string): Promise<void> {
  const result = await send(socketPath, { kind: "status" }).then(
    (envelope) => (envelope.error?.code === DAEMON_DRAINING_CODE ? "refused" : "served"),
    () => "closed",
  );
  expect(result).not.toBe("served");
}

describe("stage 4A.1 in-flight tracking", () => {
  it("counts a dispatched operation and refuses new dispatch while draining", async () => {
    const test = await harness({ gateKinds: ["execute_commit"] });
    await test.start();
    const inFlight = send(test.socketPath, requestFor("execute_commit"));
    await waitFor(() => test.dispatched.length === 1, "first dispatch");
    expect(test.tracker.currentCount()).toBe(1);

    test.tracker.beginDraining();
    const refused = await send(test.socketPath, { kind: "status" });
    expect(refused.outcome).toBe("protocol_error");
    expect(refused.error?.code).toBe(DAEMON_DRAINING_CODE);
    // The refused request never reached the operations map.
    expect(test.dispatched).toEqual(["execute_commit"]);

    test.release("execute_commit");
    await inFlight;
    await test.tracker.whenIdle();
    expect(test.completed).toEqual(["execute_commit"]);
    expect(test.tracker.currentCount()).toBe(0);
    await test.server.close();
  });

  it("keeps a dispatched operation alive when the client disconnects", async () => {
    const test = await harness({ gateKinds: ["execute_commit"] });
    await test.start();
    await sendThenDisconnect(test.socketPath, requestFor("execute_commit"));
    await waitFor(() => test.dispatched.length === 1, "dispatch");
    // Client is gone; the operation is still tracked and still running.
    expect(test.tracker.currentCount()).toBe(1);
    expect(test.completed).toEqual([]);
    test.release("execute_commit");
    await test.tracker.whenIdle();
    expect(test.completed).toEqual(["execute_commit"]);
    await test.server.close();
  });
});

describe("stage 4A.1 drain and signals", () => {
  it.each(["SIGTERM", "SIGINT"])("shuts down cleanly with zero in-flight on %s", async (signal) => {
    const test = await harness();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await test.start();
    const { scheduler, armed, cancelled } = recordingScheduler();
    const drain = createDrainController({
      tracker: test.tracker,
      closeListener: () => test.server.close(),
      deadlineMs: 1_000,
      scheduler,
      diagnostics: (event) => test.events.push(event),
    });
    const binding = installShutdownSignals(drain, { target: process });
    binding.dispose();

    drain.handleSignal(signal);
    const outcome = await drain.whenStopped();
    expect(outcome.deadlineExceeded).toBe(false);
    expect(outcome.signal).toBe(signal);
    expect(armed).toEqual([1_000]);
    expect(cancelled).toEqual([1_000]);
    expect(exitSpy).not.toHaveBeenCalled();
    await expectNotServing(test.socketPath);
  });

  it.each([
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
  ])("waits for an in-flight %s operation before closing the listener", async (kind) => {
    const gated = kind === "status" ? [] : [kind];
    const test = await harness({ gateKinds: gated });
    await test.start();
    const request = requestFor(kind);
    const inFlight = send(test.socketPath, request).catch(() => undefined);
    await waitFor(() => test.dispatched.length === 1, "dispatch");

    const drain = createDrainController({
      tracker: test.tracker,
      closeListener: () => test.server.close(),
      deadlineMs: 5_000,
      diagnostics: (event) => test.events.push(event),
    });
    drain.handleSignal("SIGTERM");
    // Draining already: the listener is still open, the operation still running.
    expect(test.tracker.isDraining()).toBe(true);
    if (kind !== "status") expect(test.tracker.currentCount()).toBe(1);

    test.release(kind);
    const outcome = await drain.whenStopped();
    await inFlight;
    expect(outcome.deadlineExceeded).toBe(false);
    expect(test.tracker.currentCount()).toBe(0);
    await expectNotServing(test.socketPath);
  });

  it("warns on the drain deadline without killing the operation, then closes", async () => {
    const test = await harness({ gateKinds: ["execute_reconcile_commit"] });
    await test.start();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    let fireDeadline: (() => void) | undefined;
    const drain = createDrainController({
      tracker: test.tracker,
      closeListener: () => test.server.close(),
      deadlineMs: 25,
      scheduler: {
        set: (fn) => {
          fireDeadline = fn;
          return { cancel: () => (fireDeadline = undefined) };
        },
      },
      diagnostics: (event) => test.events.push(event),
    });
    const inFlight = send(test.socketPath, requestFor("execute_reconcile_commit")).catch(
      () => undefined,
    );
    await waitFor(() => test.dispatched.length === 1, "dispatch");

    drain.handleSignal("SIGTERM");
    fireDeadline?.();
    expect(test.events).toContain("daemon_drain_deadline_exceeded");
    // The operation was NOT cancelled and the listener is still open.
    expect(test.completed).toEqual([]);
    const whileDraining = await send(test.socketPath, { kind: "status" });
    expect(whileDraining.error?.code).toBe(DAEMON_DRAINING_CODE);
    expect(exitSpy).not.toHaveBeenCalled();

    test.release("execute_reconcile_commit");
    const outcome = await drain.whenStopped();
    await inFlight;
    expect(outcome.deadlineExceeded).toBe(true);
    expect(outcome.remainingInFlight).toBe(0);
    expect(test.completed).toEqual(["execute_reconcile_commit"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("ignores a second signal while a mutation is still running", async () => {
    const test = await harness({ gateKinds: ["execute_commit"] });
    await test.start();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const drain = createDrainController({
      tracker: test.tracker,
      closeListener: () => test.server.close(),
      deadlineMs: 5_000,
      diagnostics: (event) => test.events.push(event),
    });
    const binding = installShutdownSignals(drain, { target: process });
    const inFlight = send(test.socketPath, requestFor("execute_commit")).catch(() => undefined);
    await waitFor(() => test.dispatched.length === 1, "dispatch");

    process.emit("SIGTERM");
    await waitFor(() => test.events.includes("daemon_draining"), "draining");
    process.emit("SIGTERM");
    process.emit("SIGINT");
    expect(test.completed).toEqual([]);
    expect(test.tracker.currentCount()).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();

    test.release("execute_commit");
    await inFlight;
    const outcome = await drain.whenStopped();
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.deadlineExceeded).toBe(false);
    expect(test.completed).toEqual(["execute_commit"]);
    binding.dispose();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

it("still resolves shutdown when the listener close fails", async () => {
  const test = await harness();
  await test.start();
  const drain = createDrainController({
    tracker: test.tracker,
    closeListener: () => Promise.reject(new Error("listener close failed")),
    deadlineMs: 5_000,
    diagnostics: (event) => test.events.push(event),
  });
  drain.handleSignal("SIGTERM");
  const outcome = await drain.whenStopped();
  expect(outcome.closeFailed).toBe(true);
  expect(outcome.deadlineExceeded).toBe(false);
  expect(outcome.remainingInFlight).toBe(0);
  expect(test.events).toContain("daemon_stopped");
  await test.server.close();
});

it("ignores a throwing diagnostic sink instead of breaking dispatch or drain", async () => {
  const dir = tempSocketDir();
  const socketPath = join(dir, "playops.sock");
  const tracker = createInFlightTracker({
    diagnostics: () => {
      throw new Error("diagnostics sink is broken");
    },
  });
  const server = createDaemonServer({
    socketPath,
    socketMode: 0o600,
    handle: tracker.wrap(async (envelope) => response(envelope, "ok")),
  });
  await server.start();
  const answered = await send(socketPath, { kind: "status" });
  expect(answered.outcome).toBe("status");
  const drain = createDrainController({
    tracker,
    closeListener: () => server.close(),
    deadlineMs: 1_000,
    diagnostics: () => {
      throw new Error("diagnostics sink is broken");
    },
  });
  drain.handleSignal("SIGTERM");
  const outcome = await drain.whenStopped();
  expect(outcome.closeFailed).toBe(false);
  expect(outcome.deadlineExceeded).toBe(false);
});

describe("stage 4A.1 socket collision", () => {
  it.each(["file", "directory", "symlink", "socket"] as const)(
    "fails closed when the socket path exists as a %s and never unlinks it",
    async (form) => {
      const dir = tempSocketDir();
      const socketPath = join(dir, "playops.sock");
      if (form === "file") writeFileSync(socketPath, "");
      if (form === "directory") mkdirSync(socketPath);
      if (form === "symlink") {
        writeFileSync(join(dir, "target"), "");
        symlinkSync(join(dir, "target"), socketPath);
      }
      let liveSocketPath: string | undefined;
      if (form === "socket") {
        const liveServer = createDaemonServer({
          socketPath,
          socketMode: 0o600,
          handle: async (envelope) => response(envelope, "ok"),
        });
        await liveServer.start();
        liveSocketPath = socketPath;
      }

      const server = createDaemonServer({
        socketPath,
        socketMode: 0o600,
        handle: async (envelope) => response(envelope, "ok"),
      });
      await expect(server.start()).rejects.toMatchObject({ code: "DAEMON_SOCKET_PATH_EXISTS" });
      // The pre-existing path was not removed, replaced or recreated.
      const preserved = lstatSync(socketPath);
      expect(preserved.isSymbolicLink()).toBe(form === "symlink");
      expect(liveSocketPath === undefined || preserved.isSocket()).toBe(true);
    },
  );
});
