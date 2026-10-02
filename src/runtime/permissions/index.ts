import {
  TOOL_PERMISSION_LEVELS,
  type RegisteredTool,
  type ToolPermissionLevel,
} from "../tools/index.js";

/**
 * Permission engine (Phase 2.2).
 *
 * Decides WHETHER a registered tool may proceed based on its permission
 * metadata and optional approval evidence. It never executes handlers,
 * prompts, persists approvals, or writes audit entries.
 */

export const APPROVAL_DECISIONS = Object.freeze(["approved", "denied"] as const);

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Minimal approval evidence; Phase 2.3 will create and persist these records. */
export interface ApprovalRecord {
  readonly toolName: string;
  readonly permission: ToolPermissionLevel;
  readonly decision: ApprovalDecision;
}

export type PermissionDecisionCode =
  "ALLOWED" | "APPROVAL_REQUIRED" | "APPROVAL_DENIED" | "INVALID_APPROVAL" | "INVALID_PERMISSION";

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly code: PermissionDecisionCode;
  readonly toolName: string;
  /** Echoes the tool's declared level; `null` when it is not a supported level. */
  readonly permission: ToolPermissionLevel | null;
  readonly requiresApproval: boolean;
}

/** Levels that need explicit human approval; recorded in PLAYOPS_PLAN.md principle 5. */
const APPROVAL_REQUIRED_LEVELS: ReadonlySet<ToolPermissionLevel> = new Set([
  "destructive",
  "publish",
]);

function isPermissionLevel(value: unknown): value is ToolPermissionLevel {
  return TOOL_PERMISSION_LEVELS.some((level) => level === value);
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return APPROVAL_DECISIONS.some((decision) => decision === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Structural check for evidence arriving through untyped boundaries. */
function isWellFormedApproval(value: unknown): value is ApprovalRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.toolName === "string" &&
    value.toolName.trim().length > 0 &&
    isPermissionLevel(value.permission) &&
    isApprovalDecision(value.decision)
  );
}

function decide(
  toolName: string,
  permission: ToolPermissionLevel | null,
  requiresApproval: boolean,
  code: PermissionDecisionCode,
): PermissionDecision {
  return Object.freeze({
    allowed: code === "ALLOWED",
    code,
    toolName,
    permission,
    requiresApproval,
  });
}

/**
 * Evaluate whether `tool` may proceed given optional `approval` evidence.
 *
 * - `read` / `write`: ALLOWED; approval evidence is ignored.
 * - `destructive` / `publish`: ALLOWED only with a well-formed record whose
 *   toolName and permission match exactly and whose decision is `approved`.
 * - Anything else fails closed as a DENY decision (never an exception).
 */
export function evaluateToolPermission(
  tool: RegisteredTool,
  approval?: ApprovalRecord,
): PermissionDecision {
  const candidate: unknown = tool;
  if (!isRecord(candidate)) return decide("", null, true, "INVALID_PERMISSION");

  const rawName = candidate.name;
  const toolName = typeof rawName === "string" && rawName.trim().length > 0 ? rawName : "";
  const permission = isPermissionLevel(candidate.permission) ? candidate.permission : null;

  if (toolName === "" || permission === null) {
    return decide(toolName, permission, true, "INVALID_PERMISSION");
  }

  if (!APPROVAL_REQUIRED_LEVELS.has(permission)) {
    return decide(toolName, permission, false, "ALLOWED");
  }

  if (approval === undefined || approval === null) {
    return decide(toolName, permission, true, "APPROVAL_REQUIRED");
  }
  if (!isWellFormedApproval(approval)) {
    return decide(toolName, permission, true, "INVALID_APPROVAL");
  }
  if (approval.toolName !== toolName || approval.permission !== permission) {
    return decide(toolName, permission, true, "INVALID_APPROVAL");
  }
  if (approval.decision === "denied") {
    return decide(toolName, permission, true, "APPROVAL_DENIED");
  }
  return decide(toolName, permission, true, "ALLOWED");
}
