/**
 * Human and machine renderers for the operator client.
 *
 * SEMANTIC AUTHORITY
 * ==================
 * The only human semantic authority is the parsed `ApprovalStatement` V1 carried
 * in `approvalStatementCanonical`. The daemon `summary` is never authorization
 * data: it appears only as "DAEMON SUMMARY (UNVERIFIED)". Per R6 the client
 * display is explicitly a convenience for the operator; the off-host signer's
 * own rendering of the exported challenge is the authoritative approval.
 *
 * NEVER TRUNCATE
 * ==============
 * Authorization semantics are emitted byte-exact: no ellipsis, no "…", no
 * wrapping that rewrites values. If a statement is too large to render safely,
 * the renderer emits a directive to use `--json`/`--out` instead of a partial
 * statement.
 */
import { parseApprovalStatementCanonical, type ApprovalStatement } from "../approvals/statement.js";
import type { DaemonApprovalChallenge, DaemonResponseEnvelope } from "../daemon/protocol.js";
import { validateApprovalChallenge } from "./approval.js";
import type { DaemonResponseOutcome } from "../daemon/protocol.js";
import type { DaemonTransportFailure } from "./transport.js";

/** Upper bound on a single human statement render; above it we refuse to truncate. */
export const HUMAN_RENDER_MAX_CHARS = 200_000;

export const ATTACH_NOTES_WARNING = [
  "WARNING: `daemon notes attach` performs a REAL remote Google Play release-notes update.",
  "It does NOT publish or commit, and it does NOT require a human approval signature.",
  "If the response is lost, the remote outcome is uncertain, and this request is NEVER",
  "automatically retried.",
].join("\n");

const OUTCOME_LABEL: Readonly<Record<DaemonResponseOutcome, string>> = Object.freeze({
  status: "status reported",
  approval_required: "approval required (prepare succeeded)",
  success: "success",
  approval_mismatch: "approval mismatch",
  local_state_failure: "local state failure (no remote mutation began)",
  approval_expired: "approval expired",
  request_not_found: "request not found (no mutation occurred)",
  request_already_consumed: "request already consumed",
  request_claim_held: "request claim held",
  operation_in_progress: "operation already in progress",
  operation_unavailable: "operation unavailable in this daemon build",
  config_invalid: "daemon configuration invalid",
  capability_blocked: "capability blocked by policy",
  remote_failure: "remote failure",
  external_state_ambiguous: "EXTERNAL STATE AMBIGUOUS — operator recovery required",
  cleanup_pending: "cleanup pending — operator recovery required",
  protocol_error: "protocol error",
});

const OUTCOME_GUIDANCE: Readonly<Record<DaemonResponseOutcome, string>> = Object.freeze({
  status: "",
  approval_required:
    "Export the challenge for the off-host signer, then re-run the matching execute with the signature on stdin.",
  success: "",
  approval_mismatch: "The signature did not match this request. Do not retry blindly.",
  local_state_failure:
    "Durable local state failed before any remote mutation; the request was not started.",
  approval_expired: "The pending request expired. Prepare a fresh challenge.",
  request_not_found: "No pending request exists for that request id. Prepare a fresh challenge.",
  request_already_consumed: "That request was already executed and cannot be reused.",
  request_claim_held: "Another execution holds the claim. Wait; never replay.",
  operation_in_progress: "Another mutating execution is in progress for this package.",
  operation_unavailable: "This daemon build does not serve that operation.",
  config_invalid: "Fix the daemon configuration.",
  capability_blocked: "Product capability policy blocked this operation.",
  remote_failure: "The remote operation failed. Inspect before retrying.",
  external_state_ambiguous:
    "Do NOT retry. The client cannot determine whether the mutation happened; use `daemon status` and the durable journal.",
  cleanup_pending:
    "Do NOT retry. Cleanup is pending; operator recovery is required using the durable journal.",
  protocol_error:
    "The daemon rejected the request at the protocol boundary; nothing was dispatched.",
});

function t(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value) ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boolean(value: unknown): string {
  return value === true ? "true" : value === false ? "false" : t(value);
}

function renderNotes(notes: unknown, out: string[]): void {
  const entries = list(notes);
  if (entries.length === 0) {
    out.push("    notes: (none)");
    return;
  }
  out.push("    notes:");
  for (const entry of entries) {
    const note = rec(entry);
    // Byte-exact: the exact locale and the exact note text, never truncated.
    out.push(`      [${t(note.language)}] ${t(note.text)}`);
  }
}

function renderCandidate(candidate: unknown, out: string[]): void {
  const c = rec(candidate);
  out.push(`  target track: ${t(c.track)}`);
  const releases = list(c.releases);
  if (releases.length === 0) {
    out.push("  releases: (none)");
    return;
  }
  out.push("  every release in the target track:");
  for (const entry of releases) {
    const release = rec(entry);
    out.push(`    release: ${t(release.name)}`);
    out.push(`      status: ${t(release.status)}`);
    out.push(`      rollout (userFraction): ${t(release.userFraction)}`);
    out.push(`      inAppUpdatePriority: ${t(release.inAppUpdatePriority)}`);
    out.push(`      versionCodes: ${list(release.versionCodes).map(t).join(", ")}`);
    const targeting = release.countryTargeting;
    if (targeting === null || targeting === undefined) {
      out.push("      countryTargeting: (none)");
    } else {
      const ct = rec(targeting);
      out.push(
        `      countryTargeting: countries=[${list(ct.countries).map(t).join(", ")}] includeRestOfWorld=${boolean(ct.includeRestOfWorld)}`,
      );
    }
    renderNotes(release.releaseNotes, out);
  }
}

function renderOpenEdit(facts: Record<string, unknown>, out: string[]): void {
  out.push(`  destructive operation: open one Google Play edit`);
  out.push(`  expected local-session state: ${t(facts.expectedLocalSession)}`);
  out.push(
    "  active-edit invalidation/loss: creating this edit may invalidate another active edit owned by this API user for this app and lose uncommitted work.",
  );
}

function renderCommit(facts: Record<string, unknown>, out: string[]): void {
  out.push(`  operation: commit`);
  out.push(`  target track: ${t(facts.targetTrack)}`);
  out.push(`  versionCode: ${t(facts.versionCode)}`);
  out.push(`  release name: ${t(facts.releaseName)}`);
  out.push(`  release status: ${t(facts.releaseStatus)}`);
  out.push(`  rollout fraction: ${t(facts.rolloutFraction)}`);
  out.push(`  note languages: ${list(facts.noteLanguages).map(t).join(", ")}`);
  out.push(`  changes-in-review behavior: ${t(facts.changesInReviewBehavior)}`);
  out.push(`  changesNotSentForReview: ${boolean(facts.changesNotSentForReview)}`);
  out.push(
    "  review consequence: an existing in-review state fails rather than being cancelled (ERROR_IF_IN_REVIEW).",
  );
  renderCandidate(facts.targetTrackCandidate, out);
}

function renderVerify(facts: Record<string, unknown>, out: string[]): void {
  out.push(`  operation: verify committed release`);
  out.push(`  target track: ${t(facts.targetTrack)}`);
  out.push(`  versionCode: ${t(facts.versionCode)}`);
  out.push(`  expected release name: ${t(facts.expectedReleaseName)}`);
  out.push(
    `  archived historical note text available: ${boolean(facts.archivedNoteTextAvailable)}`,
  );
  out.push("  purpose: read-only verification by target-track fingerprint comparison.");
  out.push(
    "  temporary-edit lifecycle: at most one temporary edit is created and deleted exactly once, guarded, with retries disabled.",
  );
  out.push("  this does NOT publish, commit, upload, or write release notes.");
}

function renderReconcile(facts: Record<string, unknown>, out: string[]): void {
  out.push(`  operation: reconcile commit`);
  out.push(`  target track: ${t(facts.targetTrack)}`);
  out.push(`  versionCode: ${t(facts.versionCode)}`);
  out.push(`  release name: ${t(facts.releaseName)}`);
  out.push(`  release status: ${t(facts.releaseStatus)}`);
  out.push(`  attempt id: ${t(facts.attemptId)}`);
  out.push(`  attempt state: ${t(facts.attemptState)}`);
  out.push(`  recovery mode: ${t(facts.mode)}`);
  out.push(`  original edit status: ${t(facts.originalEditStatus)}`);
  out.push(`  commit acknowledged: ${boolean(facts.commitAcknowledged)}`);
  out.push(
    `  archived historical note text available: ${boolean(facts.archivedNoteTextAvailable)}`,
  );
  out.push(
    "  original-edit inspection rule: inspect the original edit first; never delete it and never retry or perform a commit.",
  );
  out.push(
    `  temporary verification: insert attempted=${boolean(facts.verificationInsertAttempted)} identity available=${boolean(facts.temporaryEditIdentityAvailable)} pre-delete read verified=${boolean(facts.verificationPreDeleteReadVerified)}`,
  );
  out.push(
    `  cleanup rule: delete attempted=${boolean(facts.verificationDeleteAttempted)} acknowledged=${boolean(facts.verificationDeleteAcknowledged)} cleanup verified=${boolean(facts.verificationCleanupVerified)}; confirm cleanup before accepting durable proof.`,
  );
  out.push(
    `  possible outcomes: committed / not committed / ambiguous — observed classification: ${t(facts.observedClassification)}.`,
  );
  out.push("  no raw journal content is shown; only the derived facts above.");
}

function renderIntegrity(statement: ApprovalStatement, out: string[]): void {
  const integrity = statement.integrity;
  if (integrity === undefined) return;
  for (const [key, value] of Object.entries(integrity)) {
    out.push(`  ${key}: ${t(value)}`);
  }
}

/**
 * Render one validated approval challenge as a labelled human statement. The
 * four required sections are always present; the canonical signing payload and
 * statement preimage follow under their own headings.
 */
export function renderApprovalStatement(
  challenge: DaemonApprovalChallenge,
  summary?: string,
): string {
  const validated = validateApprovalChallenge(challenge);
  const statement = parseApprovalStatementCanonical(validated.approvalStatementCanonical);
  const out: string[] = [];
  out.push("APPROVAL REQUIRED");
  out.push(
    "This display is a convenience for the operator. The off-host signer's own rendering of the",
  );
  out.push("exported challenge is the authoritative human-readable approval.");
  if (summary !== undefined) out.push(`DAEMON SUMMARY (UNVERIFIED): ${summary}`);
  out.push("");
  out.push("SEMANTIC AUTHORIZATION");
  out.push(`  operation: ${statement.operation}`);
  out.push(`  permission: ${statement.permission}`);
  out.push(`  package: ${statement.packageName}`);
  out.push(`  tool: ${statement.toolName}`);
  if (statement.operation === "open_edit") renderOpenEdit(rec(statement.facts), out);
  else if (statement.operation === "commit") renderCommit(rec(statement.facts), out);
  else if (statement.operation === "verify_committed") renderVerify(rec(statement.facts), out);
  else renderReconcile(rec(statement.facts), out);
  out.push("");
  out.push("CONSEQUENCES");
  for (const consequence of statement.consequences) out.push(`  - ${consequence}`);
  out.push("");
  out.push("INTEGRITY FINGERPRINTS (never the semantic facts)");
  out.push(`  requestDigest: ${validated.requestDigest}`);
  renderIntegrity(statement, out);
  out.push("");
  out.push("REQUEST / EXPIRY");
  out.push(`  requestId: ${validated.requestId}`);
  out.push(`  expiresAtUtc: ${validated.expiresAtUtc}`);
  out.push("");
  out.push("CANONICAL SIGNING PAYLOAD (sign these exact bytes; base64url signature via stdin)");
  out.push(validated.canonicalPayload);
  out.push("");
  out.push("APPROVAL STATEMENT PREIMAGE (canonical)");
  out.push(validated.approvalStatementCanonical);

  const text = `${out.join("\n")}\n`;
  // Refuse terminal-control and bidi-override authorization data without a
  // literal control-character regex.
  const unsafeTerminalText = [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 0x08 ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
  if (text.length > HUMAN_RENDER_MAX_CHARS || unsafeTerminalText) {
    return [
      "The approval statement cannot be shown safely and completely in this terminal.",
      "No partial signable statement is displayed. Use the complete --out export and",
      "the off-host signer's independent display; --json preserves the canonical strings.",
      `Request already prepared: ${validated.requestId}; do not automatically prepare again.`,
      "",
    ].join("\n");
  }
  return text;
}

/** Render a `status` outcome. Aggregate-only: counts cannot resolve one request id. */
export function renderStatus(response: DaemonResponseEnvelope): string {
  const out: string[] = ["DAEMON STATUS"];
  const summary = response.summary;
  if (summary === undefined) {
    out.push("  (status carried no summary)");
  } else {
    for (const token of summary.split(" ")) {
      const index = token.indexOf("=");
      if (index === -1) out.push(`  ${token}`);
      else out.push(`  ${token.slice(0, index)}: ${token.slice(index + 1)}`);
    }
  }
  out.push("");
  out.push("NOTE: status is aggregate only. These counts cannot resolve a specific requestId.");
  out.push("status is NOT recovery: never infer a specific success or failure from it alone.");
  out.push("");
  return out.join("\n");
}

/** Render a non-approval daemon outcome (success / failure / ambiguity). */
export function renderOutcome(response: DaemonResponseEnvelope): string {
  const out: string[] = [`OUTCOME: ${response.outcome}`, `  ${OUTCOME_LABEL[response.outcome]}`];
  if (response.summary !== undefined) out.push(`  summary: ${response.summary}`);
  if (response.error !== undefined)
    out.push(`  error: ${response.error.code} — ${response.error.message}`);
  if (response.requestId !== undefined) out.push(`  looked for requestId: ${response.requestId}`);
  if (response.operation !== undefined) out.push(`  operation: ${response.operation}`);
  const guidance = OUTCOME_GUIDANCE[response.outcome];
  if (guidance.length > 0) out.push(`  guidance: ${guidance}`);
  out.push("");
  return out.join("\n");
}

/** Human rendering entry point for a successfully parsed daemon response. */
export function renderHumanResponse(response: DaemonResponseEnvelope): string {
  if (response.outcome === "status") return renderStatus(response);
  if (response.outcome === "approval_required" && response.approval !== undefined) {
    return renderApprovalStatement(response.approval, response.summary);
  }
  return renderOutcome(response);
}

/**
 * Stable machine output. Preserves `outcome`, `correlationId`, `error`, the
 * `approval` object and any safe payload WITHOUT rewriting the canonical strings.
 */
export function renderMachineResponse(response: DaemonResponseEnvelope): string {
  const ordered: Record<string, unknown> = {
    protocolVersion: response.protocolVersion,
    correlationId: response.correlationId,
    outcome: response.outcome,
  };
  if (response.summary !== undefined) ordered.summary = response.summary;
  if (response.error !== undefined) {
    ordered.error = { code: response.error.code, message: response.error.message };
  }
  if (response.requestId !== undefined) ordered.requestId = response.requestId;
  if (response.operation !== undefined) ordered.operation = response.operation;
  if (response.approval !== undefined) ordered.approval = response.approval;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Machine rendering of a local transport failure (no daemon response exists). */
export function renderMachineTransportFailure(failure: DaemonTransportFailure): string {
  return `${JSON.stringify(
    {
      outcome: "transport_failure",
      failure: {
        kind: failure.kind,
        message: failure.message,
        possibleDispatch: failure.possibleDispatch,
        ...(failure.requestKind === undefined ? {} : { requestKind: failure.requestKind }),
        outcomeUnknown: failure.exitCode === 2,
        exitCode: failure.exitCode,
      },
    },
    null,
    2,
  )}\n`;
}

export function renderHumanTransportFailure(failure: DaemonTransportFailure): string {
  const out = [`TRANSPORT FAILURE: ${failure.kind}`];
  out.push(`  ${failure.message}`);
  if (failure.possibleDispatch) {
    if (failure.exitCode === 2) {
      out.push("  OUTCOME UNKNOWN FROM CLIENT PERSPECTIVE. No automatic resend or recovery.");
      if (failure.requestKind?.startsWith("prepare_")) {
        out.push("  Prepare outcome unknown; another prepare may create another pending request.");
      } else {
        out.push("  Disconnect does not cancel daemon work; durable settlement may have occurred.");
      }
      out.push(
        "  status is aggregate only and cannot resolve this request. Inspect authoritative recovery evidence before acting.",
      );
    } else {
      out.push(
        "  A read-only status response was unavailable; no mutation is authorized by status.",
      );
    }
  } else {
    out.push("  No remote mutation is possible from this failure.");
  }
  out.push("");
  return out.join("\n");
}
