#!/usr/bin/env node
/**
 * PlayOps CLI entrypoint (`doctor`, command-driven `reviews`, operator-bound
 * `releases --dry-run`, and dated `health report`).
 * process.exit lives here and nowhere else — handlers return exit codes.
 */
import { createLiveDoctorDeps } from "../doctor/live.js";
import { createLiveReviewComposition } from "../reviews/composition.js";
import { createReadlineApprovalPrompt } from "./approval-prompt.js";
import { runCli } from "./main.js";

const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const exitCode = await runCli(
  process.argv.slice(2),
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
);
process.exit(exitCode);
