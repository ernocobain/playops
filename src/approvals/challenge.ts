/** Pure challenge validation/decoding. No signing, key loading, I/O or client connector. */
import { Buffer } from "node:buffer";
import {
  encodeOperatorApprovalPayload,
  OPERATOR_APPROVAL_DOMAIN,
} from "../runtime/approvals/operator-signature.js";
import type { DaemonApprovalChallenge } from "../daemon/protocol.js";
import { approvalStatementDigest, parseApprovalStatementCanonical } from "./statement.js";

const FIELDS = [
  "requestId",
  "nonce",
  "toolName",
  "permission",
  "packageName",
  "requestDigest",
  "expiresAtUtc",
] as const;
/** UTF8 byte lengths, not JS character counts; fixed order, domain and complete consumption. */
export function decodeApprovalPayload(canonical: string): Record<(typeof FIELDS)[number], string> {
  const bytes = Buffer.from(canonical, "utf8");
  const prefix = Buffer.from(`${OPERATOR_APPROVAL_DOMAIN}\nversion=1\n`, "utf8");
  if (!bytes.subarray(0, prefix.length).equals(prefix))
    throw new TypeError("Invalid approval payload domain.");
  let offset = prefix.length;
  const values: Partial<Record<(typeof FIELDS)[number], string>> = {};
  for (const name of FIELDS) {
    const label = Buffer.from(`${name}=`);
    if (!bytes.subarray(offset, offset + label.length).equals(label))
      throw new TypeError("Invalid approval payload field order.");
    offset += label.length;
    const colon = bytes.indexOf(58, offset);
    const count = bytes.subarray(offset, colon).toString("ascii");
    if (colon < offset || !/^[1-9][0-9]{0,2}$/u.test(count) || Number(count) > 512)
      throw new TypeError("Invalid approval payload byte length.");
    offset = colon + 1;
    const field = bytes.subarray(offset, offset + Number(count));
    offset += Number(count);
    if (field.length !== Number(count) || bytes[offset] !== 10)
      throw new TypeError("Invalid approval payload field boundary.");
    const text = field.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(field))
      throw new TypeError("Invalid approval payload UTF8.");
    values[name] = text;
    offset++;
  }
  if (offset !== bytes.length) throw new TypeError("Trailing approval payload bytes.");
  const payload = values as Record<(typeof FIELDS)[number], string>;
  if (!encodeOperatorApprovalPayload({ protocolVersion: 1, ...payload }).equals(bytes))
    throw new TypeError("Noncanonical approval payload.");
  return payload;
}
/** The canonical statement is the only semantic authority, not any sibling summary. */
export function assertApprovalChallenge(value: unknown): asserts value is DaemonApprovalChallenge {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Approval challenge must be an object.");
  const r = value as Record<string, unknown>;
  const allowed = [
    "requestId",
    "toolName",
    "permission",
    "packageName",
    "requestDigest",
    "expiresAtUtc",
    "canonicalPayload",
    "approvalStatementVersion",
    "approvalStatementCanonical",
  ];
  if (Object.keys(r).length !== allowed.length || !allowed.every((k) => Object.hasOwn(r, k)))
    throw new TypeError("Unexpected approval challenge fields.");
  if (
    r.approvalStatementVersion !== 1 ||
    typeof r.canonicalPayload !== "string" ||
    typeof r.approvalStatementCanonical !== "string"
  )
    throw new TypeError("Unsupported or absent approval statement.");
  const statement = parseApprovalStatementCanonical(r.approvalStatementCanonical);
  if (
    typeof r.requestId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(r.requestId)
  )
    throw new TypeError("Invalid approval request identifier.");
  if (approvalStatementDigest(r.approvalStatementCanonical) !== r.requestDigest)
    throw new TypeError("Approval statement digest mismatch.");
  const payload = decodeApprovalPayload(r.canonicalPayload);
  for (const name of FIELDS)
    if (name !== "nonce" && payload[name] !== r[name])
      throw new TypeError("Approval payload/visible metadata mismatch.");
  if (
    statement.toolName !== r.toolName ||
    statement.permission !== r.permission ||
    statement.packageName !== r.packageName
  )
    throw new TypeError("Approval statement/visible metadata mismatch.");
}
