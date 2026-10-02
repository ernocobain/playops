/**
 * Phase 5.1 — provider-neutral Reporting gateway for App Health metrics.
 *
 * The domain never sees a generated Google type: the gateway hands back
 * *untrusted* payloads (`unknown`) that Phase 5.1 re-validates. Package identity
 * and the metric-set resource name are owned by the adapter (composition-bound),
 * never by the model.
 */
import type {
  HealthDimension,
  HealthMetricKind,
  HealthMetricName,
  HealthTimelineSpec,
} from "./index.js";

export interface HealthMetricQueryRequest {
  readonly timelineSpec: HealthTimelineSpec;
  readonly dimensions: readonly HealthDimension[];
  readonly metrics: readonly HealthMetricName[];
  readonly pageSize: number;
  readonly pageToken?: string;
}

export interface HealthMetricQueryPage {
  readonly rows: readonly unknown[];
  readonly nextPageToken?: string;
}

export interface HealthMetricGateway {
  /** Read the metric-set resource for the kind. Untrusted payload (freshness only). */
  readMetricSet(kind: HealthMetricKind): Promise<unknown>;
  /** Query exactly one page of the metric set. Untrusted rows, API order preserved. */
  queryMetricSet(
    kind: HealthMetricKind,
    request: HealthMetricQueryRequest,
  ): Promise<HealthMetricQueryPage>;
}
