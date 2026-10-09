/**
 * Stage 3B — Unix-domain socket server core.
 *
 * Real: the socket, framing, framing validation, the dispatcher, the pending
 * store, exclusive claims, operator signature verification, executeOneTool,
 * runAgent, the production open-edit tool, its verifier and the managed-session
 * store. Fake: the Google gateway only. Offline; never touches /run/playops.
 *
 * Transport contract under test: one connection = one framed request = one
 * framed response, where the request is delimited by the client half-closing its
 * write side. Trailing or extra bytes are rejected BEFORE dispatch.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  createFilePendingOperationStore,
  type PendingOperationStore,
} from "../src/daemon/pending-store.js";
import {
  MAX_REQUEST_BYTES,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  encodeDaemonFrame,
  parseDaemonResponse,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { createDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import type { ReleaseEditGateway } from "../src/releases/gateway.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";

const PACKAGE = "com.example.release";
const EDIT_ID = "edit-socket";
const CORRELATION = "socket-corr";
const dirs: string[] = [];
const servers: DaemonServer[] = [];

function tempDir(mode = 0o700): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-server-"));
  chmodSync(dir, mode);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

interface ExchangeResult {
  readonly response?: DaemonResponseEnvelope;
  readonly raw: Buffer;
}

interface SendOptions {
  readonly halfClose?: boolean;
  readonly destroyAfterMs?: number;
}

/**
 * One connect -> write chunks -> (optionally half-close) -> collect -> close.
 * Always resolves; transport errors are surfaced as an empty result.
 */
async function exchangeOnce(
  socketPath: string,
  chunks: readonly Buffer[],
  options: SendOptions = {},
): Promise<ExchangeResult> {
  const halfClose = options.halfClose ?? true;
  return await new Promise<ExchangeResult>((resolve) => {
    const socket = createConnection(socketPath);
    const received: Buffer[] = [];
    let settled = false;
    const finalize = (): void => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(received);
      let response: DaemonResponseEnvelope | undefined;
      if (raw.byteLength > 0) {
        try {
          response = parseDaemonResponse(JSON.parse(raw.toString("utf8")) as unknown);
        } catch {
          response = undefined;
        }
      }
      socket.destroy();
      resolve(raw.byteLength === 0 ? { raw } : { raw, response });
    };
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      if (halfClose) socket.end();
      if (options.destroyAfterMs !== undefined) {
        setTimeout(() => socket.destroy(), options.destroyAfterMs);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
    });
    socket.on("error", () => undefined);
    socket.on("close", finalize);
    setTimeout(finalize, 3_000);
  });
}

interface ServerHarness {
  readonly dir: string;
  readonly socketPath: string;
  readonly dispatchedKinds: string[];
  readonly createEdit: Mock;
  readonly getEdit: Mock;
  readonly listTracks: Mock;
  readonly pendingStore: PendingOperationStore;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly privateKey: KeyObject;
  start(): Promise<void>;
  close(): Promise<void>;
  frame(request: unknown): Buffer;
  sign(canonicalPayload: string): string;
  send(chunks: readonly Buffer[], options?: SendOptions): Promise<ExchangeResult>;
  call(request: unknown): Promise<DaemonResponseEnvelope>;
}

interface HarnessOptions {
  readonly deferStart?: boolean;
  readonly createEditDelayMs?: number;
  readonly socketDirMode?: number;
  readonly requestTimeoutMs?: number;
}

async function buildServerHarness(options: HarnessOptions = {}): Promise<ServerHarness> {
  const dir = tempDir(options.socketDirMode ?? 0o700);
  const socketPath = join(dir, "playops.sock");
  const dispatchedKinds: string[] = [];
  // Dedicated root: the store's `list()` parses every *.json it finds, so the
  // pending store must not share a directory with the managed-session file.
  const pendingRoot = join(dir, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const pendingStore = createFilePendingOperationStore(pendingRoot);
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: PACKAGE,
  });
  const delay = options.createEditDelayMs ?? 0;
  const createEdit = vi.fn(async () => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return { packageName: PACKAGE, editId: EDIT_ID, expiryTimeSeconds: "1900000000" };
  });
  const getEdit = vi.fn(async () => ({ id: EDIT_ID, expiryTimeSeconds: "1900000000" }));
  const listTracks = vi.fn(async () => []);
  const gateway: ReleaseEditGateway = { createEdit, getEdit, listTracks };
  const built = createReleaseEditOpenTool({ packageName: PACKAGE, gateway, store: sessionStore });
  const registry = new ToolRegistry();
  registry.register(built.tool);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const operations = createDaemonOperations({
    packageName: PACKAGE,
    pendingStore,
    claimRoot: join(dir, "claims"),
    packageOperations: createPackageOperationSingleFlightCoordinator(),
    registry,
    openEdit: { binding: built.binding, input: {} },
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "socket-test-anchor"),
    ledger: createFileAgentLedger(join(dir, "agent.jsonl")),
    approvalLedger: createFileApprovalLedger(join(dir, "approval.jsonl")),
    verificationLedger: createFileVerificationLedger(join(dir, "verification.jsonl")),
  });

  const server = createDaemonServer({
    socketPath,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    handle: async (envelope) => {
      dispatchedKinds.push(envelope.request.kind);
      return operations.handle(envelope);
    },
  });
  servers.push(server);

  const frame = (request: unknown): Buffer =>
    encodeDaemonFrame(
      Buffer.from(
        JSON.stringify({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          request,
        }),
        "utf8",
      ),
    );

  const send = (chunks: readonly Buffer[], sendOptions?: SendOptions): Promise<ExchangeResult> =>
    exchangeOnce(socketPath, chunks, sendOptions ?? {});

  const start = async (): Promise<void> => {
    await server.start();
  };
  if (options.deferStart !== true) await start();

  return {
    dir,
    socketPath,
    dispatchedKinds,
    createEdit,
    getEdit,
    listTracks,
    pendingStore,
    sessionStore,
    privateKey,
    start,
    close: async (): Promise<void> => {
      await server.close();
    },
    frame,
    sign: (canonicalPayload: string): string =>
      sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey).toString("base64url"),
    send,
    call: async (request: unknown): Promise<DaemonResponseEnvelope> => {
      const result = await send([frame(request)]);
      if (result.response === undefined) throw new Error("no daemon response received");
      return result.response;
    },
  };
}

async function prepareOverSocket(
  harness: ServerHarness,
): Promise<{ requestId: string; canonicalPayload: string }> {
  const prepared = await harness.call({ kind: "prepare_open_edit" });
  expect(prepared.outcome).toBe("approval_required");
  const approval = prepared.approval;
  if (approval === undefined) throw new Error("prepare returned no challenge");
  return { requestId: approval.requestId, canonicalPayload: approval.canonicalPayload };
}

describe("daemon server: socket path and mode", () => {
  it("binds a private socket inside the test directory", async () => {
    const harness = await buildServerHarness();
    const stat = lstatSync(harness.socketPath);
    expect(stat.isSocket()).toBe(true);
    // Never relies on Node's default socket mode.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("fails closed when the socket path already exists as a regular file", async () => {
    const harness = await buildServerHarness({ deferStart: true });
    writeFileSync(harness.socketPath, "not a socket\n", { mode: 0o600 });
    await expect(harness.start()).rejects.toThrow(/already exists/u);
    expect(lstatSync(harness.socketPath).isFile()).toBe(true);
  });

  it("never removes or follows an existing symlink", async () => {
    const harness = await buildServerHarness({ deferStart: true });
    const target = join(harness.dir, "target.txt");
    writeFileSync(target, "important\n", { mode: 0o600 });
    symlinkSync(target, harness.socketPath);
    await expect(harness.start()).rejects.toThrow(/already exists/u);
    expect(lstatSync(harness.socketPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(target).isFile()).toBe(true);
  });

  it("fails closed when the socket path already exists as a directory", async () => {
    const harness = await buildServerHarness({ deferStart: true });
    mkdirSync(harness.socketPath);
    await expect(harness.start()).rejects.toThrow(/already exists/u);
    expect(lstatSync(harness.socketPath).isDirectory()).toBe(true);
  });

  it("refuses a group- or other-writable parent directory", async () => {
    const harness = await buildServerHarness({ deferStart: true, socketDirMode: 0o777 });
    await expect(harness.start()).rejects.toThrow(/writable/u);
  });
});

describe("daemon server: status over the socket", () => {
  it("round-trips a status request without executing anything", async () => {
    const harness = await buildServerHarness();
    const response = await harness.call({ kind: "status" });

    expect(response.outcome).toBe("status");
    expect(response.protocolVersion).toBe(4);
    expect(response.summary).toContain("protocolVersion=4");
    expect(response.summary).toContain(`configuredPackage=${PACKAGE}`);
    expect(harness.dispatchedKinds).toEqual(["status"]);
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.getEdit).not.toHaveBeenCalled();
  });
});

describe("daemon server: open-edit over the socket", () => {
  it("prepares an approval challenge with zero Google calls", async () => {
    const harness = await buildServerHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);

    expect(canonicalPayload.length).toBeGreaterThan(0);
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.dispatchedKinds).toEqual(["prepare_open_edit"]);
  });

  it("executes end-to-end over a fresh socket", async () => {
    const harness = await buildServerHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);

    const executed = await harness.call({
      kind: "execute_open_edit",
      requestId,
      signature: harness.sign(canonicalPayload),
    });

    expect(executed.outcome).toBe("success");
    expect(harness.createEdit).toHaveBeenCalledTimes(1);
    expect(harness.dispatchedKinds).toEqual(["prepare_open_edit", "execute_open_edit"]);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    expect((await harness.sessionStore.load())?.editId).toBe(EDIT_ID);
  });

  it("still requires a genuine signature: socket access is not authorization", async () => {
    const harness = await buildServerHarness();
    const { requestId } = await prepareOverSocket(harness);

    const denied = await harness.call({
      kind: "execute_open_edit",
      requestId,
      signature: "c2ln",
    });

    expect(denied.outcome).toBe("approval_mismatch");
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
  });

  it("bounds concurrent socket clients to at most one mutation", async () => {
    const harness = await buildServerHarness({ createEditDelayMs: 25 });
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);
    const signature = harness.sign(canonicalPayload);

    const [first, second] = await Promise.all([
      harness.call({ kind: "execute_open_edit", requestId, signature }),
      harness.call({ kind: "execute_open_edit", requestId, signature }),
    ]);
    const outcomes = [first.outcome, second.outcome];

    expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1);
    // The package lease is acquired before the per-request claim (Stage 3E.2D),
    // so a concurrent same-request loser is refused as `operation_in_progress`.
    expect(["operation_in_progress", "request_claim_held", "request_already_consumed"]).toContain(
      outcomes.find((outcome) => outcome !== "success"),
    );
    expect(harness.createEdit).toHaveBeenCalledTimes(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
  });
});

describe("daemon server: framing validation happens before dispatch", () => {
  it("reassembles a request split across arbitrary chunks", async () => {
    const harness = await buildServerHarness();
    const frame = harness.frame({ kind: "status" });

    const result = await harness.send([
      frame.subarray(0, 2),
      frame.subarray(2, 4),
      frame.subarray(4, 6),
      frame.subarray(6),
    ]);

    expect(result.response?.outcome).toBe("status");
    expect(harness.dispatchedKinds).toEqual(["status"]);
  });

  it("rejects an over-bound declared length without waiting for the payload", async () => {
    const harness = await buildServerHarness();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_REQUEST_BYTES + 1, 0);

    const result = await harness.send([header]);

    expect(result.response?.error?.code).toBe("REQUEST_TOO_LARGE");
    expect(harness.dispatchedKinds).toEqual([]);
  });

  it("rejects trailing junk after a valid mutating request with zero mutation", async () => {
    const harness = await buildServerHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);
    const valid = harness.frame({
      kind: "execute_open_edit",
      requestId,
      signature: harness.sign(canonicalPayload),
    });

    const result = await harness.send([valid, Buffer.from("JUNK", "utf8")]);

    expect(result.response?.outcome).toBe("protocol_error");
    expect(harness.createEdit).not.toHaveBeenCalled();
    // Never dispatched, so the request is still PENDING with no claim.
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(harness.dispatchedKinds).toEqual(["prepare_open_edit"]);
  });

  it("rejects two concatenated valid frames with zero mutation", async () => {
    const harness = await buildServerHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);
    const valid = harness.frame({
      kind: "execute_open_edit",
      requestId,
      signature: harness.sign(canonicalPayload),
    });

    const result = await harness.send([valid, valid]);

    expect(result.response?.outcome).toBe("protocol_error");
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(harness.dispatchedKinds).toEqual(["prepare_open_edit"]);
  });

  it("rejects a truncated frame", async () => {
    const harness = await buildServerHarness();
    const frame = harness.frame({ kind: "status" });

    const result = await harness.send([frame.subarray(0, frame.byteLength - 5)]);

    expect(result.response?.outcome).toBe("protocol_error");
    expect(harness.dispatchedKinds).toEqual([]);
  });

  it("rejects an empty request without dispatching", async () => {
    const harness = await buildServerHarness();
    const result = await harness.send([Buffer.alloc(0)]);
    expect(result.response?.outcome).toBe("protocol_error");
    expect(harness.dispatchedKinds).toEqual([]);
  });

  it("never exposes a stack trace, module path or absolute path in an error", async () => {
    const harness = await buildServerHarness();
    const result = await harness.send([encodeDaemonFrame(Buffer.from("{not json", "utf8"))]);
    const serialized = result.raw.toString("utf8");

    expect(result.response?.outcome).toBe("protocol_error");
    expect(serialized).not.toContain(harness.dir);
    expect(serialized).not.toContain("node_modules");
    expect(serialized).not.toContain(".ts:");
    expect(serialized).not.toContain("Error:");
  });
});

describe("daemon server: bounded reads and lifecycle", () => {
  it("times out a client that sends nothing, with zero dispatch", async () => {
    const harness = await buildServerHarness({ requestTimeoutMs: 150 });
    const result = await harness.send([], { halfClose: false });
    expect(result.raw.byteLength).toBe(0);
    expect(harness.dispatchedKinds).toEqual([]);
    expect(harness.createEdit).not.toHaveBeenCalled();
  });

  it("times out a client that sends only a length prefix, with zero dispatch", async () => {
    const harness = await buildServerHarness({ requestTimeoutMs: 150 });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(40, 0);

    const result = await harness.send([header], { halfClose: false });

    expect(result.raw.byteLength).toBe(0);
    expect(harness.dispatchedKinds).toEqual([]);
  });

  it("completes a dispatched operation even if the client disconnects", async () => {
    const harness = await buildServerHarness({ createEditDelayMs: 200 });
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);

    // Half-close so the server dispatches, then vanish mid-mutation.
    const result = await harness.send(
      [
        harness.frame({
          kind: "execute_open_edit",
          requestId,
          signature: harness.sign(canonicalPayload),
        }),
      ],
      { destroyAfterMs: 60 },
    );
    expect(result.raw.byteLength).toBe(0);

    // The operation lifecycle is daemon-owned: it must finish on its own.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.createEdit).toHaveBeenCalledTimes(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    expect((await harness.sessionStore.load())?.editId).toBe(EDIT_ID);
  });

  it("closing the server stops accepting and preserves durable state", async () => {
    const harness = await buildServerHarness();
    const { requestId } = await prepareOverSocket(harness);

    await harness.close();

    // Nothing durable was released or deleted.
    expect(await harness.pendingStore.state(requestId)).toBe("pending");

    // New connections are refused and the dispatcher is not invoked again.
    const result = await harness.send([harness.frame({ kind: "status" })]);
    expect(result.response).toBeUndefined();
    expect(harness.dispatchedKinds).toEqual(["prepare_open_edit"]);
  });
});
