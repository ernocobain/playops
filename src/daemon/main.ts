#!/usr/bin/env node
/**
 * Stage 4A.1 — `playopsd` production daemon entrypoint.
 *
 * This file owns exactly the process-level concerns: the interpreter banner,
 * stdout/stderr wiring, and the single `process.exit`. All startup validation,
 * composition and lifecycle logic lives in `playopsd.ts`,
 * `production-composition.ts` and `lifecycle.ts` so it can be tested without a
 * process.
 *
 * `process.exit` runs only AFTER `runPlayopsd` resolves, which happens only
 * after every dispatched operation has settled and the listener is closed. A
 * signal never terminates an in-flight mutation.
 */
import { runPlayopsd } from "./playopsd.js";

const io = {
  writeOut: (text: string): void => {
    // The version surface is exact bytes; await drain before exiting.
    process.stdout.write(`${text}\n`);
  },
  writeErr: (text: string): void => {
    process.stderr.write(`${text}\n`);
  },
};

let exitCode = 1;
try {
  exitCode = await runPlayopsd({ argv: process.argv.slice(2), io });
} catch (cause) {
  // The last-resort boundary: a raw Error, stack or cause chain is never printed.
  try {
    process.stderr.write(
      `playopsd: startup failed (${cause instanceof Error ? cause.name : "unknown"})\n`,
    );
  } catch {
    // A closed/blocked stderr must not mask the failure exit code.
  }
}
process.exit(exitCode);
