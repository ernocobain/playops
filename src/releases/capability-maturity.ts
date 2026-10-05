/** Code-owned live maturity policy. Never read configuration or approval evidence here. */
export const RELEASE_CAPABILITY_MATURITY = Object.freeze({
  "releases.update_rollout_fraction": "LIVE_BLOCKED_NOT_HARDENED",
  "releases.halt_rollout": "LIVE_BLOCKED_NOT_HARDENED",
  "releases.resume_rollout": "LIVE_BLOCKED_NOT_HARDENED",
} as const);

export type ReleaseCapabilityToolName = keyof typeof RELEASE_CAPABILITY_MATURITY;
export type ReleaseCapabilityMaturity = "LIVE_ALLOWED" | "LIVE_BLOCKED_NOT_HARDENED";
export type ReleaseCapabilityMaturityMap = Readonly<
  Record<ReleaseCapabilityToolName, ReleaseCapabilityMaturity>
>;

/** Fixed safe error: only a closed tool identifier is exposed, never operation input. */
export class ReleaseCapabilityBlockedError extends Error {
  override readonly name = "ReleaseCapabilityBlockedError";
  readonly code = "RELEASE_CAPABILITY_NOT_HARDENED";
  readonly externalStateUncertain = false;

  readonly toolName: ReleaseCapabilityToolName;

  constructor(toolName: ReleaseCapabilityToolName) {
    super("This release capability is not hardened for live execution.");
    if (typeof toolName !== "string" || !Object.hasOwn(RELEASE_CAPABILITY_MATURITY, toolName)) {
      throw new TypeError("Release capability tool name is invalid.");
    }
    this.toolName = toolName;
  }
}

/**
 * Pure maturity predicate. Alternate immutable policies are for unit transition
 * tests only; production construction always uses the assertion below instead.
 */
export function isReleaseCapabilityLiveAllowed(
  toolName: ReleaseCapabilityToolName,
  maturity: ReleaseCapabilityMaturityMap = RELEASE_CAPABILITY_MATURITY,
): boolean {
  return maturity[toolName] === "LIVE_ALLOWED";
}

/** Production gate: the authoritative frozen policy cannot be overridden. */
export function assertReleaseCapabilityLiveAllowed(toolName: ReleaseCapabilityToolName): void {
  if (typeof toolName !== "string" || !Object.hasOwn(RELEASE_CAPABILITY_MATURITY, toolName)) {
    throw new TypeError("Release capability tool name is invalid.");
  }
  const maturity: ReleaseCapabilityMaturityMap = RELEASE_CAPABILITY_MATURITY;
  if (maturity[toolName] !== "LIVE_ALLOWED") {
    throw new ReleaseCapabilityBlockedError(toolName);
  }
}
