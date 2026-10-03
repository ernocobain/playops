#!/usr/bin/env node
/**
 * PlayOps CLI entrypoint (`doctor`, command-driven `reviews`, operator-bound
 * `releases --dry-run`, and dated `health report`).
 * process.exit lives here and nowhere else — handlers return exit codes.
 */
import { writeSync } from "node:fs";
import { createLiveDoctorDeps } from "../doctor/live.js";
import { createLiveReviewComposition } from "../reviews/composition.js";
import { presentOperatorError } from "../errors/index.js";
import { createReadlineApprovalPrompt } from "./approval-prompt.js";
import { runCli } from "./main.js";
import { runCliWithLogging } from "./logging.js";

const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const args = process.argv.slice(2);
let exitCode: 0 | 1 | 2 = 1;
try {
  exitCode = await runCliWithLogging(args, () =>
    runCli(
      args,
      createLiveDoctorDeps(),
      console,
      {
        compositionFactory: createLiveReviewComposition,
        io: {
          write: (text) => console.log(text),
          writeError: (text) => console.error(text),
          isInteractive,
          ...(isInteractive ? { approvalPrompt: createReadlineApprovalPrompt() } : {}),
        },
      },
      undefined,
      {
        io: {
          // Exact report bytes; await drain/error before the entrypoint exits.
          write: (text) =>
            new Promise<void>((resolve, reject) => {
              // A write error also emits a stream 'error' after its callback. Keep
              // this listener on failure; remove it only after a successful write.
              process.stdout.once("error", reject);
              process.stdout.write(text, (error) => {
                if (error) reject(error);
                else {
                  process.stdout.off("error", reject);
                  resolve();
                }
              });
            }),
          writeError: (text) => console.error(text),
        },
      },
    ),
  );
} catch (cause) {
  // Phase 6.3: the last-resort safe presentation boundary. A command's own safe
  // messages are written to stderr by its handlers before returning; only an
  // unexpected thrown failure reaches here, and it is rendered through the
  // PlayOps error taxonomy — never as a raw Error, stack trace, or cause chain.
  try {
    writeSync(2, `${presentOperatorError(cause)}\n`);
  } catch {
    // A closed/blocked stderr must not mask the failure exit code.
  }
}
process.exit(exitCode);
