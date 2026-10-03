import { formatDoctorReport, runDoctor, type DoctorDeps } from "../doctor/doctor.js";
import { createLiveReviewComposition } from "../reviews/composition.js";
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
): Promise<0 | 1 | 2> {
  const command = args[0];
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
      "Usage: playops <command>\n\nCommands:\n  doctor    Verify config, credentials, and Google Play connectivity (read-only)\n  reviews   Triage reviews or prepare, approve, publish and verify a public reply\n  releases  Run an operator-bound release dry-run plan\n  health    Produce a dated health comparison report (stdout + saved file)",
    );
    return 0;
  }

  output.error('Unknown command or arguments. Run "playops --help".');
  return 1;
}
