#!/usr/bin/env node
/**
 * PlayOps CLI entrypoint (`doctor`, command-driven `reviews`, operator-bound
 * `releases --dry-run`, and dated `health report`).
 * process.exit lives here and nowhere else — handlers return exit codes.
 */
import { writeSync } from "node:fs";

const args = process.argv.slice(2);
let exitCode: 0 | 1 | 2 = 1;

/** Drain daemon output synchronously before the entrypoint's process.exit. */
function writeDaemonOutput(fd: number, text: string): void {
  const bytes = Buffer.from(text.endsWith("\n") ? text : `${text}\n`, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
    if (count <= 0) throw new Error("Client output made no progress.");
    offset += count;
  }
}

try {
  if (args[0] === "daemon") {
    // This branch must not import legacy config/credential/Google composition.
    const { runDaemonCli } = await import("./daemon.js");
    exitCode = await runDaemonCli(args.slice(1), {
      write: (text) => writeDaemonOutput(1, text),
      writeError: (text) => writeDaemonOutput(2, text),
    });
  } else {
    const [doctor, reviews, approval, main, logging] = await Promise.all([
      import("../doctor/live.js"),
      import("../reviews/composition.js"),
      import("./approval-prompt.js"),
      import("./main.js"),
      import("./logging.js"),
    ]);
    const { createLiveDoctorDeps } = doctor;
    const { createLiveReviewComposition } = reviews;
    const { createReadlineApprovalPrompt } = approval;
    const { runCli } = main;
    const { runCliWithLogging } = logging;
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
  }
} catch (cause) {
  // Phase 6.3: the last-resort safe presentation boundary. A command's own safe
  // messages are written to stderr by its handlers before returning; only an
  // unexpected thrown failure reaches here, and it is rendered through the
  // PlayOps error taxonomy — never as a raw Error, stack trace, or cause chain.
  try {
    if (args[0] === "daemon") {
      exitCode = 2;
      writeSync(
        2,
        "Operator client could not complete safely. OUTCOME UNKNOWN FROM CLIENT PERSPECTIVE; do not replay automatically.\n",
      );
    } else {
      const { presentOperatorError } = await import("../errors/index.js");
      writeSync(2, `${presentOperatorError(cause)}\n`);
    }
  } catch {
    // A closed/blocked stderr must not mask the failure exit code.
  }
}
process.exit(exitCode);
