import {
  MUTATING_RELEASE_TOOL_NAMES,
  renderReleaseDryRunPlan,
  type MutatingReleaseToolName,
  type ReleaseDryRunPlan,
} from "../releases/dry-run.js";

export interface ReleaseDryRunCliIo {
  write(message: string): void;
  writeError(message: string): void;
}

/**
 * Trusted operator-bound plan factory. It receives only a fixed capability name;
 * the factory owns the composition-bound intent and never receives model input.
 */
export interface ReleaseDryRunCliDeps {
  createPlan(toolName: MutatingReleaseToolName): Promise<ReleaseDryRunPlan>;
}

function isMutatingToolName(value: string): value is MutatingReleaseToolName {
  return MUTATING_RELEASE_TOOL_NAMES.some((toolName) => toolName === value);
}

/** Minimal Phase 4.14 operator syntax: `releases --dry-run <tool-name>`. */
export async function runReleasesCli(
  args: readonly string[],
  io: ReleaseDryRunCliIo,
  deps?: ReleaseDryRunCliDeps,
): Promise<0 | 1> {
  if (
    args.length !== 2 ||
    args[0] !== "--dry-run" ||
    args[1] === "--dry-run=false" ||
    typeof args[1] !== "string" ||
    !isMutatingToolName(args[1])
  ) {
    io.writeError(
      "Invalid release dry-run command. Use `playops releases --dry-run <mutating-release-tool>`.",
    );
    return 1;
  }
  if (!deps) {
    io.writeError(
      "No trusted composition-bound release operation is available; no API, credential, approval, or session access was performed.",
    );
    return 1;
  }
  try {
    const plan = await deps.createPlan(args[1]);
    if (plan.toolName !== args[1]) {
      io.writeError("Trusted dry-run plan did not match the requested release capability.");
      return 1;
    }
    io.write(renderReleaseDryRunPlan(plan));
    return 0;
  } catch {
    io.writeError("Release dry-run planning failed locally; no API call was executed.");
    return 1;
  }
}
