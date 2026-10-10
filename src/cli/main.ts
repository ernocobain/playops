import { formatDoctorReport, runDoctor, type DoctorDeps } from "../doctor/doctor.js";
import { createLiveReviewComposition } from "../reviews/composition.js";
import { runDaemonCli, type DaemonCliDeps, type DaemonCliIo } from "./daemon.js";
import { runReviewsCli, type ReviewCliIo, type ReviewCompositionFactory } from "./reviews.js";
import { runReleasesCli, type ReleaseDryRunCliDeps, type ReleaseDryRunCliIo } from "./releases.js";
import { runHealthCli, type HealthCliDeps } from "./health.js";

export interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

export interface ReviewCliDeps {
  readonly io: ReviewCliIo;
  readonly compositionFactory: ReviewCompositionFactory;
}

export interface ReleaseCliDeps {
  readonly io: ReleaseDryRunCliIo;
  readonly dryRun: ReleaseDryRunCliDeps;
}

/** CLI logic without process.exit; review command composition is lazy. */
export async function runCli(
  args: readonly string[],
  doctorDeps: DoctorDeps,
  output: CliOutput,
  reviewDeps?: ReviewCliDeps,
  releaseDeps?: ReleaseCliDeps,
  healthDeps?: HealthCliDeps,
  daemonDeps?: DaemonCliDeps,
): Promise<0 | 1 | 2> {
  const command = args[0];
  if (command === "daemon") {
    // The operator client reads no config and never touches credentials/Google:
    // `daemon` is deliberately absent from runCliWithLogging's COMMANDS list.
    const io: DaemonCliIo = {
      write: (text: string) => output.log(text.endsWith("\n") ? text.slice(0, -1) : text),
      writeError: (text: string) => output.error(text),
    };
    return runDaemonCli(args.slice(1), io, daemonDeps);
  }
  if (command === "health") {
    const io = healthDeps?.io ?? {
      // CliOutput.log is line-oriented (console.log at the live entrypoint).
      write: (text: string) => output.log(text.endsWith("\n") ? text.slice(0, -1) : text),
      writeError: (text: string) => output.error(text),
    };
    return runHealthCli(args.slice(1), io, healthDeps);
  }
  if (command === "reviews") {
    const io = reviewDeps?.io ?? {
      write: (text: string) => output.log(text),
      writeError: (text: string) => output.error(text),
      isInteractive: false,
    };
    return runReviewsCli(
      args.slice(1),
      io,
      reviewDeps?.compositionFactory ?? createLiveReviewComposition,
    );
  }
  if (command === "releases") {
    const io = releaseDeps?.io ?? {
      write: (text: string) => output.log(text),
      writeError: (text: string) => output.error(text),
    };
    return runReleasesCli(args.slice(1), io, releaseDeps?.dryRun);
  }
  if (command === "doctor" && args.length === 1) {
    const report = await runDoctor(doctorDeps);
    output.log(formatDoctorReport(report));
    return report.exitCode;
  }

  if ((command === "--help" || command === "-h" || command === undefined) && args.length <= 1) {
    output.log(
      [
        "Usage: playops <command>",
        "",
        "Commands:",
        "  doctor    Verify config, credentials, and Google Play connectivity (read-only)",
        "  reviews   Triage reviews or prepare, approve, publish and verify a public reply",
        "  releases  Run an operator-bound release dry-run plan",
        "  health    Produce a dated health comparison report (stdout + saved file)",
        "  daemon    Operator client for the local PlayOps release daemon",
        "",
        "daemon group:",
        "  playops daemon status",
        "  playops daemon open prepare|execute",
        "  playops daemon notes attach",
        "  playops daemon commit prepare|execute",
        "  playops daemon verify prepare|execute",
        "  playops daemon reconcile prepare|execute",
        "",
        "The daemon endpoint is pinned to /run/playops/playops.sock (no override).",
        "Execute signatures are read from stdin and must come from an off-host signer.",
        "Mutating executes are never automatically retried. status is aggregate-only.",
      ].join("\n"),
    );
    return 0;
  }

  output.error('Unknown command or arguments. Run "playops --help".');
  return 1;
}
