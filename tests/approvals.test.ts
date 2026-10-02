/**
 * Phase 2.3 — approval gate tests. Fake tools, fake prompt, injected clock and
 * randomness, isolated temp audit logs. Never touches stdin, Google, or real time.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries, sanitizeAuditMetadata, REDACTED } from "../src/audit/index.js";
import {
  APPROVAL_TOKEN_TTL_MS,
  ApprovalGateError,
  approveInteractively,
  createApprovalChallenge,
  createApprovalRequest,
  createFileApprovalLedger,
  resolveApprovalToken,
  type ApprovalGateDeps,
  type ApprovalPrompt,
  type ApprovalRequest,
} from "../src/runtime/approvals/index.js";
import { parseApproveArgument } from "../src/cli/approve-args.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import {
  ToolRegistry,
  type RegisteredTool,
  type ToolPermissionLevel,
  type ToolSchema,
} from "../src/runtime/tools/index.js";

let dir: string;
let logPath: string;
let nowMs: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playops-approval-test-"));
  logPath = join(dir, "audit.jsonl");
  nowMs = Date.parse("2026-09-26T00:00:00.000Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const schema: ToolSchema<string> = { parse: (v) => String(v) };

function deps(overrides: Partial<ApprovalGateDeps> = {}): ApprovalGateDeps {
  return {
    ledger: createFileApprovalLedger(logPath),
    now: () => new Date(nowMs),
    ...overrides,
  };
}

function baseRequest(permission: ToolPermissionLevel = "destructive") {
  return {
    toolName: `test.${permission}`,
    permission,
    requestDigest: "sha256:abc123",
    safeSummary: `Fake ${permission} action on fixture item 42`,
  };
}

function makeRequest(permission: ToolPermissionLevel = "destructive", d = deps()): ApprovalRequest {
  return createApprovalRequest(baseRequest(permission), d);
}

function fakeTool(permission: ToolPermissionLevel) {
  const execute = vi.fn(() => Promise.resolve("executed"));
  const verify = vi.fn(() => Promise.resolve(true));
  const registry = new ToolRegistry();
  registry.register({
    name: `test.${permission}`,
    description: "fake",
    permission,
    inputSchema: schema,
    outputSchema: schema,
    execute,
    verify,
  });
  return { tool: registry.get(`test.${permission}`) as RegisteredTool, execute, verify, registry };
}

function scriptedPrompt(answer: string): ApprovalPrompt & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    ask: (text) => {
      shown.push(text);
      return Promise.resolve(answer);
    },
  };
}

function expectGateError(fn: () => unknown, code: ApprovalGateError["code"]): ApprovalGateError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalGateError);
    expect((error as ApprovalGateError).code).toBe(code);
    return error as ApprovalGateError;
  }
  throw new Error(`expected ${code}`);
}

function rawLog(): string {
  return readFileSync(logPath, "utf8");
}

describe("createApprovalRequest", () => {
  it.each(["destructive", "publish"] as const)("accepts a %s request", (permission) => {
    const request = makeRequest(permission);
    expect(request.toolName).toBe(`test.${permission}`);
    expect(request.permission).toBe(permission);
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.createdAt).toBe("2026-09-26T00:00:00.000Z");
    expect(Date.parse(request.expiresAt) - Date.parse(request.createdAt)).toBe(
      APPROVAL_TOKEN_TTL_MS,
    );
    expect(Object.isFrozen(request)).toBe(true);
  });

  it.each(["read", "write"] as const)("refuses a %s request (not challengeable)", (permission) => {
    expectGateError(() => makeRequest(permission), "INVALID_REQUEST");
  });

  it.each([
    ["toolName", ""],
    ["toolName", "   "],
    ["requestDigest", ""],
    ["requestDigest", " "],
    ["safeSummary", ""],
    ["safeSummary", "\t"],
  ])("rejects blank %s", (field, value) => {
    expectGateError(
      () => createApprovalRequest({ ...baseRequest(), [field]: value }, deps()),
      "INVALID_REQUEST",
    );
  });

  it("appends an approval.requested pending event with safe metadata only", () => {
    const request = makeRequest();
    const entries = readAuditEntries(logPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "approval.requested",
      action: "test.destructive",
      status: "pending",
      metadata: {
        requestId: request.requestId,
        toolName: "test.destructive",
        permission: "destructive",
        requestDigest: "sha256:abc123",
      },
    });
  });

  it("exposes a conservative default TTL of 10 minutes", () => {
    expect(APPROVAL_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe("token challenge", () => {
  it("creates an opaque high-entropy base64url token and audits only its digest", () => {
    const request = makeRequest();
    const challenge = createApprovalChallenge(request, deps());
    expect(challenge.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, unpadded
    expect(challenge.proofDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rawLog()).not.toContain(challenge.rawToken);
    expect(rawLog()).toContain(challenge.proofDigest);
    const challenged = readAuditEntries(logPath).find((e) => e.type === "approval.challenged");
    expect(challenged?.metadata).toMatchObject({
      requestId: request.requestId,
      proofDigest: challenge.proofDigest,
      expiresAt: request.expiresAt,
    });
  });

  it("uses injected randomness deterministically", () => {
    const random = () => Buffer.alloc(32, 7);
    const a = createApprovalChallenge(makeRequest(), deps({ randomBytes: random }));
    const b = createApprovalChallenge(makeRequest(), deps({ randomBytes: random }));
    expect(a.rawToken).toBe(b.rawToken);
    expect(a.proofDigest).toBe(b.proofDigest);
  });

  it("two challenges yield different tokens", () => {
    const a = createApprovalChallenge(makeRequest(), deps());
    const b = createApprovalChallenge(makeRequest(), deps());
    expect(a.rawToken).not.toBe(b.rawToken);
  });

  it("the same raw token validates against its stored digest", () => {
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    const grant = resolveApprovalToken(request, rawToken, deps());
    expect(grant.source).toBe("token");
    expect(grant.requestId).toBe(request.requestId);
    expect(grant.requestDigest).toBe(request.requestDigest);
    expect(grant.record).toEqual({
      toolName: "test.destructive",
      permission: "destructive",
      decision: "approved",
    });
    expect(JSON.stringify(grant)).not.toContain(rawToken);
  });

  it("rejects an unknown token without echoing it", () => {
    const request = makeRequest();
    createApprovalChallenge(request, deps());
    const bogus = "A".repeat(43);
    const error = expectGateError(
      () => resolveApprovalToken(request, bogus, deps()),
      "TOKEN_INVALID",
    );
    expect(error.message).not.toContain(bogus);
  });

  it.each(["", "   "])("rejects blank token %j", (blank) => {
    const request = makeRequest();
    expectGateError(() => resolveApprovalToken(request, blank, deps()), "TOKEN_INVALID");
  });

  it("rejects an expired token exactly at the TTL boundary and records approval.expired", () => {
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    nowMs += APPROVAL_TOKEN_TTL_MS - 1;
    expect(resolveApprovalToken(request, rawToken, deps()).record.decision).toBe("approved");

    const second = makeRequest();
    const c2 = createApprovalChallenge(second, deps());
    nowMs += APPROVAL_TOKEN_TTL_MS;
    expectGateError(() => resolveApprovalToken(second, c2.rawToken, deps()), "TOKEN_EXPIRED");
    const expired = readAuditEntries(logPath).filter((e) => e.type === "approval.expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.metadata?.requestId).toBe(second.requestId);
  });

  it("rejects a token bound to a different requestId", () => {
    const a = makeRequest();
    const b = makeRequest();
    const { rawToken } = createApprovalChallenge(a, deps());
    expectGateError(() => resolveApprovalToken(b, rawToken, deps()), "TOKEN_REQUEST_MISMATCH");
  });

  it.each([
    ["toolName", "test.publish"],
    ["permission", "publish"],
    ["requestDigest", "sha256:different"],
  ])("rejects when the presented request differs in %s", (field, value) => {
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    const tampered = { ...request, [field]: value } as ApprovalRequest;
    expectGateError(
      () => resolveApprovalToken(tampered, rawToken, deps()),
      "TOKEN_REQUEST_MISMATCH",
    );
  });

  it("refuses to reuse a consumed token", () => {
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    resolveApprovalToken(request, rawToken, deps());
    expectGateError(() => resolveApprovalToken(request, rawToken, deps()), "TOKEN_ALREADY_USED");
    const consumed = readAuditEntries(logPath).filter((e) => e.type === "approval.consumed");
    expect(consumed).toHaveLength(1);
  });
});

describe("interactive approval", () => {
  it.each(["yes", "y", "YES", " Y "])("approves on %j", async (answer) => {
    const request = makeRequest();
    const grant = await approveInteractively(request, scriptedPrompt(answer), deps());
    expect(grant.source).toBe("interactive");
    expect(grant.record.decision).toBe("approved");
    expect(readAuditEntries(logPath).some((e) => e.type === "approval.approved")).toBe(true);
  });

  it.each(["no", "", "n", "yes please", "ok", "true", "1"])("denies on %j", async (answer) => {
    const request = makeRequest();
    const grant = await approveInteractively(request, scriptedPrompt(answer), deps());
    expect(grant.record.decision).toBe("denied");
    const denied = readAuditEntries(logPath).filter((e) => e.type === "approval.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.status).toBe("denied");
  });

  it("prompt shows only tool, permission, and safeSummary — not internals", async () => {
    const request = createApprovalRequest(
      { ...baseRequest("publish"), safeSummary: "Publish fixture release 1.2.3 to fixture track" },
      deps(),
    );
    const prompt = scriptedPrompt("no");
    await approveInteractively(request, prompt, deps());
    expect(prompt.shown).toHaveLength(1);
    const text = prompt.shown[0] ?? "";
    expect(text).toContain("test.publish");
    expect(text).toContain("publish");
    expect(text).toContain("Publish fixture release 1.2.3 to fixture track");
    expect(text).not.toContain(request.requestId);
    expect(text).not.toContain(request.requestDigest);
    expect(text).not.toContain("expiresAt");
  });
});

describe("--approve argument parsing", () => {
  it("parses --approve TOKEN and preserves other args in order", () => {
    const parsed = parseApproveArgument(["doctor", "--approve", "tok_abc", "--verbose"]);
    expect(parsed.token).toBe("tok_abc");
    expect(parsed.rest).toEqual(["doctor", "--verbose"]);
  });

  it("supports --approve=TOKEN form", () => {
    expect(parseApproveArgument(["--approve=tok_x"]).token).toBe("tok_x");
  });

  it("returns undefined token when absent and leaves args untouched", () => {
    const args = ["doctor"];
    const parsed = parseApproveArgument(args);
    expect(parsed.token).toBeUndefined();
    expect(parsed.rest).toEqual(["doctor"]);
    expect(args).toEqual(["doctor"]);
  });

  it("rejects --approve without a value", () => {
    expectGateError(() => parseApproveArgument(["--approve"]), "CLI_ARGUMENT_INVALID");
    expectGateError(() => parseApproveArgument(["--approve", "--other"]), "CLI_ARGUMENT_INVALID");
  });

  it.each([["--approve", ""], ["--approve", "   "], ["--approve="]])(
    "rejects blank token %j",
    (...args) => {
      expectGateError(() => parseApproveArgument(args), "CLI_ARGUMENT_INVALID");
    },
  );

  it("rejects duplicate --approve", () => {
    expectGateError(
      () => parseApproveArgument(["--approve", "a", "--approve", "b"]),
      "CLI_ARGUMENT_INVALID",
    );
  });

  it("never echoes the token in the duplicate error", () => {
    const error = expectGateError(
      () => parseApproveArgument(["--approve", "secretlike1", "--approve", "secretlike2"]),
      "CLI_ARGUMENT_INVALID",
    );
    expect(error.message).not.toContain("secretlike");
  });
});

describe("integration with Phase 2.2 permission engine", () => {
  it("destructive → APPROVAL_REQUIRED → interactive yes → ALLOWED", async () => {
    const { tool } = fakeTool("destructive");
    expect(evaluateToolPermission(tool).code).toBe("APPROVAL_REQUIRED");
    const grant = await approveInteractively(makeRequest(), scriptedPrompt("yes"), deps());
    expect(evaluateToolPermission(tool, grant.record).code).toBe("ALLOWED");
  });

  it("publish → APPROVAL_REQUIRED → valid token → ALLOWED", () => {
    const { tool } = fakeTool("publish");
    const request = makeRequest("publish");
    const { rawToken } = createApprovalChallenge(request, deps());
    const grant = resolveApprovalToken(request, rawToken, deps());
    expect(evaluateToolPermission(tool, grant.record).code).toBe("ALLOWED");
  });

  it("interactive denial → APPROVAL_DENIED", async () => {
    const { tool } = fakeTool("destructive");
    const grant = await approveInteractively(makeRequest(), scriptedPrompt("no"), deps());
    expect(evaluateToolPermission(tool, grant.record).code).toBe("APPROVAL_DENIED");
  });

  it("grant for another tool cannot make the engine ALLOW", async () => {
    const { tool } = fakeTool("publish");
    const grant = await approveInteractively(
      makeRequest("destructive"),
      scriptedPrompt("yes"),
      deps(),
    );
    expect(evaluateToolPermission(tool, grant.record).allowed).toBe(false);
  });

  it("never invokes execute/verify and never mutates the registry", async () => {
    const { tool, execute, verify, registry } = fakeTool("destructive");
    const before = registry.list().map((t) => t.name);
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    resolveApprovalToken(request, rawToken, deps());
    await approveInteractively(makeRequest(), scriptedPrompt("yes"), deps());
    evaluateToolPermission(tool);
    expect(execute).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(registry.list().map((t) => t.name)).toEqual(before);
  });
});

describe("audit ledger safety", () => {
  it("records the full lifecycle: requested, challenged, approved, consumed", () => {
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    resolveApprovalToken(request, rawToken, deps());
    const types = readAuditEntries(logPath).map((e) => e.type);
    expect(types).toEqual([
      "approval.requested",
      "approval.challenged",
      "approval.approved",
      "approval.consumed",
    ]);
    for (const entry of readAuditEntries(logPath)) {
      expect(entry.actor).toBe("operator");
      expect(entry.action).toBe("test.destructive");
    }
  });

  it("raw token appears 0 times in the resulting JSONL", () => {
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    resolveApprovalToken(request, rawToken, deps());
    expectGateError(() => resolveApprovalToken(request, rawToken, deps()), "TOKEN_ALREADY_USED");
    expect(rawLog().split(rawToken).length - 1).toBe(0);
    expect(rawLog()).not.toContain(REDACTED); // nothing sensitive was even attempted
  });

  it("safe request metadata survives the Phase 0 sanitizer unchanged", () => {
    const safe = {
      requestId: "r",
      toolName: "t",
      permission: "publish",
      requestDigest: "d",
      proofDigest: "p",
      expiresAt: "x",
      source: "token",
    };
    expect(sanitizeAuditMetadata(safe)).toEqual(safe);
  });

  it("existing sanitizer still redacts token-suffixed keys (guard against weakening)", () => {
    // Phase 0 rule: key equals or ends with a sensitive fragment. `proofDigest`
    // is deliberately outside that rule so it survives for ledger lookup.
    expect(
      sanitizeAuditMetadata({
        approvalToken: "x",
        rawToken: "r",
        token: "t",
        proofDigest: "p",
        nested: { access_token: "z" },
      }),
    ).toEqual({
      approvalToken: REDACTED,
      rawToken: REDACTED,
      token: REDACTED,
      proofDigest: "p",
      nested: { access_token: REDACTED },
    });
  });

  it("propagates unrelated malformed lines as the audit module's AuditError", () => {
    const request = makeRequest();
    const { rawToken } = createApprovalChallenge(request, deps());
    appendFileSync(logPath, "not json\n");
    expectGateError(() => resolveApprovalToken(request, rawToken, deps()), "AUDIT_FAILURE");
  });

  it("is deterministic given the same clock, randomness, and prompt", async () => {
    const random = () => Buffer.alloc(32, 1);
    const d = deps({
      randomBytes: random,
      requestId: () => "00000000-0000-4000-8000-000000000000",
    });
    const r1 = makeRequest("publish", d);
    const c1 = createApprovalChallenge(r1, d);
    const g1 = await approveInteractively(r1, scriptedPrompt("y"), d);
    expect(r1.requestId).toBe("00000000-0000-4000-8000-000000000000");
    expect(c1.proofDigest).toBe(
      createApprovalChallenge(r1, deps({ randomBytes: random })).proofDigest,
    );
    expect(g1.record.decision).toBe("approved");
  });
});
