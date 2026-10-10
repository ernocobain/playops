/**
 * The `daemon` command group: the operator client's CLI surface.
 *
 * This is a UX/framing layer over `src/client/*`. It is deliberately NOT part of
 * `runCliWithLogging`'s `COMMANDS` list, so the client path never calls
 * `loadConfig()` and never touches credentials or Google modules.
 *
 * Command hierarchy (exact):
 *   playops daemon status
 *   playops daemon open prepare|execute
 *   playops daemon notes attach
 *   playops daemon commit prepare|execute
 *   playops daemon verify prepare|execute
 *   playops daemon reconcile prepare|execute
 *
 * There is no generic raw command (`daemon send '<json>'`) and no arbitrary
 * protocol surface. The pinned production endpoint is the only endpoint; tests
 * inject `socketPath` through the module API only. Executes read exactly one
 * signature token from stdin and are never automatically retried.
 */
import {
  MAX_NOTE_TEXT_BYTES,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  parseDaemonRequest,
  type DaemonRequest,
} from "../daemon/protocol.js";
import { normalizeReleaseVersionCode, validateReleaseTargetTrack } from "../releases/index.js";
import {
  ATTACH_NOTES_WARNING,
  renderHumanResponse,
  renderHumanTransportFailure,
  renderMachineResponse,
  renderMachineTransportFailure,
} from "../client/render.js";
import {
  createApprovalExport,
  crossCheckChallenge,
  parseSignatureToken,
  readChallengeFile,
  serializeApprovalExport,
  validateApprovalChallenge,
  writeChallengeFile,
} from "../client/approval.js";
import {
  PRODUCTION_OPERATOR_SOCKET_PATH,
  READ_ONLY_RESPONSE_TIMEOUT_MS,
  sendDaemonRequest,
  type SendDaemonRequestOptions,
} from "../client/transport.js";
import { exitCodeForOutcome } from "../client/outcome.js";

export interface DaemonCliIo {
  write(text: string): void;
  writeError(text: string): void;
}

export interface DaemonCliDeps {
  /** Testing seam only. Production always uses the pinned constant. */
  readonly socketPath?: string;
  /** Read one signature token from stdin to EOF. */
  readonly readSignature?: (signal?: AbortSignal) => Promise<string>;
  /** Cancels client waiting only, not daemon work. */
  readonly signal?: AbortSignal;
  /** Interactive confirmation for `notes attach`. Defaults to requiring --yes. */
  readonly confirm?: () => Promise<boolean>;
}

export type DaemonOperation = "open" | "commit" | "verify" | "reconcile";

export type DaemonCommand =
  | { readonly kind: "help" }
  | { readonly kind: "status"; readonly json: boolean }
  | {
      readonly kind: "prepare";
      readonly operation: DaemonOperation;
      readonly json: boolean;
      readonly outPath?: string;
      readonly track?: string;
      readonly versionCode?: string;
    }
  | {
      readonly kind: "execute";
      readonly operation: DaemonOperation;
      readonly json: boolean;
      readonly requestId: string;
      readonly challengePath?: string;
    }
  | {
      readonly kind: "attach-notes";
      readonly json: boolean;
      readonly track: string;
      readonly versionCode: string;
      readonly locale: string;
      readonly noteText: string;
      readonly yes: boolean;
    };

const OPERATIONS: readonly DaemonOperation[] = ["open", "commit", "verify", "reconcile"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const VALUE_FLAGS = new Set([
  "--out",
  "--request-id",
  "--challenge",
  "--track",
  "--version-code",
  "--locale",
  "--note-text",
]);

export class DaemonCliError extends Error {
  override readonly name = "DaemonCliError";
  readonly code = "CLI_ARGUMENT_INVALID";
}

function usage(): string {
  return [
    "Usage: playops daemon <group> <action> [flags]",
    "",
    "Commands:",
    "  playops daemon status",
    "  playops daemon open prepare|execute",
    "  playops daemon notes attach",
    "  playops daemon commit prepare|execute",
    "  playops daemon verify prepare|execute",
    "  playops daemon reconcile prepare|execute",
    "",
    "Groups:",
    "  status                       Aggregate daemon status (read-only)",
    "  open prepare                 Prepare an open-edit approval challenge",
    "  open execute                 Execute a signed open-edit approval",
    "  notes attach                 Write release notes (REAL unsigned remote write)",
    "  commit prepare|execute       Prepare/execute a commit approval",
    "  verify prepare|execute       Prepare/execute a verification approval",
    "  reconcile prepare|execute    Prepare/execute a reconcile approval",
    "",
    "Flags:",
    "  --json                       Machine-readable output",
    "  --out <path>                 Export the prepared challenge (prepare only)",
    "  --request-id <uuid>          Request id to execute (required for execute)",
    "  --signature-stdin            Read one signature token from stdin (required for execute)",
    "  --challenge <path>           Optional cross-check of the challenge before connecting",
    "  --track <name>               Release track (commit/verify/notes)",
    "  --version-code <digits>      Release version code (commit/verify/notes)",
    "  --locale <locale>            Release-note locale (notes)",
    "  --note-text <text>           Release-note text (notes)",
    "  --yes                        Confirm the unsigned notes write (noninteractive)",
    "",
    "The production endpoint is pinned to /run/playops/playops.sock; there is no",
    "--socket flag and no environment override. Signatures are read from stdin and",
    "must come from an off-host signer. Mutating executes are never auto-retried.",
    "status is aggregate-only and cannot resolve a specific request id.",
  ].join("\n");
}

function parseFlags(tokens: readonly string[]): { readonly flags: Map<string, string | true> } {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("--")) {
      throw new DaemonCliError('Unexpected daemon argument. Run "playops daemon --help".');
    }
    if (flags.has(token)) throw new DaemonCliError(`Duplicate flag "${token}".`);
    if (VALUE_FLAGS.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new DaemonCliError(`Flag "${token}" requires a value.`);
      }
      flags.set(token, value);
      index += 1;
    } else if (token === "--json" || token === "--signature-stdin" || token === "--yes") {
      flags.set(token, true);
    } else {
      throw new DaemonCliError('Unknown daemon flag. Run "playops daemon --help".');
    }
  }
  return { flags };
}

function requireNoFlags(flags: Map<string, string | true>, allowed: readonly string[]): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) {
      throw new DaemonCliError(`Flag "${key}" is not valid for this command.`);
    }
  }
}

function requiredValue(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string") throw new DaemonCliError(`Flag "${name}" is required.`);
  return value;
}

function canonicalTrack(value: string): string {
  try {
    return validateReleaseTargetTrack(value);
  } catch {
    throw new DaemonCliError("Invalid release track.");
  }
}

function canonicalVersionCode(value: string): string {
  try {
    return normalizeReleaseVersionCode(value);
  } catch {
    throw new DaemonCliError("Invalid release version code.");
  }
}

export function parseDaemonCommand(args: readonly string[]): DaemonCommand {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    return { kind: "help" };
  }
  const group = args[0];
  if (group === "status") {
    const { flags } = parseFlags(args.slice(1));
    requireNoFlags(flags, ["--json"]);
    return { kind: "status", json: flags.has("--json") };
  }
  if (group === "notes") {
    if (args[1] !== "attach") throw new DaemonCliError('Expected "notes attach".');
    const { flags } = parseFlags(args.slice(2));
    requireNoFlags(flags, [
      "--json",
      "--track",
      "--version-code",
      "--locale",
      "--note-text",
      "--yes",
    ]);
    const track = canonicalTrack(requiredValue(flags, "--track"));
    const versionCode = canonicalVersionCode(requiredValue(flags, "--version-code"));
    const locale = requiredValue(flags, "--locale");
    if (!LOCALE_PATTERN.test(locale)) throw new DaemonCliError("Invalid release-note locale.");
    const noteText = requiredValue(flags, "--note-text");
    if (Buffer.byteLength(noteText, "utf8") > MAX_NOTE_TEXT_BYTES) {
      throw new DaemonCliError("Release-note text exceeds the transport bound.");
    }
    return {
      kind: "attach-notes",
      json: flags.has("--json"),
      track,
      versionCode,
      locale,
      noteText,
      yes: flags.has("--yes"),
    };
  }
  if (typeof group === "string" && OPERATIONS.includes(group as DaemonOperation)) {
    const operation = group as DaemonOperation;
    const action = args[1];
    if (action === "prepare") {
      const { flags } = parseFlags(args.slice(2));
      requireNoFlags(flags, ["--json", "--out", "--track", "--version-code"]);
      const scoped = operation === "commit" || operation === "verify";
      const trackFlag = flags.get("--track");
      const versionFlag = flags.get("--version-code");
      if (scoped) {
        return {
          kind: "prepare",
          operation,
          json: flags.has("--json"),
          ...(typeof flags.get("--out") === "string"
            ? { outPath: flags.get("--out") as string }
            : {}),
          track: canonicalTrack(requiredValue(flags, "--track")),
          versionCode: canonicalVersionCode(requiredValue(flags, "--version-code")),
        };
      }
      if (trackFlag !== undefined || versionFlag !== undefined) {
        throw new DaemonCliError(`Operation "${operation}" does not take --track/--version-code.`);
      }
      return {
        kind: "prepare",
        operation,
        json: flags.has("--json"),
        ...(typeof flags.get("--out") === "string"
          ? { outPath: flags.get("--out") as string }
          : {}),
      };
    }
    if (action === "execute") {
      const { flags } = parseFlags(args.slice(2));
      requireNoFlags(flags, ["--json", "--request-id", "--signature-stdin", "--challenge"]);
      if (!flags.has("--signature-stdin")) {
        throw new DaemonCliError("--signature-stdin is required for execute.");
      }
      const requestId = requiredValue(flags, "--request-id");
      if (!UUID_PATTERN.test(requestId))
        throw new DaemonCliError("Invalid --request-id (expected a UUID).");
      const challenge = flags.get("--challenge");
      return {
        kind: "execute",
        operation,
        json: flags.has("--json"),
        requestId,
        ...(typeof challenge === "string" ? { challengePath: challenge } : {}),
      };
    }
    throw new DaemonCliError(`Expected "prepare" or "execute" after "${operation}".`);
  }
  throw new DaemonCliError('Unknown daemon command. Run "playops daemon --help".');
}

function prepareRequest(command: Extract<DaemonCommand, { kind: "prepare" }>): DaemonRequest {
  switch (command.operation) {
    case "open":
      return { kind: "prepare_open_edit" };
    case "reconcile":
      return { kind: "prepare_reconcile_commit" };
    case "commit":
      return {
        kind: "prepare_commit",
        track: command.track ?? "",
        versionCode: command.versionCode ?? "",
      };
    case "verify":
      return {
        kind: "prepare_verify_committed",
        track: command.track ?? "",
        versionCode: command.versionCode ?? "",
      };
  }
}

type ExecuteRequestKind =
  "execute_open_edit" | "execute_commit" | "execute_verify_committed" | "execute_reconcile_commit";

function executeKind(operation: DaemonOperation): ExecuteRequestKind {
  switch (operation) {
    case "open":
      return "execute_open_edit";
    case "commit":
      return "execute_commit";
    case "verify":
      return "execute_verify_committed";
    case "reconcile":
      return "execute_reconcile_commit";
  }
}

async function defaultReadSignature(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("Client interrupted before dispatch.");
  return new Promise<string>((resolve, reject) => {
    let text = "";
    const cleanup = (): void => {
      process.stdin.off("data", data);
      process.stdin.off("end", end);
      process.stdin.off("error", error);
      signal?.removeEventListener("abort", interrupt);
      process.stdin.pause();
    };
    const interrupt = (): void => {
      cleanup();
      reject(new Error("Client interrupted before dispatch."));
    };
    const error = (): void => {
      cleanup();
      reject(new Error("Signature input could not be read."));
    };
    const end = (): void => {
      cleanup();
      resolve(text);
    };
    const data = (chunk: string): void => {
      text += chunk;
      if (Buffer.byteLength(text, "utf8") > 1024) {
        cleanup();
        reject(new Error("Signature input exceeds the client size bound."));
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", error);
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    else process.stdin.resume();
  });
}

async function runDaemonCommand(
  args: readonly string[],
  io: DaemonCliIo,
  deps: DaemonCliDeps = {},
): Promise<0 | 1 | 2> {
  let command: DaemonCommand;
  try {
    command = parseDaemonCommand(args);
  } catch (cause) {
    io.writeError(cause instanceof Error ? cause.message : "Invalid daemon command.");
    io.writeError(usage());
    return 1;
  }
  if (command.kind === "help") {
    io.write(usage());
    return 0;
  }

  const socketPath = deps.socketPath ?? PRODUCTION_OPERATOR_SOCKET_PATH;
  const validInput = (request: DaemonRequest, json: boolean): boolean => {
    try {
      parseDaemonRequest({
        protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
        correlationId: "client-validation",
        request,
      });
      return true;
    } catch {
      const message = "Invalid daemon request input; no connection was made.";
      io.writeError(
        json
          ? JSON.stringify({ outcome: "client_error", error: { code: "INVALID_REQUEST", message } })
          : message,
      );
      return false;
    }
  };

  const send = async (
    request: DaemonRequest,
    json: boolean,
    options: { readonly responseTimeoutMs?: number } = {},
  ): Promise<0 | 1 | 2> => {
    if (!validInput(request, json)) return 1;
    const requestOptions: SendDaemonRequestOptions = {
      socketPath,
      request,
      signal: deps.signal,
      ...(options.responseTimeoutMs === undefined
        ? {}
        : { responseTimeoutMs: options.responseTimeoutMs }),
      ...(json
        ? {}
        : {
            onWaiting: (elapsedMs: number) =>
              io.write(
                `Still waiting for the daemon (${String(Math.round(elapsedMs / 1000))}s)...`,
              ),
          }),
    };
    const result = await sendDaemonRequest(requestOptions);
    if (!result.ok) {
      io.writeError(
        json
          ? renderMachineTransportFailure(result.failure)
          : renderHumanTransportFailure(result.failure),
      );
      return result.failure.exitCode;
    }
    const response = result.response;
    if (response.outcome === "approval_required" && response.approval !== undefined) {
      // Validate BEFORE any display or export.
      try {
        validateApprovalChallenge(response.approval);
      } catch (cause) {
        io.writeError(
          cause instanceof Error ? cause.message : "The daemon approval challenge is invalid.",
        );
        return 1;
      }
    }
    io.write(json ? renderMachineResponse(response) : renderHumanResponse(response));
    return exitCodeForOutcome(response.outcome);
  };

  if (command.kind === "status") {
    return await send({ kind: "status" }, command.json, {
      responseTimeoutMs: READ_ONLY_RESPONSE_TIMEOUT_MS,
    });
  }

  if (command.kind === "prepare") {
    const request = prepareRequest(command);
    if (!validInput(request, command.json)) return 1;
    if (command.outPath !== undefined) {
      // Send first, then export the returned challenge with the operator echo.
      const result = await sendDaemonRequest({ socketPath, request, signal: deps.signal });
      if (!result.ok) {
        io.writeError(
          command.json
            ? renderMachineTransportFailure(result.failure)
            : renderHumanTransportFailure(result.failure),
        );
        return result.failure.exitCode;
      }
      const response = result.response;
      if (response.outcome !== "approval_required" || response.approval === undefined) {
        io.write(command.json ? renderMachineResponse(response) : renderHumanResponse(response));
        return exitCodeForOutcome(response.outcome);
      }
      try {
        const challenge = validateApprovalChallenge(response.approval);
        const exported = createApprovalExport(challenge, {
          requestId: challenge.requestId,
          ...(command.track === undefined ? {} : { track: command.track }),
          ...(command.versionCode === undefined ? {} : { versionCode: command.versionCode }),
        });
        writeChallengeFile(command.outPath, serializeApprovalExport(exported));
      } catch (cause) {
        // A verified prepare response already exists even if local export fails.
        // Preserve it; a blind second prepare may create another pending request.
        const message =
          cause instanceof Error ? cause.message : "The challenge could not be exported.";
        const guidance =
          "do not automatically prepare again; the verified prepare response is preserved.";
        io.writeError(
          command.json
            ? JSON.stringify({
                outcome: "client_error",
                requestId: response.approval.requestId,
                error: { code: "CHALLENGE_EXPORT_FAILED", message },
                guidance,
              })
            : `${message} Request already prepared: ${response.approval.requestId}; ${guidance}`,
        );
        io.write(command.json ? renderMachineResponse(response) : renderHumanResponse(response));
        return 1;
      }
      io.write(command.json ? renderMachineResponse(response) : renderHumanResponse(response));
      return 0;
    }
    return await send(request, command.json);
  }

  if (command.kind === "execute") {
    let signature: string;
    try {
      const token = await (deps.readSignature ?? defaultReadSignature)(deps.signal);
      signature = parseSignatureToken(token);
    } catch (cause) {
      io.writeError(cause instanceof Error ? cause.message : "The operator signature is invalid.");
      return 1;
    }
    if (command.challengePath !== undefined) {
      // Revalidate the exact challenge and refuse on any mismatch BEFORE connecting.
      try {
        const stored = readChallengeFile(command.challengePath);
        crossCheckChallenge(stored, { requestId: command.requestId });
      } catch (cause) {
        io.writeError(
          cause instanceof Error ? cause.message : "The challenge file did not match the request.",
        );
        return 1;
      }
    }
    const request: DaemonRequest = {
      kind: executeKind(command.operation),
      requestId: command.requestId,
      signature,
    };
    // No short response timeout for a mutating execute: wait for EOF.
    return await send(request, command.json);
  }

  // attach-notes: a real, unsigned remote write. Print the plain warning first.
  if (!command.json) io.write(ATTACH_NOTES_WARNING);
  if (!command.yes) {
    const confirmed = deps.confirm === undefined ? false : await deps.confirm();
    if (!confirmed) {
      io.writeError(
        "Refusing the unsigned remote notes write without confirmation. Re-run with --yes to confirm.",
      );
      return 1;
    }
  }
  const request: DaemonRequest = {
    kind: "attach_notes",
    track: command.track,
    versionCode: command.versionCode,
    locale: command.locale,
    noteText: command.noteText,
  };
  return await send(request, command.json);
}

/** SIGINT stops only this client's wait. Never cancel/replay daemon operations. */
export async function runDaemonCli(
  args: readonly string[],
  io: DaemonCliIo,
  deps: DaemonCliDeps = {},
): Promise<0 | 1 | 2> {
  if (deps.signal !== undefined) return runDaemonCommand(args, io, deps);
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.on("SIGINT", interrupt);
  try {
    return await runDaemonCommand(args, io, { ...deps, signal: controller.signal });
  } finally {
    process.off("SIGINT", interrupt);
  }
}

export { usage as daemonUsage };
