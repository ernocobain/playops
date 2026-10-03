/** Phase 5.3 operator CLI. No package/credential, approval, threshold or model flags. */
import {
  parseHealthComparisonInput,
  type HealthComparisonToolInput,
  type HealthComparisonResult,
} from "../health/compare-tool.js";
import { createLiveHealthComposition, type HealthComposition } from "../health/composition.js";
import { HEALTH_COMPARISON_TOOL_NAME } from "../health/comparison.js";
import {
  createHealthReport,
  HealthReportError,
  resolveHealthReportDirectory,
  writeHealthReport,
} from "../health/report.js";
import { runAgent } from "../runtime/agent/index.js";
import type { LlmAdapter } from "../runtime/llm/index.js";

export class HealthCliError extends Error {
  override readonly name = "HealthCliError";
  readonly code = "CLI_ARGUMENT_INVALID";
  constructor(options?: ErrorOptions) {
    super('Invalid health command or arguments. Run "playops health report --help".', options);
  }
}

export type HealthCommand =
  | { readonly kind: "help" }
  | {
      readonly kind: "report";
      readonly input: HealthComparisonToolInput;
      readonly outputDir: string;
    };

const FLAGS = [
  "--current-start",
  "--current-end",
  "--baseline-start",
  "--baseline-end",
  "--granularity",
  "--output-dir",
  "--kinds",
  "--dimensions",
  "--metrics",
] as const;

/** Both --flag VALUE and --flag=VALUE; every flag at most once. */
export function parseHealthCommand(args: readonly string[]): HealthCommand {
  if (
    args.length === 0 ||
    (args.length === 1 && args[0] === "--help") ||
    (args.length === 2 && args[0] === "report" && args[1] === "--help")
  )
    return Object.freeze({ kind: "help" });
  if (args[0] !== "report") throw new HealthCliError();
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (!FLAGS.some((allowed) => allowed === flag) || values.has(flag)) throw new HealthCliError();
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || value.startsWith("--") || value.trim() === "")
      throw new HealthCliError();
    values.set(flag, value);
  }
  const outputDir = values.get("--output-dir");
  // Reject unsafe path text; realpath/directory validation happens before composition.
  // eslint-disable-next-line no-control-regex -- paths must not carry terminal controls or NUL
  if (!outputDir || outputDir !== outputDir.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(outputDir)) {
    throw new HealthCliError();
  }
  const list = (flag: string): readonly string[] | undefined => {
    const value = values.get(flag);
    if (value === undefined) return undefined;
    const entries = value.split(",");
    if (entries.some((entry) => entry === "" || entry !== entry.trim())) throw new HealthCliError();
    return Object.freeze(entries);
  };
  try {
    const kinds = list("--kinds");
    const dimensions = list("--dimensions");
    const metrics = list("--metrics");
    const input = parseHealthComparisonInput({
      current: { startTime: values.get("--current-start"), endTime: values.get("--current-end") },
      baseline: {
        startTime: values.get("--baseline-start"),
        endTime: values.get("--baseline-end"),
      },
      granularity: values.get("--granularity"),
      ...(kinds !== undefined ? { kinds } : {}),
      ...(dimensions !== undefined ? { dimensions } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
    });
    return Object.freeze({ kind: "report", input, outputDir });
  } catch (cause) {
    throw new HealthCliError({ cause });
  }
}

export interface HealthCliIo {
  /** Raw text, including its terminal LF; implementations must not add another LF. */
  write(text: string): void | Promise<void>;
  writeError(text: string): void;
}
export interface HealthCliDeps {
  readonly io?: HealthCliIo;
  readonly compositionFactory?: () => Promise<HealthComposition>;
  /** Report generation clock only (one read), not the audit/runtime clock. */
  readonly now?: () => Date;
}

const HELP = [
  "Usage: playops health report",
  "  --current-start UTC --current-end UTC",
  "  --baseline-start UTC --baseline-end UTC",
  "  --granularity DAILY|HOURLY --output-dir EXISTING_DIRECTORY",
  "  [--kinds KIND[,KIND...]] [--dimensions NAME[,NAME...]] [--metrics NAME[,NAME...]]",
  "",
  "UTC timestamps: YYYY-MM-DDTHH:MM:SSZ; start inclusive, end exclusive; equal period counts.",
  "DAILY: America/Los_Angeles midnight expressed in UTC (DST-aware). HOURLY: UTC hour boundaries.",
  "Kinds default to crash_rate,anr_rate,excessive_wakeup_rate; excessive wakeups supports DAILY only.",
  "Explicit metrics must be supported by every selected kind; default: each kind's primary metric.",
  "Options may use --name VALUE or --name=VALUE, once each. No natural-language dates.",
  "Output directory must already exist. Dated UTF-8/LF report; existing targets are never overwritten.",
  "Package and credentials come only from config. No LLM provider is required.",
  "",
].join("\n");

/** Same command-driven runtime convention as reviews; no provider/LLM reasoning. */
async function compareForReport(
  composition: HealthComposition,
  input: HealthComparisonToolInput,
): Promise<HealthComparisonResult> {
  let turn = 0;
  const adapter: LlmAdapter = {
    provider: "deterministic-health-cli",
    async complete() {
      turn += 1;
      if (turn === 1)
        return {
          toolCalls: [{ id: "health-report", name: HEALTH_COMPARISON_TOOL_NAME, arguments: input }],
          usage: { totalTokens: 0 },
        };
      return { content: "Health comparison completed.", toolCalls: [], usage: { totalTokens: 0 } };
    },
  };
  const result = await runAgent({
    llm: adapter,
    registry: composition.registry,
    bindings: [composition.comparisonTool.binding],
    messages: [{ role: "user", content: "Execute the explicit health comparison." }],
    limits: { maxSteps: 2, maxToolCalls: 1, maxTotalTokens: 1 },
    ledger: composition.ledger,
  });
  if (!result.ok) throw new Error("Health comparison did not complete.", { cause: result.cause });
  const messages = result.conversation.filter((entry) => entry.role === "tool");
  if (messages.length !== 1 || messages[0]?.role !== "tool")
    throw new Error("Missing comparison result.");
  const payload: unknown = JSON.parse(messages[0].content);
  return composition.comparisonTool.tool.outputSchema.parse(payload);
}

/** Invalid arguments/config/source/storage → 1; descriptive changes/unavailable data → 0. */
export async function runHealthCli(
  args: readonly string[],
  io: HealthCliIo,
  deps: HealthCliDeps = {},
): Promise<0 | 1> {
  let command: HealthCommand;
  try {
    command = parseHealthCommand(args);
  } catch {
    io.writeError('Invalid health command or arguments. Run "playops health report --help".');
    return 1;
  }
  if (command.kind === "help") {
    try {
      await io.write(HELP);
      return 0;
    } catch {
      io.writeError("Health command help could not be written to stdout.");
      return 1;
    }
  }
  let directory: string;
  try {
    directory = await resolveHealthReportDirectory(command.outputDir);
  } catch {
    io.writeError("Health report output failed: --output-dir must name an existing directory.");
    return 1;
  }
  let composition: HealthComposition;
  try {
    composition = await (deps.compositionFactory ?? createLiveHealthComposition)();
  } catch {
    io.writeError(
      "Health report configuration could not be initialized. Check Google Play and audit settings.",
    );
    return 1;
  }
  let comparison: HealthComparisonResult;
  try {
    comparison = await compareForReport(composition, command.input);
  } catch {
    io.writeError("Health comparison failed. No report was saved.");
    return 1;
  }
  let report;
  try {
    report = createHealthReport(comparison, deps.now);
  } catch {
    io.writeError("Health report rendering failed. No report was saved.");
    return 1;
  }
  try {
    await writeHealthReport(directory, report);
  } catch (error) {
    io.writeError(
      error instanceof HealthReportError && error.code === "REPORT_EXISTS"
        ? "Health report output failed: report already exists; nothing was overwritten."
        : "Health report output failed. No report was printed; inspect the output directory before retrying.",
    );
    return 1;
  }
  try {
    // EXACTLY the string saved above, once; no extra saved-path/status line.
    await io.write(report.text);
  } catch {
    io.writeError(
      "Health report was saved, but stdout could not be written. The file was retained.",
    );
    return 1;
  }
  return 0;
}
