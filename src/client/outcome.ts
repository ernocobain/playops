/**
 * Closed-set handling of daemon response outcomes for the operator client.
 *
 * `parseDaemonResponse` validates the envelope, protocol version, secret-field
 * absence and outcome-constrained payloads, but it never checks that `outcome`
 * is a member of the 17-member `DaemonResponseOutcome` union (see R1). The
 * client must therefore fail closed on an unrecognized outcome instead of
 * inferring success or failure from an unknown verdict.
 *
 * The list is written `as const satisfies readonly DaemonResponseOutcome[]` and
 * paired with a compile-time exhaustiveness assertion, so a future protocol
 * union member cannot be silently missed by this module.
 */
import type { DaemonResponseOutcome } from "../daemon/protocol.js";

export const DAEMON_RESPONSE_OUTCOMES = Object.freeze([
  "status",
  "approval_required",
  "success",
  "approval_mismatch",
  "local_state_failure",
  "approval_expired",
  "request_not_found",
  "request_already_consumed",
  "request_claim_held",
  "operation_in_progress",
  "operation_unavailable",
  "config_invalid",
  "capability_blocked",
  "remote_failure",
  "external_state_ambiguous",
  "cleanup_pending",
  "protocol_error",
] as const) satisfies readonly DaemonResponseOutcome[];

type _UnlistedOutcome = Exclude<DaemonResponseOutcome, (typeof DAEMON_RESPONSE_OUTCOMES)[number]>;
/**
 * Compile-time guard: `_UnlistedOutcome` is `never` only while every union
 * member appears in `DAEMON_RESPONSE_OUTCOMES`. Adding a protocol outcome
 * without listing it here makes this initializer fail to type-check.
 */
const _outcomesExhaustive: _UnlistedOutcome extends never ? true : never = true;

/** Runtime membership set derived from the same source of truth. */
const KNOWN_OUTCOMES: ReadonlySet<string> = new Set(DAEMON_RESPONSE_OUTCOMES);

/** Raised when a daemon response carries an outcome outside the closed set. */
export class UnknownDaemonOutcomeError extends Error {
  override readonly name = "UnknownDaemonOutcomeError";

  constructor(readonly value: unknown) {
    super("Daemon response carried an outcome outside the closed protocol set.");
  }
}

export function isKnownOutcome(value: unknown): value is DaemonResponseOutcome {
  return typeof value === "string" && KNOWN_OUTCOMES.has(value);
}

/** Fail closed on an unknown outcome: never infer success or failure from it. */
export function assertKnownOutcome(value: unknown): asserts value is DaemonResponseOutcome {
  if (!isKnownOutcome(value)) throw new UnknownDaemonOutcomeError(value);
}

/**
 * Operator exit code for a recognized daemon outcome.
 *
 *   0 = the command did what it was asked (including a `prepare` that returned
 *       a valid `approval_required` challenge and exported it);
 *   1 = the request definitely did not succeed (usage, connect-before-dispatch,
 *       protocol error, approval/state/claim/operation failures, remote or
 *       local failures) — no external mutation is left ambiguous;
 *   2 = the client cannot determine the mutation outcome and operator recovery
 *       is required (`external_state_ambiguous`, `cleanup_pending`).
 *
 * This is intentionally different from the legacy CLI meaning of exit 2
 * ("declined / approval required") used by `playops reviews`/`health`; the
 * exact daemon outcome is always carried verbatim in text and `--json`.
 */
const OUTCOME_EXIT_CODES: Readonly<Record<DaemonResponseOutcome, 0 | 1 | 2>> = Object.freeze({
  status: 0,
  success: 0,
  approval_required: 0,
  approval_mismatch: 1,
  local_state_failure: 1,
  approval_expired: 1,
  request_not_found: 1,
  request_already_consumed: 1,
  request_claim_held: 1,
  operation_in_progress: 1,
  operation_unavailable: 1,
  config_invalid: 1,
  capability_blocked: 1,
  remote_failure: 1,
  protocol_error: 1,
  external_state_ambiguous: 2,
  cleanup_pending: 2,
});

export function exitCodeForOutcome(outcome: DaemonResponseOutcome): 0 | 1 | 2 {
  return OUTCOME_EXIT_CODES[outcome];
}
