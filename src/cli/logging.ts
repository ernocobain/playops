/** Phase 6.2: supplemental post-command diagnostics, not CLI output or audit. */
import { writeSync } from "node:fs";
import { loadConfig } from "../config/loader.js";
import type { PlayOpsConfig } from "../config/types.js";
import { createLogger, DEFAULT_LOG_LEVEL, type LogSink } from "../logging/index.js";

export interface CliLoggingDeps {
  readonly loadConfig?: () => Pick<PlayOpsConfig, "logging">;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}
const COMMANDS = ["doctor", "reviews", "releases", "health"] as const;
type CliExitCode = 0 | 1 | 2;

/**
 * The real command completes its argument/config/state/output protocol BEFORE
 * diagnostics are composed. Help/unknown commands remain quiet/config-free.
 * The optional second config read selects only logging.level; it neither loads
 * credentials nor changes the operation's already-determined config/result.
 * Unreadable diagnostic config falls back to info without echoing its cause.
 */
export async function runCliWithLogging(
  args: readonly string[],
  run: () => Promise<CliExitCode>,
  deps: CliLoggingDeps = {},
): Promise<CliExitCode> {
  const command = COMMANDS.find((name) => name === args[0]);
  const quiet =
    command === undefined || args.includes("--help") || (args.length === 1 && command !== "doctor");
  const diagnose = (exitCode: CliExitCode): void => {
    if (quiet) return;
    let level = DEFAULT_LOG_LEVEL;
    try {
      level = (deps.loadConfig ?? loadConfig)().logging.level;
    } catch {
      // Command validation remains authoritative; no raw config/error fallback.
    }
    try {
      const logger = createLogger({
        level,
        now: deps.now,
        // Synchronous fd 2 avoids asynchronous stderr errors and exit-time
        // buffer loss. Failure remains best-effort inside the logger boundary.
        sink:
          deps.sink ??
          ((line) => {
            writeSync(2, line);
          }),
      });
      const context = { command, exitCode };
      if (exitCode === 0) logger.info("CLI command completed.", context);
      else if (exitCode === 2) logger.warn("CLI command declined.", context);
      else logger.error("CLI command failed.", context);
    } catch {
      // Diagnostic construction is best-effort too; never rewrite a result.
    }
  };
  let exitCode: CliExitCode;
  try {
    exitCode = await run();
  } catch (cause) {
    diagnose(1);
    throw cause; // Preserve operation/audit failures exactly, not as log data.
  }
  diagnose(exitCode);
  return exitCode;
}
