import { HealthError } from "./errors.js";
import type { HealthGranularity, HealthMetricKind } from "./index.js";

export class UnsupportedThresholdGranularityError extends HealthError {
  constructor(
    readonly granularity: HealthGranularity,
    readonly metricKinds: readonly HealthMetricKind[],
  ) {
    super(
      [
        `Health check granularity ${granularity} is not supported by`,
        `enabled threshold metric kind(s): ${metricKinds.join(", ")}.`,
      ].join(" "),
      "INVALID_ARGUMENT",
    );
  }
}
