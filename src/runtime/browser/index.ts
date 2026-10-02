/**
 * Phase 2.7 — Browser-fallback SKELETON (interface-only).
 *
 * OFFICIAL API FIRST. Browser automation may only be considered when a required
 * operation is not available through a supported Google API (API_UNAVAILABLE) or
 * the API cannot expose the required state/capability (API_CAPABILITY_GAP), AND
 * that gap is explicitly documented in `reason.apiGap` before use. Operational
 * failures (429/500/timeouts/403 setup problems) are never fallback reasons.
 *
 * This module contains NO browser implementation: no launcher, no library, no
 * navigation, no page/element handles, and no login or state-persistence model.
 * Future execution must still pass through the shared permission engine,
 * approval gate, verification model, and audit (Phases 2.2–2.4); this module
 * deliberately imports only the permission-level contract from Phase 2.1 and is
 * not wired into the Phase 2.6 agent loop.
 */
import { TOOL_PERMISSION_LEVELS, type ToolPermissionLevel } from "../tools/index.js";

const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)*$/;

/** The only reasons that can justify browser fallback. Deliberately closed. */
export const BROWSER_FALLBACK_REASON_CODES = Object.freeze([
  "API_UNAVAILABLE",
  "API_CAPABILITY_GAP",
] as const);
export type BrowserFallbackReasonCode = (typeof BROWSER_FALLBACK_REASON_CODES)[number];

export interface BrowserCapability {
  readonly name: string;
  readonly description: string;
  /** Reuses the PlayOps permission levels; no browser-specific enum. */
  readonly permission: ToolPermissionLevel;
}

export interface BrowserFallbackReason {
  readonly code: BrowserFallbackReasonCode;
  readonly description: string;
  /** Explicit, nonblank description of the documented official-API gap. */
  readonly apiGap: string;
}

export interface BrowserFallbackRequest {
  readonly capability: string;
  readonly reason: BrowserFallbackReason;
  /** Safe logical identifier supplied by the caller; never a location, query, or page payload. */
  readonly target: string;
  readonly permission: ToolPermissionLevel;
}

export type BrowserFallbackStatus = "completed" | "failed" | "unsupported";

/** Shape a provider adapter returns; PlayOps normalizes it and drops everything else. */
export interface BrowserFallbackAdapterResult {
  readonly status: BrowserFallbackStatus;
  /** Provider-reported flag only; PlayOps verification (Phase 2.4) is a separate future step. */
  readonly verified: boolean;
}

export interface BrowserFallbackResult {
  readonly status: BrowserFallbackStatus;
  readonly provider: string;
  readonly capability: string;
  readonly permission: ToolPermissionLevel;
  readonly verified: boolean;
}

export interface BrowserFallbackAdapter {
  readonly provider: string;
  capabilities(): readonly BrowserCapability[];
  execute(request: BrowserFallbackRequest): Promise<BrowserFallbackAdapterResult>;
}

export type BrowserFallbackErrorCode =
  "INVALID_REQUEST" | "CAPABILITY_UNSUPPORTED" | "FALLBACK_NOT_ELIGIBLE" | "ADAPTER_FAILURE";

export class BrowserFallbackError extends Error {
  readonly code: BrowserFallbackErrorCode;
  readonly decisionCode?: BrowserFallbackDecisionCode;

  constructor(
    code: BrowserFallbackErrorCode,
    message: string,
    options?: { cause?: unknown; decisionCode?: BrowserFallbackDecisionCode },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserFallbackError";
    this.code = code;
    if (options?.decisionCode !== undefined) this.decisionCode = options.decisionCode;
  }
}

export type BrowserFallbackDecisionCode =
  | "ELIGIBLE"
  | "INVALID_REQUEST"
  | "ADAPTER_INVALID"
  | "REASON_NOT_RECOGNIZED"
  | "API_GAP_UNDOCUMENTED"
  | "CAPABILITY_UNSUPPORTED"
  | "PERMISSION_MISMATCH";

export type BrowserFallbackDecision =
  | Readonly<{
      eligible: true;
      code: "ELIGIBLE";
      provider: string;
      capability: string;
      permission: ToolPermissionLevel;
      reasonCode: BrowserFallbackReasonCode;
    }>
  | Readonly<{ eligible: false; code: Exclude<BrowserFallbackDecisionCode, "ELIGIBLE"> }>;

export interface BrowserCapabilitySet {
  get(name: string): BrowserCapability | undefined;
  list(): readonly BrowserCapability[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPermissionLevel(value: unknown): value is ToolPermissionLevel {
  return (TOOL_PERMISSION_LEVELS as readonly unknown[]).includes(value);
}

function isReasonCode(value: unknown): value is BrowserFallbackReasonCode {
  return (BROWSER_FALLBACK_REASON_CODES as readonly unknown[]).includes(value);
}

/** Validates and freezes declared capabilities; throws INVALID_REQUEST on any defect or duplicate. */
export function createBrowserCapabilitySet(
  capabilities: readonly BrowserCapability[],
): BrowserCapabilitySet {
  if (!Array.isArray(capabilities)) {
    throw new BrowserFallbackError("INVALID_REQUEST", "Capabilities must be an array.");
  }
  const byName = new Map<string, BrowserCapability>();
  for (const candidate of capabilities as readonly unknown[]) {
    if (!isRecord(candidate)) {
      throw new BrowserFallbackError("INVALID_REQUEST", "Capability must be an object.");
    }
    const { name, description, permission } = candidate;
    if (!isNonblank(name) || !CAPABILITY_NAME_PATTERN.test(name)) {
      throw new BrowserFallbackError("INVALID_REQUEST", "Capability name is invalid.");
    }
    if (!isNonblank(description)) {
      throw new BrowserFallbackError("INVALID_REQUEST", "Capability description is required.");
    }
    if (!isPermissionLevel(permission)) {
      throw new BrowserFallbackError(
        "INVALID_REQUEST",
        "Capability permission is not a PlayOps permission level.",
      );
    }
    if (byName.has(name)) {
      throw new BrowserFallbackError("INVALID_REQUEST", `Duplicate capability name "${name}".`);
    }
    byName.set(name, Object.freeze({ name, description, permission }));
  }
  const frozenList = Object.freeze([...byName.values()]);
  return Object.freeze({
    get: (name: string) => byName.get(name),
    list: () => frozenList,
  });
}

function deny(code: Exclude<BrowserFallbackDecisionCode, "ELIGIBLE">): BrowserFallbackDecision {
  return Object.freeze({ eligible: false as const, code });
}

/**
 * Pure, fail-closed eligibility policy. Never invokes the adapter's execute,
 * never throws for policy denials, never consults permissions/approvals.
 */
export function evaluateBrowserFallbackEligibility(
  adapter: BrowserFallbackAdapter,
  request: BrowserFallbackRequest,
): BrowserFallbackDecision {
  if (!isRecord(request)) return deny("INVALID_REQUEST");
  const { capability, reason, target, permission } = request;
  if (!isNonblank(capability) || !isNonblank(target) || !isPermissionLevel(permission)) {
    return deny("INVALID_REQUEST");
  }
  if (!isRecord(reason)) return deny("INVALID_REQUEST");

  if (
    !isRecord(adapter) ||
    !isNonblank(adapter.provider) ||
    typeof adapter.capabilities !== "function"
  ) {
    return deny("ADAPTER_INVALID");
  }
  let capabilities: BrowserCapabilitySet;
  try {
    capabilities = createBrowserCapabilitySet(adapter.capabilities());
  } catch {
    return deny("ADAPTER_INVALID");
  }

  if (!isReasonCode(reason.code)) return deny("REASON_NOT_RECOGNIZED");
  if (!isNonblank(reason.apiGap)) return deny("API_GAP_UNDOCUMENTED");

  const declared = capabilities.get(capability);
  if (declared === undefined) return deny("CAPABILITY_UNSUPPORTED");
  if (declared.permission !== permission) return deny("PERMISSION_MISMATCH");

  return Object.freeze({
    eligible: true as const,
    code: "ELIGIBLE" as const,
    provider: adapter.provider,
    capability: declared.name,
    permission: declared.permission,
    reasonCode: reason.code,
  });
}

function normalizeAdapterResult(value: unknown): BrowserFallbackAdapterResult {
  if (!isRecord(value)) {
    throw new BrowserFallbackError("ADAPTER_FAILURE", "Adapter returned a malformed result.");
  }
  const { status, verified } = value;
  if (status !== "completed" && status !== "failed" && status !== "unsupported") {
    throw new BrowserFallbackError("ADAPTER_FAILURE", "Adapter returned an unknown status.");
  }
  if (typeof verified !== "boolean") {
    throw new BrowserFallbackError(
      "ADAPTER_FAILURE",
      "Adapter returned a non-boolean verified flag.",
    );
  }
  return { status, verified };
}

/**
 * Optional narrow execution boundary: eligibility first, adapter only afterwards.
 * Does NOT integrate permission decisions, approvals, verification, audit, or the
 * agent loop — those remain mandatory for any future real use and are composed
 * elsewhere. Raw adapter errors are never surfaced in the message.
 */
export async function executeBrowserFallback(
  adapter: BrowserFallbackAdapter,
  request: BrowserFallbackRequest,
): Promise<BrowserFallbackResult> {
  const decision = evaluateBrowserFallbackEligibility(adapter, request);
  if (!decision.eligible) {
    throw new BrowserFallbackError(
      "FALLBACK_NOT_ELIGIBLE",
      `Browser fallback not eligible (${decision.code}).`,
      { decisionCode: decision.code },
    );
  }
  let raw: unknown;
  try {
    raw = await adapter.execute(request);
  } catch (cause) {
    throw new BrowserFallbackError("ADAPTER_FAILURE", "Browser fallback adapter failed.", {
      cause,
    });
  }
  const normalized = normalizeAdapterResult(raw);
  return Object.freeze({
    status: normalized.status,
    provider: decision.provider,
    capability: decision.capability,
    permission: decision.permission,
    verified: normalized.verified,
  });
}
