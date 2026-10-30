/**
 * `daemon` command group: hierarchy/arg validation, exit-code mapping, --json
 * shape, help surface, absence of a raw command, and config isolation.
 */
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaemonCliError,
  parseDaemonCommand,
  runDaemonCli,
  type DaemonCliIo,
} from "../src/cli/daemon.js";
import { runCli } from "../src/cli/main.js";
import { runCliWithLogging } from "../src/cli/logging.js";
import { PRODUCTION_OPERATOR_SOCKET_PATH } from "../src/client/transport.js";
import {
  approvalStatementDigest,
  parseApprovalStatementCanonical,
} from "../src/approvals/statement.js";
import { approvalChallengeFor } from "../src/daemon/pending-view.js";
import { createReleaseEditOpenStatement } from "../src/releases/open-tool.js";
import { PLAYOPS_DAEMON_PROTOCOL_VERSION } from "../src/daemon/protocol.js";
import type { DaemonApprovalChallenge } from "../src/daemon/protocol.js";

const PACKAGE = "com.example.commands";
const ATTEMPT_ID = "11111111-2222-4333-8444-555555555555";
const EXPIRES = "2026-10-10T00:10:00.000Z";
const VALID_SIGNATURE = Buffer.alloc(64, 3).toString("base64url");

const dirs: string[] = [];
const servers: Server[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-client-cmd-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function openChallenge(): DaemonApprovalChallenge {
  const statement = createReleaseEditOpenStatement(PACKAGE);
  const parsed = parseApprovalStatementCanonical(statement);
  return approvalChallengeFor(
    {
      requestId: ATTEMPT_ID,
      nonce: "n".repeat(43),
      toolName: parsed.toolName,
      permission: parsed.permission,
      packageName: parsed.packageName,
      requestDigest: approvalStatementDigest(statement),
      expiresAtUtc: EXPIRES,
    },
    statement,
  );
}

function reply(outcome: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: "corr",
    outcome,
    ...extra,
  });
}

interface Stub {
  readonly socketPath: string;
  close(): Promise<void>;
}

async function startStub(
  handler: (request: { kind: string }, socket: Socket) => string | "destroy",
): Promise<Stub> {
  const socketPath = join(tempDir(), "stub.sock");
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const length = raw.readUInt32BE(0);
      const envelope = JSON.parse(raw.subarray(4, 4 + length).toString("utf8")) as {
        request: { kind: string };
      };
      const action = handler(envelope.request, socket);
      if (action === "destroy") {
        socket.destroy();
        return;
      }
      socket.write(Buffer.from(action, "utf8"));
      socket.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function captureIo(): { io: DaemonCliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { write: (text) => out.push(text), writeError: (text) => err.push(text) },
    out,
    err,
  };
}

describe("daemon command parsing", () => {
  it("accepts every documented form and rejects everything else", () => {
    expect(parseDaemonCommand([])).toEqual({ kind: "help" });
    expect(parseDaemonCommand(["status"])).toEqual({ kind: "status", json: false });
    expect(parseDaemonCommand(["status", "--json"])).toEqual({ kind: "status", json: true });
    expect(parseDaemonCommand(["open", "prepare"]).kind).toBe("prepare");
    expect(parseDaemonCommand(["open", "prepare", "--out", "/tmp/c.json"]).kind).toBe("prepare");
    expect(
      parseDaemonCommand(["commit", "prepare", "--track", "internal", "--version-code", "42"]).kind,
    ).toBe("prepare");
    expect(
      parseDaemonCommand(["verify", "prepare", "--track", "internal", "--version-code", "42"]).kind,
    ).toBe("prepare");
    expect(parseDaemonCommand(["reconcile", "prepare"]).kind).toBe("prepare");
    expect(
      parseDaemonCommand(["open", "execute", "--request-id", ATTEMPT_ID, "--signature-stdin"]).kind,
    ).toBe("execute");
    expect(
      parseDaemonCommand([
        "notes",
        "attach",
        "--track",
        "internal",
        "--version-code",
        "42",
        "--locale",
        "en-US",
        "--note-text",
        "hi",
        "--yes",
      ]).kind,
    ).toBe("attach-notes");

    for (const bad of [
      ["send", "{}"],
      ["status", "--bogus"],
      ["status", "extra"],
      ["commit", "prepare"],
      ["open", "prepare", "--track", "internal"],
      ["open", "execute", "--request-id", ATTEMPT_ID],
      ["open", "execute", "--signature-stdin"],
      ["open"],
      ["notes"],
      ["nope"],
    ]) {
      expect(() => parseDaemonCommand(bad), JSON.stringify(bad)).toThrow(DaemonCliError);
    }
  });
});

describe("daemon exit-code mapping", () => {
  const cases: readonly { readonly outcome: string; readonly code: 0 | 1 | 2 }[] = [
    { outcome: "success", code: 0 },
    { outcome: "approval_mismatch", code: 1 },
    { outcome: "approval_expired", code: 1 },
    { outcome: "request_not_found", code: 1 },
    { outcome: "request_already_consumed", code: 1 },
    { outcome: "request_claim_held", code: 1 },
    { outcome: "operation_in_progress", code: 1 },
    { outcome: "operation_unavailable", code: 1 },
    { outcome: "config_invalid", code: 1 },
    { outcome: "capability_blocked", code: 1 },
    { outcome: "remote_failure", code: 1 },
    { outcome: "local_state_failure", code: 1 },
    { outcome: "protocol_error", code: 1 },
    { outcome: "external_state_ambiguous", code: 2 },
    { outcome: "cleanup_pending", code: 2 },
  ];
  for (const { outcome, code } of cases) {
    it(`maps ${outcome} to exit ${String(code)}`, async () => {
      const stub = await startStub((_request, _socket) => {
        if (outcome === "request_not_found") return reply(outcome, { requestId: ATTEMPT_ID });
        if (outcome === "operation_unavailable")
          return reply(outcome, { operation: "execute_commit" });
        return reply(outcome, {});
      });
      const { io } = captureIo();
      const exit = await runDaemonCli(
        ["open", "execute", "--request-id", ATTEMPT_ID, "--signature-stdin"],
        io,
        {
          socketPath: stub.socketPath,
          readSignature: async () => VALID_SIGNATURE,
        },
      );
      await stub.close();
      expect(exit).toBe(code);
    });
  }

  it("propagates operator interruption after dispatch with exit 2 and no resend", async () => {
    const controller = new AbortController();
    let dispatches = 0;
    const stub = await startStub(() => {
      dispatches += 1;
      controller.abort();
      return reply("success");
    });
    const { io, err } = captureIo();
    const exit = await runDaemonCli(
      ["open", "execute", "--request-id", ATTEMPT_ID, "--signature-stdin"],
      io,
      {
        socketPath: stub.socketPath,
        readSignature: async () => VALID_SIGNATURE,
        signal: controller.signal,
      } as Parameters<typeof runDaemonCli>[2],
    );
    await stub.close();
    expect(exit).toBe(2);
    expect(err.join("\n")).toContain("OUTCOME UNKNOWN FROM CLIENT PERSPECTIVE");
    expect(dispatches).toBe(1);
  });

  it("handles SIGINT while waiting without claiming cancellation of daemon work", async () => {
    const previous = process.listenerCount("SIGINT");
    const stub = await startStub(() => {
      process.emit("SIGINT", "SIGINT");
      return reply("success");
    });
    const { io, err } = captureIo();
    const code = await runDaemonCli(
      ["open", "execute", "--request-id", ATTEMPT_ID, "--signature-stdin"],
      io,
      { socketPath: stub.socketPath, readSignature: async () => VALID_SIGNATURE },
    );
    await stub.close();
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("OUTCOME UNKNOWN FROM CLIENT PERSPECTIVE");
    expect(process.listenerCount("SIGINT")).toBe(previous);
  });

  it("does not echo a signature accidentally supplied in argv", async () => {
    const { io, out, err } = captureIo();
    const code = await runDaemonCli(
      ["open", "execute", "--request-id", ATTEMPT_ID, "--signature=" + VALID_SIGNATURE],
      io,
    );
    expect(code).toBe(1);
    expect([...out, ...err].join(" ")).not.toContain(VALID_SIGNATURE);
  });

  it("validates note text with the shared wire rules before connecting", async () => {
    let dispatches = 0;
    const stub = await startStub(() => {
      dispatches++;
      return reply("success");
    });
    const { io } = captureIo();
    const code = await runDaemonCli(
      [
        "notes",
        "attach",
        "--track",
        "internal",
        "--version-code",
        "42",
        "--locale",
        "en-US",
        "--note-text",
        "synthetic\ncontrol",
        "--yes",
      ],
      io,
      { socketPath: stub.socketPath },
    );
    await stub.close();
    expect(code).toBe(1);
    expect(dispatches).toBe(0);
  });

  it("preserves the verified prepare response when exclusive export fails", async () => {
    const challenge = openChallenge();
    let dispatches = 0;
    const stub = await startStub(() => {
      dispatches++;
      return reply("approval_required", { approval: challenge, summary: "s" });
    });
    const path = join(tempDir(), "existing.json");
    writeFileSync(path, "existing-not-a-challenge");
    const { io, out, err } = captureIo();
    const code = await runDaemonCli(["open", "prepare", "--json", "--out", path], io, {
      socketPath: stub.socketPath,
    });
    await stub.close();
    expect(code).toBe(1);
    expect(dispatches).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("existing-not-a-challenge");
    expect(out).toHaveLength(1);
    const result = JSON.parse(out[0] ?? "null") as {
      outcome: string;
      approval: DaemonApprovalChallenge;
    };
    expect(result.outcome).toBe("approval_required");
    expect(result.approval.canonicalPayload).toBe(challenge.canonicalPayload);
    expect(result.approval.approvalStatementCanonical).toBe(challenge.approvalStatementCanonical);
    expect(err.join(" ")).toContain("do not automatically prepare again");
  });

  it("maps a prepare approval_required to exit 0", async () => {
    const stub = await startStub(() =>
      reply("approval_required", { approval: openChallenge(), summary: "s" }),
    );
    const { io, out } = captureIo();
    const exit = await runDaemonCli(["open", "prepare"], io, { socketPath: stub.socketPath });
    await stub.close();
    expect(exit).toBe(0);
    expect(out.join("\n")).toContain("APPROVAL REQUIRED");
  });

  it("maps connect failure and post-dispatch ambiguity conservatively", async () => {
    const { io } = captureIo();
    const connect = await runDaemonCli(["status"], io, {
      socketPath: join(tempDir(), "absent.sock"),
    });
    expect(connect).toBe(1);

    const drop = await startStub(() => "destroy");
    const ambiguous = await runDaemonCli(
      ["commit", "execute", "--request-id", ATTEMPT_ID, "--signature-stdin"],
      io,
      { socketPath: drop.socketPath, readSignature: async () => VALID_SIGNATURE },
    );
    await drop.close();
    expect(ambiguous).toBe(2);
  });

  it("emits a stable --json object for status", async () => {
    const stub = await startStub(() => reply("status", { summary: "pending=0" }));
    const { io, out } = captureIo();
    const exit = await runDaemonCli(["status", "--json"], io, { socketPath: stub.socketPath });
    await stub.close();
    expect(exit).toBe(0);
    const parsed = JSON.parse(out.join("")) as { outcome: string; correlationId: string };
    expect(parsed.outcome).toBe("status");
    expect(parsed.correlationId).toBe("corr");
  });

  it("rejects an invalid signature token before connecting", async () => {
    const stub = await startStub(() => reply("success", {}));
    const { io, err } = captureIo();
    const exit = await runDaemonCli(
      ["open", "execute", "--request-id", ATTEMPT_ID, "--signature-stdin"],
      io,
      {
        socketPath: stub.socketPath,
        readSignature: async () => "short",
      },
    );
    await stub.close();
    expect(exit).toBe(1);
    expect(err.join("\n").length).toBeGreaterThan(0);
  });
});

describe("daemon help and routing", () => {
  it("prints the daemon group in `playops --help` and in `daemon --help`", async () => {
    const { io, out } = captureIo();
    const help = await runDaemonCli(["--help"], io);
    expect(help).toBe(0);
    expect(out.join("\n")).toContain("playops daemon status");

    const topOut: string[] = [];
    const top = await runCli(["--help"], {} as never, {
      log: (text) => topOut.push(text),
      error: () => undefined,
    });
    expect(top).toBe(0);
    const text = topOut.join("\n");
    expect(text).toContain("daemon");
    expect(text).toContain("/run/playops/playops.sock");
    expect(text).toContain("off-host signer");
  });

  it("keeps existing commands and the unknown-command behaviour unchanged", async () => {
    const out: string[] = [];
    const output = { log: (text: string) => out.push(text), error: () => undefined };
    // `releases` has no live deps at this layer and still returns 1.
    expect(await runCli(["releases"], {} as never, output)).toBe(1);
    expect(await runCli(["bogus"], {} as never, output)).toBe(1);
  });
});

describe("config isolation", () => {
  it("never reads config for the daemon route (runCliWithLogging stays quiet)", async () => {
    const loadConfig = vi.fn(() => ({ logging: { level: "error" as const } }));
    const exit = await runCliWithLogging(["daemon", "status"], async () => 0, { loadConfig });
    expect(exit).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("ignores hostile PLAYOPS_* env and uses the pinned production endpoint", async () => {
    const transportModule = await import("../src/client/transport.js");
    const fakeResult: Awaited<ReturnType<typeof transportModule.sendDaemonRequest>> = {
      ok: true,
      response: {
        protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
        correlationId: "corr",
        outcome: "status",
        summary: "pending=0",
      },
    };
    const sendSpy = vi.spyOn(transportModule, "sendDaemonRequest").mockResolvedValue(fakeResult);
    const hostileSocketPath = "/tmp/playops-hostile-override.sock";
    const hostileConfigPath = "/tmp/playops-hostile-config.yaml";
    const saved = process.env.PLAYOPS_DAEMON_SOCKET_PATH;
    const savedConfig = process.env.PLAYOPS_CONFIG;
    process.env.PLAYOPS_DAEMON_SOCKET_PATH = hostileSocketPath;
    process.env.PLAYOPS_CONFIG = hostileConfigPath;
    try {
      expect(PRODUCTION_OPERATOR_SOCKET_PATH).toBe("/run/playops/playops.sock");
      const { io } = captureIo();
      const exit = await runDaemonCli(["status"], io);
      expect(exit).toBe(0);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const callOptions = sendSpy.mock.calls[0]?.[0];
      expect(callOptions?.request).toEqual({ kind: "status" });
      expect(callOptions?.socketPath).toBe(PRODUCTION_OPERATOR_SOCKET_PATH);
      expect(callOptions?.socketPath).toBe("/run/playops/playops.sock");
      expect(callOptions?.socketPath).not.toBe(hostileSocketPath);
      expect(callOptions?.socketPath).not.toBe(hostileConfigPath);
    } finally {
      sendSpy.mockRestore();
      if (saved === undefined) delete process.env.PLAYOPS_DAEMON_SOCKET_PATH;
      else process.env.PLAYOPS_DAEMON_SOCKET_PATH = saved;
      if (savedConfig === undefined) delete process.env.PLAYOPS_CONFIG;
      else process.env.PLAYOPS_CONFIG = savedConfig;
    }
  });
});
