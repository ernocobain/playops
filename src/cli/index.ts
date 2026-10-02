#!/usr/bin/env node
/**
 * PlayOps CLI entrypoint (`doctor`, command-driven `reviews`, and operator-bound
 * `releases --dry-run`).
 * process.exit lives here and nowhere else — handlers return exit codes.
 */
import { createLiveDoctorDeps } from "../doctor/live.js";
import { createLiveReviewComposition } from "../reviews/composition.js";
import { createReadlineApprovalPrompt } from "./approval-prompt.js";
import { runCli } from "./main.js";

const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const exitCode = await runCli(process.argv.slice(2), createLiveDoctorDeps(), console, {
  compositionFactory: createLiveReviewComposition,
  io: {
    write: (text) => console.log(text),
    writeError: (text) => console.error(text),
    isInteractive,
    ...(isInteractive ? { approvalPrompt: createReadlineApprovalPrompt() } : {}),
  },
});
process.exit(exitCode);
