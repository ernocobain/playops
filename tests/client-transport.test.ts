/**
 * Client transport framing, fail-closed read, and no-retry guarantees.
 *
 * The stub server is a real AF_UNIX socket so framing, half-close and EOF
 * behaviour are exercised end-to-end. No Google call and no production socket.
 */
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Socket as NetSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  PRODUCTION_OPERATOR_SOCKET_PATH,
  isMutatingRequest,
  sendDaemonRequest,
} from "../src/client/transport.js";
import { PLAYOPS_DAEMON_PROTOCOL_VERSION } from "../src/daemon/protocol.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-client-transport-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Stub {
  readonly socketPath: string;
  readonly state: { connections: number; requests: Buffer[] };
  close(): Promise<void>;
}

async function startStub(onRequest: (raw: Buffer, socket: Socket) => void): Promise<Stub> {
  const socketPath = join(tempDir(), "stub.sock");
  const state = { connections: 0, requests: [] as Buffer[] };
  const server: Server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    state.connections += 1;
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      state.requests.push(raw);
      onRequest(raw, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function response(socket: Socket, body: string): void {
  socket.write(Buffer.from(body, "utf8"));
  socket.end();
}

function envelope(outcome: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: "corr",
    outcome,
    ...extra,
  });
}

function decodeRequest(raw: Buffer): {
  length: number;
  total: number;
  envelope: Record<string, unknown>;
} {
  const length = raw.readUInt32BE(0);
  return {
    length,
    total: raw.byteLength,
    envelope: JSON.parse(raw.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>,
  };
}

describe("client transport", () => {
  it("pins the production endpoint and classifies mutating kinds", () => {
    expect(PRODUCTION_OPERATOR_SOCKET_PATH).toBe("/run/playops/playops.sock");
    expect(CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(isMutatingRequest("execute_commit")).toBe(true);
    expect(isMutatingRequest("attach_notes")).toBe(true);
    expect(isMutatingRequest("prepare_commit")).toBe(false);
    expect(isMutatingRequest("status")).toBe(false);
  });

  it.each([
    { kind: "prepare_open_edit" },
    { kind: "prepare_commit", track: "internal", versionCode: "1" },
    { kind: "prepare_verify_committed", track: "internal", versionCode: "1" },
    { kind: "prepare_reconcile_commit" },
  ] as const)(
    "reports lost $kind response as unknown LOCAL outcome without replay",
    async (request) => {
      const stub = await startStub((_raw, socket) => socket.destroy());
      const result = await sendDaemonRequest({ socketPath: stub.socketPath, request });
      await stub.close();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.possibleDispatch).toBe(true);
        expect(result.failure.exitCode).toBe(2);
      }
      expect(stub.state.requests).toHaveLength(1);
      expect(stub.state.connections).toBe(1);
    },
  );

  it("reports an abort after dispatch as outcome unknown, settles once and never replays", async () => {
    const controller = new AbortController();
    const stub = await startStub((_raw, socket) => {
      controller.abort();
      // The daemon can still settle after the client stops waiting.
      setTimeout(() => response(socket, envelope("success")), 20);
    });
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "execute_commit", requestId: "x", signature: "y" },
      signal: controller.signal,
    } as Parameters<typeof sendDaemonRequest>[0]);
    await stub.close();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("interrupted");
      expect(result.failure.possibleDispatch).toBe(true);
      expect(result.failure.exitCode).toBe(2);
    }
    expect(stub.state.connections).toBe(1);
    expect(stub.state.requests).toHaveLength(1);
  });

  it("refuses a pre-aborted request before connecting (zero dispatch)", async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = await startStub((_raw, socket) => response(socket, envelope("success")));
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "prepare_open_edit" },
      signal: controller.signal,
    } as Parameters<typeof sendDaemonRequest>[0]);
    await stub.close();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("interrupted");
      expect(result.failure.possibleDispatch).toBe(false);
      expect(result.failure.exitCode).toBe(1);
    }
    expect(stub.state.connections).toBe(0);
  });

  it.each([
    { correlationId: 7 },
    { correlationId: "" },
    { summary: { misleading: "success" } },
    { error: { code: 7, message: "failure" } },
    { error: { code: "X", message: false } },
    { error: { code: "X", message: "failure", extra: true } },
  ])("rejects malformed response fields after dispatch (%j)", async (extra) => {
    const stub = await startStub((_raw, socket) => response(socket, envelope("success", extra)));
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "prepare_open_edit" },
    });
    await stub.close();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("malformed_response");
      expect(result.failure.exitCode).toBe(2);
      expect(result.failure.possibleDispatch).toBe(true);
    }
  });

  it("rejects invalid UTF-8 response bytes instead of accepting replacement characters", async () => {
    const stub = await startStub((_raw, socket) => {
      socket.end(
        Buffer.concat([
          Buffer.from(
            '{"protocolVersion":5,"correlationId":"corr","outcome":"success","summary":"',
          ),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
      );
    });
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "prepare_open_edit" },
    });
    await stub.close();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("malformed_response");
      expect(result.failure.exitCode).toBe(2);
    }
  });

  it("reports attach_notes response loss with exactly one unsigned-write dispatch", async () => {
    let dispatches = 0;
    const stub = await startStub((_raw, socket) => {
      dispatches++;
      socket.destroy();
    });
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: {
        kind: "attach_notes",
        track: "internal",
        versionCode: "42",
        locale: "en-US",
        noteText: "Synthetic notes",
      },
    });
    await stub.close();
    expect(dispatches).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.possibleDispatch).toBe(true);
      expect(result.failure.exitCode).toBe(2);
    }
  });

  it("frames a 4-byte big-endian length + JSON payload and half-closes (one request)", async () => {
    const stub = await startStub((_raw, socket) =>
      response(socket, envelope("status", { summary: "ok" })),
    );
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "status" },
      correlationId: "corr",
    });
    await stub.close();

    expect(result.ok).toBe(true);
    expect(stub.state.connections).toBe(1);
    const { length, envelope: parsed } = decodeRequest(stub.state.requests[0] as Buffer);
    expect(length).toBeGreaterThan(0);
    expect(parsed.protocolVersion).toBe(PLAYOPS_DAEMON_PROTOCOL_VERSION);
    expect(parsed.correlationId).toBe("corr");
    expect(parsed.request).toEqual({ kind: "status" });
  });

  it("fails closed when the response exceeds MAX_RESPONSE_BYTES", async () => {
    const stub = await startStub((_raw, socket) => {
      socket.write(Buffer.alloc(300 * 1024, 0x61));
      socket.end();
    });
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "execute_commit", requestId: "x", signature: "y" },
    });
    await stub.close();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("response_too_large");
      expect(result.failure.possibleDispatch).toBe(true);
      expect(result.failure.exitCode).toBe(2);
    }
  });

  it("reports malformed JSON as an unknown mutation outcome after dispatch", async () => {
    const stub = await startStub((_raw, socket) => response(socket, "this is not json"));
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: {
        kind: "attach_notes",
        track: "internal",
        versionCode: "1",
        locale: "en-US",
        noteText: "x",
      },
    });
    await stub.close();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("malformed_response");
      expect(result.failure.exitCode).toBe(2);
    }
  });

  it("fails closed on an unknown outcome (R1 closed-set check)", async () => {
    const stub = await startStub((_raw, socket) =>
      response(socket, envelope("totally_unknown_outcome")),
    );
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "execute_commit", requestId: "x", signature: "y" },
    });
    const readOnly = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: { kind: "status" },
    });
    await stub.close();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("unknown_outcome");
      expect(result.failure.exitCode).toBe(2);
    }
    expect(readOnly.ok).toBe(false);
    if (!readOnly.ok) {
      expect(readOnly.failure.kind).toBe("unknown_outcome");
      expect(readOnly.failure.exitCode).toBe(1);
    }
  });

  it("reports a missing socket and a stale socket file as connect failures (exit 1, zero mutation)", async () => {
    const missing = await sendDaemonRequest({
      socketPath: join(tempDir(), "absent.sock"),
      request: { kind: "execute_commit", requestId: "x", signature: "y" },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.failure.kind).toBe("connect_failure");
      expect(missing.failure.exitCode).toBe(1);
      expect(missing.failure.possibleDispatch).toBe(false);
    }

    const stalePath = join(tempDir(), "stale.sock");
    writeFileSync(stalePath, "not a socket");
    const stale = await sendDaemonRequest({
      socketPath: stalePath,
      request: { kind: "execute_commit", requestId: "x", signature: "y" },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.failure.kind).toBe("connect_failure");
      expect(stale.failure.exitCode).toBe(1);
    }
  });

  it("rejects an over-limit request locally with ZERO connection attempts", async () => {
    const stub = await startStub((_raw, socket) => response(socket, envelope("status")));
    const result = await sendDaemonRequest({
      socketPath: stub.socketPath,
      request: {
        kind: "attach_notes",
        track: "internal",
        versionCode: "1",
        locale: "en-US",
        noteText: "a".repeat(70 * 1024),
      },
    });
    await stub.close();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("request_too_large");
      expect(result.failure.exitCode).toBe(1);
    }
    // No connection was ever attempted for the rejected local request.
    expect(stub.state.connections).toBe(0);
  });

  it("times out a connect that never completes", async () => {
    const fake = new NetSocket();
    const result = await sendDaemonRequest({
      socketPath: "/nonexistent/never.sock",
      request: { kind: "status" },
      connectTimeoutMs: 20,
      connect: () => fake,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("connect_timeout");
      expect(result.failure.exitCode).toBe(1);
    }
  });

  it("never retries: exactly one connection per command, even on a post-dispatch disconnect", async () => {
    // Healthy command: one connection.
    const healthy = await startStub((_raw, socket) =>
      response(socket, envelope("status", { summary: "s" })),
    );
    await sendDaemonRequest({ socketPath: healthy.socketPath, request: { kind: "status" } });
    await healthy.close();
    expect(healthy.state.connections).toBe(1);

    // Disconnect after dispatch with no response: exactly one connection, exit 2.
    const drop = await startStub((_raw, socket) => {
      socket.destroy();
    });
    const result = await sendDaemonRequest({
      socketPath: drop.socketPath,
      request: { kind: "execute_commit", requestId: "x", signature: "y" },
    });
    await drop.close();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("malformed_response");
      expect(result.failure.exitCode).toBe(2);
    }
    expect(drop.state.connections).toBe(1);
  });
});
