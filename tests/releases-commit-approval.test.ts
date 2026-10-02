import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import {
  createFileAgentLedger,
  runAgent,
  type AgentApprovalResolver,
  type AgentRunResult,
  type AgentToolBinding,
} from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import {
  approveInteractively,
  APPROVAL_TOKEN_TTL_MS,
  createApprovalChallenge,
  resolveApprovalToken,
  type ApprovalGrant,
} from "../src/runtime/approvals/index.js";
import { ToolRegistry, type ToolDefinition, type ToolSchema } from "../src/runtime/tools/index.js";
import {
  createReleaseCommitApprovalBinding,
  createReleaseCommitIntent,
  createReleaseCommitRequestDigest,
  createReleaseCommitStateDigest,
  RELEASE_COMMIT_REVIEW_BEHAVIOR,
  RELEASES_COMMIT_EDIT_TOOL_NAME,
  type ReleaseCommitIntent,
  type ReleaseCommitIntentInput,
} from "../src/releases/commit-approval.js";
import type { ReleaseState, ReleaseTrackState } from "../src/releases/index.js";

const packageName = "com.example.release";
const editId = "edit-phase49";
const targetTrack = "production";
const versionCode = "101";
const sessionPathMarker = "/private/session/path.json";
const credentialMarker = "PRIVATE-CREDENTIAL-MARKER";
const noteTextMarker = "PRIVATE-NOTE-TEXT-MARKER";
const nowDate = new Date("2026-09-29T04:00:00.000Z");
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "Candidate 101",
    status: "inProgress",
    versionCodes: ["100", "101"],
    userFraction: 0.05,
    releaseNotes: [
      { language: "id", text: "Meningkatkan keandalan proses masuk." },
      { language: "en-us", text: noteTextMarker },
    ],
    countryTargeting: { countries: ["ID", "US"], includeRestOfWorld: false },
    inAppUpdatePriority: 5,
    ...overrides,
  };
}

function baseTrack(overrides: Partial<ReleaseTrackState> = {}): ReleaseTrackState {
  const unrelated: ReleaseState = {
    name: "Older release",
    status: "completed",
    versionCodes: ["99"],
    releaseNotes: [{ language: "de-AT", text: "Older note" }],
    countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
    inAppUpdatePriority: 2,
  };
  return {
    track: targetTrack,
    releases: [unrelated, targetRelease()],
    ...overrides,
  };
}

function intentInput(overrides: Partial<ReleaseCommitIntentInput> = {}): ReleaseCommitIntentInput {
  return {
    packageName,
    editId,
    targetTrack,
    versionCode,
    targetTrackState: baseTrack(),
    validatedEdit: { valid: true, expiryTimeSeconds: "1900000000" },
    ...overrides,
  };
}

function makeIntent(overrides: Partial<ReleaseCommitIntentInput> = {}): ReleaseCommitIntent {
  return createReleaseCommitIntent(intentInput(overrides));
}

function alternateRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "Candidate 101",
    status: "inProgress",
    versionCodes: ["101", "100"],
    userFraction: 0.05,
    releaseNotes: [
      { language: "en-US", text: noteTextMarker },
      { language: "id", text: "Meningkatkan keandalan proses masuk." },
    ],
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 5,
    ...overrides,
  };
}

function emptyInputSchema(): ToolSchema<Record<string, never>> {
  return {
    parse(value: unknown): Record<string, never> {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        Object.keys(value).length
      ) {
        throw new Error("sentinel input invalid");
      }
      return {};
    },
  };
}

const sentinelOutputSchema: ToolSchema<{ readonly executed: true }> = {
  parse(value: unknown): { readonly executed: true } {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      (value as { executed?: unknown }).executed !== true
    ) {
      throw new Error("sentinel output invalid");
    }
    return Object.freeze({ executed: true });
  },
};

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase49-approval",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "commit-call", name: RELEASES_COMMIT_EDIT_TOOL_NAME, arguments: {} }],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "sentinel complete", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

function makeSentinel(
  intent: ReleaseCommitIntent,
  execution: { calls: number },
): {
  readonly tool: ToolDefinition<Record<string, never>, { readonly executed: true }>;
  readonly binding: AgentToolBinding;
} {
  const approval = createReleaseCommitApprovalBinding(intent);
  const tool: ToolDefinition<Record<string, never>, { readonly executed: true }> = {
    name: RELEASES_COMMIT_EDIT_TOOL_NAME,
    description: "Test-only future commit sentinel; no Google operation exists in Phase 4.9.",
    permission: "publish",
    inputSchema: emptyInputSchema(),
    outputSchema: sentinelOutputSchema,
    async execute() {
      execution.calls += 1;
      return Object.freeze({ executed: true as const });
    },
    async verify(_input, output) {
      return output.executed === true;
    },
  };
  const binding: AgentToolBinding = {
    toolName: RELEASES_COMMIT_EDIT_TOOL_NAME,
    llm: {
      name: RELEASES_COMMIT_EDIT_TOOL_NAME,
      description: tool.description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    approval,
    serializeResult(output, verification) {
      if (verification.code !== "VERIFIED") throw new Error("sentinel not verified");
      const result = sentinelOutputSchema.parse(output);
      return JSON.stringify(result);
    },
  };
  return { tool, binding };
}

type TestApprovalResolver = (
  request: Parameters<AgentApprovalResolver["resolve"]>[0],
  ledger: ReturnType<typeof createFileAgentLedger>,
  now: () => Date,
) => Promise<ApprovalGrant>;

async function runSentinel(
  options: {
    readonly intent?: ReleaseCommitIntent;
    readonly resolver?: TestApprovalResolver;
    readonly now?: () => Date;
  } = {},
): Promise<{
  readonly result: AgentRunResult;
  readonly calls: number;
  readonly auditPath: string;
}> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase49-approval-"));
  tempDirs.push(dir);
  const auditPath = join(dir, "audit.jsonl");
  const ledger = createFileAgentLedger(auditPath);
  const now = options.now ?? (() => new Date(nowDate));
  const execution = { calls: 0 };
  const intent = options.intent ?? makeIntent();
  const sentinel = makeSentinel(intent, execution);
  const registry = new ToolRegistry();
  registry.register(sentinel.tool);
  const resolver = options.resolver;
  const result = await runAgent({
    llm: scriptedLlm(),
    registry,
    bindings: [sentinel.binding],
    messages: [{ role: "user", content: "publish" }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger,
    approvalLedger: ledger,
    ...(resolver
      ? {
          approvalResolver: {
            resolve: (request: Parameters<AgentApprovalResolver["resolve"]>[0]) =>
              resolver(request, ledger, now),
          },
        }
      : {}),
    now,
    runId: () => "phase49-approval-run",
  });
  return { result, calls: execution.calls, auditPath };
}

describe("Phase 4.9 commit intent normalization", () => {
  it.each([
    ["completed", { name: "Candidate 101", status: "completed", versionCodes: ["101"] }],
    [
      "draft",
      { name: "Candidate 101", status: "draft", versionCodes: ["101"], userFraction: undefined },
    ],
    [
      "staged",
      {
        name: "Candidate 101",
        status: "inProgress",
        versionCodes: ["100", "101"],
        userFraction: 0.05,
      },
    ],
  ])("accepts valid %s intent", (_label, release) => {
    const intent = makeIntent({
      targetTrackState: baseTrack({ releases: [release as ReleaseState] }),
    });
    expect(intent.releaseStatus).toBe(release.status);
    expect(intent.versionCode).toBe(versionCode);
    expect(intent.changesInReviewBehavior).toBe(RELEASE_COMMIT_REVIEW_BEHAVIOR);
    expect(intent.changesNotSentForReview).toBe(false);
  });

  it("preserves staged fraction, canonical note languages, and lossless version identity", () => {
    const intent = makeIntent();
    expect(intent.rolloutFraction).toBe(0.05);
    expect(intent.noteLanguages).toEqual(["en-US", "id"]);
    expect(intent.stateDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(intent.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("does not mutate input and freezes the normalized intent", () => {
    const input = intentInput();
    const before = JSON.stringify(input);
    const intent = createReleaseCommitIntent(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.noteLanguages)).toBe(true);
  });

  it.each([
    { label: "missing configured release", state: { track: targetTrack, releases: [] } },
    {
      label: "ambiguous configured release",
      state: {
        track: targetTrack,
        releases: [targetRelease(), targetRelease({ name: "Duplicate" })],
      },
    },
    {
      label: "missing release name",
      state: { track: targetTrack, releases: [{ status: "completed", versionCodes: ["101"] }] },
    },
  ])("rejects $label trusted state", ({ state }) => {
    expect(() => makeIntent({ targetTrackState: state as ReleaseTrackState })).toThrow();
  });

  it("requires successful Phase 4.8 validation evidence before preparing approval intent", () => {
    expect(() =>
      makeIntent({ validatedEdit: { valid: false, expiryTimeSeconds: "1900000000" } as never }),
    ).toThrow();
  });

  it("rejects an unsafe review behavior policy instead of using Google's risky default", () => {
    expect(() => makeIntent({ changesInReviewBehavior: "CANCEL_IN_REVIEW_AND_SUBMIT" })).toThrow();
  });
});

describe("Phase 4.9 state and request digests", () => {
  it("is stable across object-key insertion order, release order, version order, and note order", () => {
    const a = baseTrack();
    const b: ReleaseTrackState = {
      releases: [
        alternateRelease(),
        {
          inAppUpdatePriority: 2,
          countryTargeting: { includeRestOfWorld: true, countries: ["DE"] },
          releaseNotes: [{ text: "Older note", language: "de-AT" }],
          versionCodes: ["99"],
          status: "completed",
          name: "Older release",
        },
      ],
      track: targetTrack,
    };
    expect(createReleaseCommitStateDigest(a)).toBe(createReleaseCommitStateDigest(b));
    expect(makeIntent({ targetTrackState: a }).requestDigest).toBe(
      makeIntent({ targetTrackState: b }).requestDigest,
    );
  });

  it.each([
    [
      "note text",
      {
        releases: [
          targetRelease({
            releaseNotes: [
              { language: "en-US", text: "changed" },
              { language: "id", text: "Meningkatkan keandalan proses masuk." },
            ],
          }),
        ],
      },
    ],
    ["status", { releases: [targetRelease({ status: "completed", userFraction: undefined })] }],
    ["fraction", { releases: [targetRelease({ userFraction: 0.1 })] }],
    ["release name", { releases: [targetRelease({ name: "Changed" })] }],
    ["version code set", { releases: [targetRelease({ versionCodes: ["102"] })] }],
    [
      "unrelated release",
      {
        releases: [
          { name: "Older release", status: "completed", versionCodes: ["98"] },
          targetRelease(),
        ],
      },
    ],
  ])("changes state digest when $0 changes", (_label, state) => {
    expect(createReleaseCommitStateDigest(baseTrack())).not.toBe(
      createReleaseCommitStateDigest({ track: targetTrack, ...state } as ReleaseTrackState),
    );
  });

  it.each([
    ["packageName", { packageName: "com.example.other" }],
    ["editId", { editId: "edit-other" }],
    ["targetTrack", { targetTrack: "beta" }],
    ["versionCode", { versionCode: "102" }],
    [
      "status",
      {
        targetTrackState: {
          track: targetTrack,
          releases: [targetRelease({ status: "completed", userFraction: undefined })],
        },
      },
    ],
    [
      "fraction",
      {
        targetTrackState: { track: targetTrack, releases: [targetRelease({ userFraction: 0.1 })] },
      },
    ],
    [
      "state digest",
      { targetTrackState: { track: targetTrack, releases: [targetRelease({ name: "Changed" })] } },
    ],
    ["changesNotSentForReview", { changesNotSentForReview: true }],
  ])("changes request digest when $0 changes", (label, change) => {
    const a = makeIntent();
    const b =
      label === "packageName" ||
      label === "editId" ||
      label === "targetTrack" ||
      label === "versionCode"
        ? ({ ...a, ...change } as ReleaseCommitIntent)
        : makeIntent(change as Partial<ReleaseCommitIntentInput>);
    expect(createReleaseCommitRequestDigest(a)).not.toBe(createReleaseCommitRequestDigest(b));
  });

  it("changes request identity when the trusted validation evidence changes", () => {
    const intent = makeIntent();
    expect(
      createReleaseCommitRequestDigest({ ...intent, validationExpiryTimeSeconds: "1900000100" }),
    ).not.toBe(intent.requestDigest);
  });

  it("changes request digest when review behavior field changes in a bound intent", () => {
    const intent = makeIntent();
    const alternate = {
      ...intent,
      changesInReviewBehavior: "CANCEL_IN_REVIEW_AND_SUBMIT" as const,
    };
    expect(createReleaseCommitRequestDigest(intent)).not.toBe(
      createReleaseCommitRequestDigest(alternate),
    );
  });
});

describe("Phase 4.9 safe human summary and binding", () => {
  it("uses the digest as authority rather than model input or summary formatting", () => {
    const binding = createReleaseCommitApprovalBinding(makeIntent());
    expect(binding.createRequestDigest({ punctuation: "A" })).toBe(
      binding.createRequestDigest({ punctuation: "B" }),
    );
  });

  it("describes the publish effect and safe review policy without secrets or note text", () => {
    const intent = makeIntent();
    const binding = createReleaseCommitApprovalBinding(intent);
    const digest = binding.createRequestDigest({});
    const summary = binding.createSafeSummary({});
    expect(binding.permission).toBe("publish");
    expect(digest).toBe(intent.requestDigest);
    expect(summary).toContain("PUBLISH");
    expect(summary).toContain(packageName);
    expect(summary).toContain(targetTrack);
    expect(summary).toContain(versionCode);
    expect(summary).toContain("Candidate 101");
    expect(summary).toContain("inProgress");
    expect(summary).toContain("0.05");
    expect(summary).toContain("en-US, id");
    expect(summary).toContain("ERROR_IF_IN_REVIEW");
    expect(summary).toContain("fail rather than cancel");
    expect(summary).not.toContain(noteTextMarker);
    expect(summary).not.toContain(credentialMarker);
    expect(summary).not.toContain(sessionPathMarker);
    expect(summary).not.toContain(editId);
  });
});

describe("Phase 4.9 real runtime approval contract with sentinel", () => {
  it("publish without approval never reaches sentinel execution", async () => {
    const { result, calls } = await runSentinel();
    expect(result).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(calls).toBe(0);
  });

  it("denial never reaches sentinel execution and leaves no usable approval", async () => {
    const { result, calls, auditPath } = await runSentinel({
      resolver: async (request, ledger, now) =>
        approveInteractively(request, { ask: async () => "no" }, { ledger, now }),
    });
    expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(calls).toBe(0);
    const audit = readAuditEntries(auditPath);
    expect(audit.some((entry) => entry.type === "approval.denied")).toBe(true);
    expect(audit.some((entry) => entry.type === "approval.approved")).toBe(false);
  });

  it("exact interactive approval reaches only the sentinel once", async () => {
    const { result, calls } = await runSentinel({
      resolver: async (request, ledger, now) =>
        approveInteractively(request, { ask: async () => "yes" }, { ledger, now }),
    });
    expect(result).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(calls).toBe(1);
  });

  it("expired token approval never reaches sentinel execution", async () => {
    let nowMs = nowDate.getTime();
    const now = () => new Date(nowMs);
    const { result, calls } = await runSentinel({
      now,
      resolver: async (request, ledger) => {
        const challenge = createApprovalChallenge(request, { ledger, now });
        nowMs += APPROVAL_TOKEN_TTL_MS;
        return resolveApprovalToken(request, challenge.rawToken, { ledger, now });
      },
    });
    expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(calls).toBe(0);
  });

  it("mismatched approval digest never reaches sentinel execution", async () => {
    const { result, calls } = await runSentinel({
      resolver: async (request) => ({
        record: { toolName: request.toolName, permission: "publish", decision: "approved" },
        requestId: request.requestId,
        requestDigest: "wrong-digest",
        source: "token",
      }),
    });
    expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(calls).toBe(0);
  });

  it("wrong-tool approval never reaches sentinel execution", async () => {
    const { result, calls } = await runSentinel({
      resolver: async (request) => ({
        record: { toolName: "reviews.publish_reply", permission: "publish", decision: "approved" },
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        source: "token",
      }),
    });
    expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(calls).toBe(0);
  });

  it("old grant cannot authorize a changed edit/state intent", async () => {
    const oldIntent = makeIntent();
    const oldBinding = createReleaseCommitApprovalBinding(oldIntent);
    const oldDigest = oldBinding.createRequestDigest({});
    const { result, calls } = await runSentinel({
      intent: makeIntent({ editId: "edit-new" }),
      resolver: async (request) => ({
        record: { toolName: request.toolName, permission: "publish", decision: "approved" },
        requestId: "old-request-id",
        requestDigest: oldDigest,
        source: "token",
      }),
    });
    expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(calls).toBe(0);
  });

  it("audit excludes token, credential, session path, and full note text", async () => {
    const { result, auditPath } = await runSentinel({
      resolver: async (request, ledger, now) =>
        approveInteractively(request, { ask: async () => "yes" }, { ledger, now }),
    });
    expect(result.ok).toBe(true);
    const text = JSON.stringify(readAuditEntries(auditPath));
    expect(text).not.toContain(credentialMarker);
    expect(text).not.toContain(sessionPathMarker);
    expect(text).not.toContain(noteTextMarker);
  });
});
