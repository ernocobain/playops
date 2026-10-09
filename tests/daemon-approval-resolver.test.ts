/**
 * Signature-backed approval resolver.
 *
 * These tests drive the REAL safety path: a real pending record from the Stage-2
 * store, the real `executeOneTool`/`runAgent` approval gate, and a real
 * Ed25519 verification. Only Google/tool execution is fake. Offline throughout.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import {
  createOperatorSignatureApprovalResolver,
  matchSignatureApproval,
} from "../src/daemon/approval-resolver.js";
import {
  createFilePendingOperationStore,
  type PendingOperationRecord,
} from "../src/daemon/pending-store.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { executeOneTool } from "../src/runtime/agent/execute-one-tool.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import {
  OPERATOR_APPROVAL_PROTOCOL_VERSION,
  createOperatorApprovalVerifier,
  encodeOperatorApprovalPayload,
  type OperatorApprovalPayload,
} from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry, type ToolDefinition } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-resolver-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const TOOL = "releases.commit_edit";
const SIGNED_DIGEST = "a".repeat(64);
const OTHER_DIGEST = "c".repeat(64);

function keyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

function signPayload(payload: OperatorApprovalPayload, privateKey: KeyObject): string {
  return sign(null, encodeOperatorApprovalPayload(payload), privateKey).toString("base64url");
}

async function preparePending(dir: string) {
  const store = createFilePendingOperationStore(dir);
  return store.prepare({
    operation: "commit",
    toolName: TOOL,
    permission: "publish",
    packageName: "com.example.app",
    requestDigest: SIGNED_DIGEST,
    intent: {
      kind: "commit",
      targetTrack: "internal",
      versionCode: "3",
      editId: "edit-1",
      stateDigest: "b".repeat(64),
      validationExpiryTimeSeconds: "1900000000",
      releaseName: "3 (1.1)",
      releaseStatus: "completed",
    },
  });
}

function payloadFrom(pending: PendingOperationRecord): OperatorApprovalPayload {
  return {
    protocolVersion: OPERATOR_APPROVAL_PROTOCOL_VERSION,
    requestId: pending.requestId,
    nonce: pending.nonce,
    toolName: pending.toolName,
    permission: pending.permission,
    packageName: pending.packageName,
    requestDigest: pending.requestDigest,
    expiresAtUtc: pending.expiresAtUtc,
  };
}

interface Harness {
  readonly executed: Mock;
  readonly auditPath: string;
  readonly approvalPath: string;
  run(options?: {
    readonly withResolver?: boolean;
    readonly runtimeDigest?: string;
    readonly payload?: OperatorApprovalPayload;
    readonly signature?: string;
    readonly publicKey?: KeyObject;
  }): Promise<Awaited<ReturnType<typeof executeOneTool>>>;
}

function harness(dir: string, pending: Awaited<ReturnType<typeof preparePending>>): Harness {
  const auditPath = join(dir, "audit.jsonl");
  const approvalPath = join(dir, "approval.jsonl");
  const verificationPath = join(dir, "verification.jsonl");
  const executed = vi.fn(async () => ({ done: true }));

  const tool: ToolDefinition<Record<string, never>, unknown> = {
    name: TOOL,
    description: "Publish the prepared commit.",
    permission: "publish",
    inputSchema: {
      parse(): Record<string, never> {
        return Object.freeze({});
      },
    },
    outputSchema: {
      parse(value: unknown): unknown {
        return value;
      },
    },
    execute: executed,
    verify: async () => true,
  };

  return {
    executed,
    auditPath,
    approvalPath,
    async run(options = {}) {
      const runtimeDigest = options.runtimeDigest ?? SIGNED_DIGEST;
      const payload = options.payload ?? payloadFrom(pending);
      const signature = options.signature ?? "";
      const publicKey = options.publicKey;
      const binding = {
        toolName: TOOL,
        llm: {
          name: TOOL,
          description: "Publish the prepared commit.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        approval: {
          createRequestDigest: (): string => runtimeDigest,
          createSafeSummary: (): string => "PUBLISH Google Play edit (test).",
        },
        serializeResult: (): string => JSON.stringify({ ok: true }),
      };
      const registry = new ToolRegistry();
      registry.register(tool);
      return executeOneTool({
        registry,
        binding,
        input: {},
        ledger: createFileAgentLedger(auditPath),
        approvalLedger: createFileApprovalLedger(approvalPath),
        verificationLedger: createFileVerificationLedger(verificationPath),
        ...(options.withResolver === true && publicKey
          ? {
              approvalResolver: createOperatorSignatureApprovalResolver({
                verifier: createOperatorApprovalVerifier(publicKey, "test-anchor"),
                pending,
                payload,
                signature,
                ledger: createFileApprovalLedger(approvalPath),
              }),
            }
          : {}),
      });
    },
  };
}

describe("operator_signature approval resolver", () => {
  it("executes once for a genuine signature over an exactly matching request", async () => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const { publicKey, privateKey } = keyPair();
    const payload = payloadFrom(pending);
    const { executed, approvalPath, run } = harness(dir, pending);

    const execution = await run({
      withResolver: true,
      publicKey,
      payload,
      signature: signPayload(payload, privateKey),
    });

    expect(execution.result.ok).toBe(true);
    expect(executed).toHaveBeenCalledTimes(1);

    const entries = readAuditEntries(approvalPath);
    const approved = entries.filter((entry) => entry.type === "approval.approved");
    const consumed = entries.filter((entry) => entry.type === "approval.consumed");
    expect(approved.length).toBe(1);
    expect(consumed.length).toBe(1);
    expect(approved[0]?.metadata?.source).toBe("operator_signature");
    expect(consumed[0]?.metadata?.source).toBe("operator_signature");
    // Provenance must never be mislabelled as a TTY approval.
    expect(entries.some((entry) => entry.metadata?.source === "interactive")).toBe(false);
    expect(entries.some((entry) => entry.metadata?.source === "token")).toBe(false);
  });

  it("never executes without a resolver, leaving the approval gate closed", async () => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const { executed, run } = harness(dir, pending);

    const execution = await run();

    expect(execution.result.ok).toBe(false);
    expect(execution.result.code).toBe("APPROVAL_REQUIRED");
    expect(executed).not.toHaveBeenCalled();
  });

  it("denies and does not execute when the signature is invalid", async () => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const { publicKey } = keyPair();
    const other = keyPair();
    const payload = payloadFrom(pending);
    const { executed, approvalPath, run } = harness(dir, pending);

    const execution = await run({
      withResolver: true,
      publicKey,
      payload,
      signature: signPayload(payload, other.privateKey),
    });

    expect(execution.result.ok).toBe(false);
    expect(execution.result.code).toBe("APPROVAL_DENIED");
    expect(executed).not.toHaveBeenCalled();
    const denied = readAuditEntries(approvalPath).filter((e) => e.type === "approval.denied");
    expect(denied[0]?.metadata?.reason).toBe("SIGNATURE_INVALID");
  });

  it("denies when the runtime request names a different digest than the one signed", async () => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const { publicKey, privateKey } = keyPair();
    const payload = payloadFrom(pending);
    const { executed, run } = harness(dir, pending);

    const execution = await run({
      withResolver: true,
      publicKey,
      payload,
      signature: signPayload(payload, privateKey),
      runtimeDigest: OTHER_DIGEST,
    });

    expect(execution.result.code).toBe("APPROVAL_DENIED");
    expect(executed).not.toHaveBeenCalled();
  });

  it("denies when the signed payload does not project the pending record", async () => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const { publicKey, privateKey } = keyPair();
    const tampered: OperatorApprovalPayload = {
      ...payloadFrom(pending),
      packageName: "com.other.app",
    };
    const { executed, run } = harness(dir, pending);

    const execution = await run({
      withResolver: true,
      publicKey,
      payload: tampered,
      signature: signPayload(tampered, privateKey),
    });

    expect(execution.result.code).toBe("APPROVAL_DENIED");
    expect(executed).not.toHaveBeenCalled();
  });

  it("never records the signature bytes or private intent in the audit trail", async () => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const { publicKey, privateKey } = keyPair();
    const payload = payloadFrom(pending);
    const signature = signPayload(payload, privateKey);
    const { auditPath, approvalPath, run } = harness(dir, pending);

    await run({ withResolver: true, publicKey, payload, signature });

    // §32: neither the runtime ledger nor the approval ledger may carry secret or
    // private-intent material, and never the signature bytes themselves.
    const raw = JSON.stringify([...readAuditEntries(auditPath), ...readAuditEntries(approvalPath)]);
    expect(raw.includes(signature)).toBe(false);
    expect(raw.includes("private_key")).toBe(false);
    expect(raw.includes("access_token")).toBe(false);
    expect(raw.includes("Authorization")).toBe(false);
    expect(raw.includes("releaseNotes")).toBe(false);
    expect(raw.includes(pending.nonce)).toBe(false);
    expect(raw.includes("edit-1")).toBe(false);
  });
});

describe("matchSignatureApproval", () => {
  it("accepts an exact three-way match", async () => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const payload = payloadFrom(pending);
    const request = {
      requestId: pending.requestId,
      toolName: TOOL,
      permission: "publish" as const,
      requestDigest: SIGNED_DIGEST,
      safeSummary: "summary",
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    };
    expect(matchSignatureApproval(request, payload, pending)).toEqual({ ok: true });
  });

  it.each([
    ["REQUEST_TOOL_MISMATCH", { toolName: "releases.open_edit" }, undefined],
    ["REQUEST_DIGEST_MISMATCH", { requestDigest: OTHER_DIGEST }, undefined],
    ["PENDING_PACKAGE_MISMATCH", undefined, { packageName: "com.other.app" }],
    ["PENDING_NONCE_MISMATCH", undefined, { nonce: "n".repeat(43) }],
    [
      "PENDING_REQUEST_ID_MISMATCH",
      undefined,
      { requestId: "11111111-2222-4333-8444-555555555555" },
    ],
    ["PENDING_EXPIRY_MISMATCH", undefined, { expiresAtUtc: "2026-01-01T00:00:00.000Z" }],
  ])("reports %s", async (reason, requestPatch, payloadPatch) => {
    const dir = tempDir();
    const pending = await preparePending(dir);
    const payload = { ...payloadFrom(pending), ...(payloadPatch ?? {}) };
    const request = {
      requestId: pending.requestId,
      toolName: TOOL,
      permission: "publish" as const,
      requestDigest: SIGNED_DIGEST,
      safeSummary: "summary",
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      ...(requestPatch ?? {}),
    };
    const match = matchSignatureApproval(request, payload, pending);
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toBe(reason);
  });
});
