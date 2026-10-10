/**
 * Stage 4A.1 — `playopsd` startup/run logic (no `process.exit`, no process-level
 * side effects beyond installing signal handlers the caller can dispose).
 *
 * Deliberately tiny surface:
 *
 *   playopsd --config <absolute-path>
 *   playopsd --help
 *   playopsd --version
 *
 * There are no credential, trust-anchor, socket, state-root or package
 * overrides: those are validated configuration, never CLI flags. The
 * configuration file itself must be an absolute path — nothing is discovered
 * from cwd, a user home or a project checkout.
 *
 * Environment note: the existing loader precedence (env > file > default) still
 * applies, so `PLAYOPS_*` can supply the credential path, package, state roots
 * and socket path. Every such value is re-validated as absolute and
 * filesystem-checked before use, and the trust anchor is never overridable —
 * but whoever controls the daemon's environment is trusted configuration input,
 * so the service manager must own it.
 *
 * Startup order (all before the socket is bound; zero Google API calls):
 *
 *   runtime check -> config -> validation -> verifier -> credential -> publisher
 *   -> composition -> bind capability-group socket -> listen -> serve -> drain
 *
 * Shutdown order (see `lifecycle.ts`):
 *
 *   DRAINING gate -> wait for in-flight operations -> close listener -> exit.
 * A deadline expiry warns; it never kills an in-flight operation. A second
 * signal only repeats the already-draining diagnostic.
 */
import { presentOperatorError } from "../errors/index.js";
import {
  createDrainController,
  createInFlightTracker,
  installShutdownSignals,
  type DaemonDiagnosticSink,
  type DrainScheduler,
  type SignalSource,
} from "./lifecycle.js";
import {
  classifyStartupFailure,
  createProductionDaemonApplication,
  isAbsolutePath,
  readInstalledPackageVersion,
  type ProductionDaemonFactories,
} from "./production-composition.js";
import { createDaemonServer } from "./server.js";

export const PLAYOPSD_NAME = "playopsd" as const;
/** Node major this daemon supports, matching `package.json` engines. */
export const SUPPORTED_NODE_MAJOR = 24;
/** Bootstrap-owned warning deadline; expiry never kills an operation. */
export const DEFAULT_DRAIN_DEADLINE_MS = 30_000;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

export const PLAYOPSD_USAGE = `Usage: ${PLAYOPSD_NAME} --config <absolute-config-path>

Options:
  --config <path>  Absolute path to the production PlayOps configuration file.
  --help           Show this help and exit.
  --version        Show the daemon version and exit.

Configuration, not flags, supplies the credential path, the Google Play package,
the durable state roots and the socket path. The operator trust anchor is the
fixed production path /etc/playops/operator-approval.pub and is not overridable.
Startup performs no Google API call. The socket mode is restricted to {0600, 0660}:
0600 is owner-only (tests/dev); 0660 is the production capability-group mode in
which one small, admin-managed group may connect.`;

export type PlayopsdArguments =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "run"; readonly configPath: string }
  | { readonly kind: "error"; readonly message: string };

/** Parse the deliberately small daemon CLI. Unknown flags fail closed. */
export function parsePlayopsdArgs(argv: readonly string[]): PlayopsdArguments {
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
    if (arg === "--config") {
      if (configPath !== undefined) {
        return { kind: "error", message: "--config may be supplied only once." };
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: "--config requires an absolute path value." };
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--config=")) {
      if (configPath !== undefined) {
        return { kind: "error", message: "--config may be supplied only once." };
      }
      configPath = arg.slice("--config=".length);
      continue;
    }
    return { kind: "error", message: `Unknown argument ${JSON.stringify(arg ?? "")}.` };
  }
  if (configPath === undefined || configPath.length === 0) {
    return { kind: "error", message: "--config <absolute-path> is required." };
  }
  if (!isAbsolutePath(configPath)) {
    return { kind: "error", message: "--config must be an absolute path." };
  }
  return { kind: "run", configPath };
}

export class PlayopsdRuntimeError extends Error {
  override readonly name = "PlayopsdRuntimeError";
  constructor(
    readonly code: "NODE_RUNTIME_UNSUPPORTED",
    message: string,
  ) {
    super(message);
  }
}

/** Pure runtime check so the rule is testable without a process. */
export function assertSupportedNodeRuntime(version: string): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major !== SUPPORTED_NODE_MAJOR) {
    throw new PlayopsdRuntimeError(
      "NODE_RUNTIME_UNSUPPORTED",
      `${PLAYOPSD_NAME} requires Node ${String(SUPPORTED_NODE_MAJOR)}.x (engines: >=${String(
        SUPPORTED_NODE_MAJOR,
      )} <${String(SUPPORTED_NODE_MAJOR + 1)}); observed major ${String(major)}.`,
    );
  }
}

export interface PlayopsdIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface PlayopsdOptions {
  readonly argv: readonly string[];
  readonly io: PlayopsdIo;
  readonly env?: Record<string, string | undefined>;
  readonly factories?: ProductionDaemonFactories;
  readonly runtimeVersion?: string;
  readonly signalTarget?: SignalSource;
  readonly drainDeadlineMs?: number;
  readonly scheduler?: DrainScheduler;
  readonly now?: () => Date;
  readonly diagnostics?: DaemonDiagnosticSink;
}

/**
 * Run the daemon until shutdown completes and return the process exit code.
 * Never calls `process.exit`: the caller owns that.
 */
export async function runPlayopsd(options: PlayopsdOptions): Promise<number> {
  const parsed = parsePlayopsdArgs(options.argv);
  if (parsed.kind === "help") {
    options.io.writeOut(PLAYOPSD_USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    options.io.writeOut(`${PLAYOPSD_NAME} ${readInstalledPackageVersion() ?? "unknown"}`);
    return 0;
  }
  if (parsed.kind === "error") {
    options.io.writeErr(`${PLAYOPSD_NAME}: ${parsed.message}`);
    options.io.writeErr(PLAYOPSD_USAGE);
    return EXIT_USAGE;
  }

  const diagnostics: DaemonDiagnosticSink =
    options.diagnostics ??
    ((event) => {
      // A closed or failing stderr must never break startup or shutdown.
      try {
        options.io.writeErr(`${PLAYOPSD_NAME}: ${event}`);
      } catch {
        /* best-effort operational diagnostic only */
      }
    });
  try {
    assertSupportedNodeRuntime(options.runtimeVersion ?? process.versions.node);
  } catch (cause) {
    diagnostics("daemon_startup_failed", "node-runtime");
    options.io.writeErr(safeMessage(cause));
    return EXIT_FAILURE;
  }

  diagnostics("daemon_starting", "config");
  let application;
  try {
    application = await createProductionDaemonApplication({
      configPath: parsed.configPath,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.factories === undefined ? {} : { factories: options.factories }),
      ...(options.now === undefined ? {} : { now: options.now }),
      diagnostics,
    });
  } catch (cause) {
    diagnostics("daemon_startup_failed", classifyStartupFailure(cause));
    options.io.writeErr(safeMessage(cause));
    return EXIT_FAILURE;
  }

  const tracker = createInFlightTracker({ diagnostics });
  const server = createDaemonServer({
    socketPath: application.composition.socketPath,
    socketMode: application.composition.socketMode,
    handle: tracker.wrap(application.composition.handle),
  });
  try {
    await server.start();
  } catch (cause) {
    diagnostics("daemon_startup_failed", "socket-bind");
    // Best-effort teardown of OUR OWN partially started listener, so a failure
    // after bind does not leave a socket that blocks the next start. It never
    // touches a foreign path: the core refuses to unlink anything it did not bind.
    await server.close().catch(() => undefined);
    options.io.writeErr(safeMessage(cause));
    return EXIT_FAILURE;
  }
  diagnostics("daemon_listening");

  const drain = createDrainController({
    tracker,
    closeListener: () => server.close(),
    diagnostics,
    deadlineMs: options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const signals = installShutdownSignals(drain, {
    ...(options.signalTarget === undefined ? {} : { target: options.signalTarget }),
  });
  try {
    const outcome = await drain.whenStopped();
    return outcome.deadlineExceeded || outcome.closeFailed ? EXIT_FAILURE : 0;
  } finally {
    signals.dispose();
  }
}

/** Safe, taxonomy-preserving failure text. Never a raw error or stack. */
function safeMessage(cause: unknown): string {
  try {
    return presentOperatorError(cause);
  } catch {
    return `${PLAYOPSD_NAME}: startup failed.`;
  }
}
