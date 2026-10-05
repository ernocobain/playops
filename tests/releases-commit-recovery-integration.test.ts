/** Offline restart/approval proofs using real file stores and the production Publisher adapter. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileAgentLedger, runAgent } from "../src/runtime/agent/index.js";
import { approveInteractively, type ApprovalRequest } from "../src/runtime/approvals/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { createAndroidPublisherReleaseGateway } from "../src/releases/androidpublisher.js";
import {
  createFileReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptVerificationPatch,
} from "../src/releases/commit-attempt-journal.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import {
  createReleaseCommitReconciliationTool,
  type ReleaseCommitReconciliationMode,
} from "../src/releases/reconcile-commit-tool.js";
import type { ReleaseTrackState } from "../src/releases/index.js";

const packageName = "com.example.recovery";
const now = new Date("2026-10-05T00:00:00.000Z");
const original = { packageName, editId: "original-recovery-edit", expiryTimeSeconds: "1" };
const temp = { packageName, editId: "temporary-recovery-edit", expiryTimeSeconds: "2000000000" };
const track: ReleaseTrackState = {
  track: "production",
  releases: [
    {
      name: "Candidate",
      versionCodes: ["101"],
      status: "completed",
      releaseNotes: [{ language: "en-US", text: "PRIVATE-NOTE" }],
    },
  ],
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function failedPrecondition() {
  return {
    message: "PRIVATE-ERROR",
    response: {
      status: 400,
      data: {
        error: {
          code: 400,
          status: "FAILED_PRECONDITION",
          message: "PRIVATE-ERROR",
          errors: [{ reason: "failedPrecondition", message: "PRIVATE-ERROR" }],
        },
      },
    },
  };
}
async function fixture(
  state: "PREPARED" | "TRANSPORT_ATTEMPTED" | "AMBIGUOUS" | "ACKNOWLEDGED" = "AMBIGUOUS",
) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "commit-recovery-runtime-"));
  dirs.push(dir);
  const path = join(dir, "attempts.json");
  const sessionPath = join(dir, "session.json");
  const journal = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
  const sessionStore = createFileReleaseEditSessionStore(sessionPath, {
    expectedPackageName: packageName,
  });
  await sessionStore.save({ version: 1, ...original, createdAt: now.toISOString() });
  let candidate = await journal.prepare({
    version: 1,
    ...original,
    targetTrack: track.track,
    versionCode: "101",
    releaseName: "Candidate",
    releaseStatus: "completed",
    expectedStateDigest: createReleaseCommitStateDigest(track),
    validationExpiryTimeSeconds: original.expiryTimeSeconds,
    requestDigest: "a".repeat(64),
    attemptedAtUtc: now.toISOString(),
    updatedAtUtc: now.toISOString(),
  });
  if (state !== "PREPARED") {
    candidate = await journal.transition(
      candidate.attemptId,
      "PREPARED",
      "TRANSPORT_ATTEMPTED",
      now.toISOString(),
    );
    if (state !== "TRANSPORT_ATTEMPTED")
      candidate = await journal.transition(
        candidate.attemptId,
        "TRANSPORT_ATTEMPTED",
        state,
        now.toISOString(),
      );
  }
  const ledger = createFileAgentLedger(join(dir, "audit.jsonl"));
  const events: string[] = [];
  let deleted = false;
  const poison = vi.fn(async () => {
    throw new Error("Forbidden mutation");
  });
  const client = {
    version: "v3",
    reviews: {},
    edits: {
      get: vi.fn(
        async (params: { packageName: string; editId: string }, requestOptions: unknown) => {
          expect(requestOptions).toEqual({ retry: false });
          expect(params.packageName).toBe(packageName);
          events.push(`get:${params.editId}`);
          if (params.editId === original.editId || deleted) throw failedPrecondition();
          expect(params.editId).toBe(temp.editId);
          return { data: { id: temp.editId, expiryTimeSeconds: temp.expiryTimeSeconds } };
        },
      ),
      insert: vi.fn(async (_params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        events.push("insert");
        expect((await journal.list())[0]?.verificationInsertAttempted).toBe(true);
        return { data: { id: temp.editId, expiryTimeSeconds: temp.expiryTimeSeconds } };
      }),
      delete: vi.fn(
        async (params: { packageName: string; editId: string }, requestOptions: unknown) => {
          expect(requestOptions).toEqual({ retry: false });
          expect(params).toEqual({ packageName, editId: temp.editId });
          expect((await journal.list())[0]).toMatchObject({
            verificationDeleteAttempted: true,
            verificationPreDeleteReadVerified: true,
          });
          events.push(`delete:${params.editId}`);
          deleted = true;
          return { data: {} };
        },
      ),
      commit: poison,
      validate: poison,
      bundles: { upload: poison },
      tracks: {
        update: poison,
        get: vi.fn(async (params: unknown, requestOptions: unknown) => {
          expect(params).toEqual({ packageName, editId: temp.editId, track: track.track });
          expect(requestOptions).toEqual({ retry: false });
          expect((await journal.list())[0]?.verificationEditId).toBe(temp.editId);
          events.push("track");
          return { data: track };
        }),
      },
    },
  };
  const gateway = createAndroidPublisherReleaseGateway(
    client as unknown as AndroidPublisherClient,
    packageName,
    {
      policy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => {
        throw new Error("No sleeps");
      },
    },
  );
  const reopen = () => ({
    journal: createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName }),
    sessionStore: createFileReleaseEditSessionStore(sessionPath, {
      expectedPackageName: packageName,
    }),
  });
  const pair = (
    bound: ReleaseCommitAttemptJournalRecord,
    mode: ReleaseCommitReconciliationMode = "verify_expired",
    persistence = reopen(),
  ) =>
    createReleaseCommitReconciliationTool({
      packageName,
      candidate: bound,
      mode,
      ...persistence,
      gateway,
      auditLedger: ledger,
      now: () => now,
    });
  const seed = async (patch: ReleaseCommitAttemptVerificationPatch) => {
    candidate = await journal.updateVerification(
      candidate.attemptId,
      candidate.state,
      now.toISOString(),
      patch,
    );
    return candidate;
  };
  return {
    dir,
    path,
    sessionPath,
    candidate,
    journal,
    sessionStore,
    ledger,
    client,
    gateway,
    events,
    poison,
    pair,
    reopen,
    seed,
    setDeleted: () => {
      deleted = true;
    },
  };
}
function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "offline-recovery",
    async complete() {
      if (turn++ === 0)
        return {
          toolCalls: [{ id: "reconcile", name: "releases.reconcile_commit", arguments: {} }],
          usage: { totalTokens: 1 },
        };
      return { content: "Finished", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function runPair(
  f: Awaited<ReturnType<typeof fixture>>,
  bound = f.candidate,
  mode: ReleaseCommitReconciliationMode = "verify_expired",
  answer?: "yes" | "no",
  mutateAfterApproval?: () => Promise<void>,
) {
  const pair = f.pair(bound, mode);
  const registry = new ToolRegistry();
  registry.register(pair.tool);
  const approved = vi.fn(async (request: ApprovalRequest) => {
    expect(request.permission).toBe("destructive");
    expect(request.requestDigest).toBe(pair.binding.approval?.createRequestDigest({}));
    const grant = approveInteractively(
      request,
      { ask: async () => answer ?? "no" },
      { ledger: f.ledger, now: () => now },
    );
    await mutateAfterApproval?.();
    return grant;
  });
  const result = await runAgent({
    llm: scriptedLlm(),
    registry,
    bindings: [pair.binding],
    messages: [{ role: "user", content: "Reconcile the bound attempt" }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: f.ledger,
    approvalLedger: f.ledger,
    ...(answer ? { approvalResolver: { resolve: approved } } : {}),
    now: () => now,
  });
  return { result, pair, approved };
}

describe("offline commit crash recovery", () => {
  it("finishes durable REMOTE_VERIFIED after a crash before local session close without reinsertion", async () => {
    const f = await fixture();
    const persistence = f.reopen();
    const brokenStore = {
      ...persistence.sessionStore,
      clear: async () => {
        throw new Error("Offline crash before local close");
      },
    };
    const first = await f
      .pair(f.candidate, "verify_expired", { ...persistence, sessionStore: brokenStore })
      .tool.execute({}, {});
    expect(first).toMatchObject({
      case: "CASE_3",
      liveReleaseVerified: false,
      externalStateUncertain: true,
    });
    const restarted = f.reopen();
    const [candidate] = await restarted.journal.list();
    if (!candidate) throw new Error("Missing durable fixture");
    expect(candidate).toMatchObject({
      state: "REMOTE_VERIFIED",
      verificationCleanupVerified: true,
      verificationObservedStateDigest: f.candidate.expectedStateDigest,
    });
    expect(await restarted.sessionStore.load()).toMatchObject(original);
    const repeatedCrash = await f
      .pair(candidate, "verify_expired", { ...restarted, sessionStore: brokenStore })
      .tool.execute({}, {});
    expect(repeatedCrash).toMatchObject({
      case: "CASE_3",
      pendingCleanup: false,
      liveReleaseVerified: false,
    });
    expect((await restarted.journal.list())[0]?.state).toBe("REMOTE_VERIFIED");
    f.events.splice(0);
    const pair = f.pair(candidate, "verify_expired", restarted);
    const result = await pair.tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_1",
      basis: "EXPECTED_STATE_OBSERVED",
      liveReleaseVerified: true,
      pendingCleanup: false,
      externalStateUncertain: false,
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
    expect(f.client.edits.insert).toHaveBeenCalledTimes(1);
    expect(f.client.edits.delete).toHaveBeenCalledTimes(1);
    expect(f.client.edits.tracks.get).toHaveBeenCalledTimes(1);
    expect(await restarted.sessionStore.load()).toBeUndefined();
    expect((await restarted.journal.list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(await pair.tool.verify?.({}, result, {})).toBe(true);
  });

  it("cleans an outstanding persisted temp first after restart without another insert or reconstructed track proof", async () => {
    const f = await fixture();
    await f.seed({ verificationInsertAttempted: true });
    await f.seed({
      verificationEditId: temp.editId,
      verificationEditExpiryTimeSeconds: temp.expiryTimeSeconds,
    });
    const restarted = f.reopen();
    const [candidate] = await restarted.journal.list();
    if (!candidate) throw new Error("Missing durable fixture");
    const result = await f.pair(candidate, "verify_expired", restarted).tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_3",
      basis: "VERIFICATION_PROOF_UNAVAILABLE",
      pendingCleanup: false,
      externalStateUncertain: true,
      liveReleaseVerified: false,
    });
    expect(f.events).toEqual([
      `get:${original.editId}`,
      `get:${temp.editId}`,
      `delete:${temp.editId}`,
      `get:${temp.editId}`,
    ]);
    expect(f.client.edits.insert).not.toHaveBeenCalled();
    expect(f.client.edits.tracks.get).not.toHaveBeenCalled();
    expect(f.poison).not.toHaveBeenCalled();
    expect(await restarted.sessionStore.load()).toMatchObject(original);
    expect((await restarted.journal.list())[0]).toMatchObject({
      verificationCleanupVerified: true,
      state: "AMBIGUOUS",
    });
  });

  it.each(["PREPARED", "TRANSPORT_ATTEMPTED"] as const)(
    "resumes the freshly loaded %s record without reconstructing commit intent",
    async (state) => {
      const f = await fixture(state);
      const restarted = f.reopen();
      const [candidate] = await restarted.journal.list();
      if (!candidate) throw new Error("Missing durable fixture");
      const result = await f.pair(candidate, "verify_expired", restarted).tool.execute({}, {});
      expect(result).toMatchObject(
        state === "PREPARED"
          ? { case: "CASE_2", basis: "COMMIT_TRANSPORT_NOT_ATTEMPTED", liveReleaseVerified: false }
          : { case: "CASE_1", liveReleaseVerified: true },
      );
      expect(f.events[0]).toBe(`get:${original.editId}`);
      expect(f.client.edits.insert).toHaveBeenCalledTimes(state === "PREPARED" ? 0 : 1);
      expect(f.poison).not.toHaveBeenCalled();
    },
  );

  it("does not retry a durable delete attempt whose acknowledgement was lost", async () => {
    const f = await fixture();
    await f.seed({ verificationInsertAttempted: true });
    await f.seed({
      verificationEditId: temp.editId,
      verificationEditExpiryTimeSeconds: temp.expiryTimeSeconds,
    });
    await f.seed({ verificationPreDeleteReadVerified: true });
    await f.seed({ verificationDeleteAttempted: true });
    const restarted = f.reopen();
    const [candidate] = await restarted.journal.list();
    if (!candidate) throw new Error("Missing durable fixture");
    const result = await f.pair(candidate, "verify_expired", restarted).tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_3",
      pendingCleanup: true,
      externalStateUncertain: true,
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
    expect(f.client.edits.insert).not.toHaveBeenCalled();
    expect(f.client.edits.delete).not.toHaveBeenCalled();
    expect(await restarted.sessionStore.load()).toMatchObject(original);
  });

  const crashPoints = [
    ["verificationInsertAttempted", "before", 0, "CASE_1", false],
    ["verificationInsertAttempted", "after", 0, "CASE_3", true],
    ["verificationEditId", "before", 1, "CASE_3", true],
    ["verificationEditId", "after", 1, "CASE_3", false],
    ["verificationObservedStateDigest", "before", 1, "CASE_3", false],
    ["verificationObservedStateDigest", "after", 1, "CASE_1", false],
    ["verificationPreDeleteReadVerified", "before", 1, "CASE_1", false],
    ["verificationPreDeleteReadVerified", "after", 1, "CASE_1", false],
    ["verificationDeleteAttempted", "before", 1, "CASE_1", false],
    ["verificationDeleteAttempted", "after", 1, "CASE_3", true],
    ["verificationDeleteAcknowledged", "before", 1, "CASE_3", true],
    ["verificationDeleteAcknowledged", "after", 1, "CASE_1", false],
    ["verificationCleanupVerified", "before", 1, "CASE_1", false],
    ["verificationCleanupVerified", "after", 1, "CASE_1", false],
  ] as const;
  it.each(crashPoints)(
    "survives %s persistence interrupted %s without replaying claimed transport",
    async (key, phase, initialInserts, recoveredCase, pendingCleanup) => {
      const f = await fixture();
      let interrupted = false;
      const crashJournal: ReleaseCommitAttemptJournal = {
        ...f.journal,
        async updateVerification(attemptId, state, time, patch) {
          if (!interrupted && patch[key] !== undefined) {
            interrupted = true;
            if (phase === "after")
              await f.journal.updateVerification(attemptId, state, time, patch);
            throw new Error("Offline storage interruption");
          }
          return f.journal.updateVerification(attemptId, state, time, patch);
        },
      };
      const first = await f
        .pair(f.candidate, "verify_expired", {
          journal: crashJournal,
          sessionStore: f.sessionStore,
        })
        .tool.execute({}, {});
      expect(first).toMatchObject({
        case: "CASE_3",
        liveReleaseVerified: false,
        externalStateUncertain: true,
      });
      expect(interrupted).toBe(true);
      expect(f.client.edits.insert).toHaveBeenCalledTimes(initialInserts);
      const beforeRestartInserts = f.client.edits.insert.mock.calls.length;
      const beforeRestartDeletes = f.client.edits.delete.mock.calls.length;
      const restarted = f.reopen();
      const [candidate] = await restarted.journal.list();
      if (!candidate) throw new Error("Missing durable fixture");
      const result = await f.pair(candidate, "verify_expired", restarted).tool.execute({}, {});
      expect(result).toMatchObject({
        case: recoveredCase,
        pendingCleanup,
        externalStateUncertain: recoveredCase !== "CASE_1",
        liveReleaseVerified: recoveredCase === "CASE_1",
      });
      expect(f.client.edits.insert).toHaveBeenCalledTimes(
        key === "verificationInsertAttempted" && phase === "before" ? 1 : beforeRestartInserts,
      );
      if (candidate.verificationDeleteAttempted === true)
        expect(f.client.edits.delete).toHaveBeenCalledTimes(beforeRestartDeletes);
      expect(f.client.edits.delete.mock.calls.length).toBeLessThanOrEqual(1);
      expect(f.poison).not.toHaveBeenCalled();
      expect(await restarted.sessionStore.load()).toEqual(
        recoveredCase === "CASE_1"
          ? undefined
          : { version: 1, ...original, createdAt: now.toISOString() },
      );
    },
  );

  it.each(["REMOTE_VERIFIED", "RECONCILED_COMMITTED"] as const)(
    "recovers an interrupted %s state transition using only durable exact proof",
    async (target) => {
      const f = await fixture("TRANSPORT_ATTEMPTED");
      let interrupted = false;
      const crashJournal: ReleaseCommitAttemptJournal = {
        ...f.journal,
        async transition(id, from, to, time, patch) {
          if (!interrupted && to === target) {
            interrupted = true;
            throw new Error("Offline transition interruption");
          }
          return f.journal.transition(id, from, to, time, patch);
        },
      };
      expect(
        await f
          .pair(f.candidate, "verify_expired", {
            journal: crashJournal,
            sessionStore: f.sessionStore,
          })
          .tool.execute({}, {}),
      ).toMatchObject({ case: "CASE_3" });
      const restarted = f.reopen();
      const [candidate] = await restarted.journal.list();
      if (!candidate) throw new Error("Missing durable fixture");
      expect(candidate.verificationObservedStateDigest).toBe(f.candidate.expectedStateDigest);
      expect(
        await f.pair(candidate, "verify_expired", restarted).tool.execute({}, {}),
      ).toMatchObject({ case: "CASE_1", liveReleaseVerified: true });
      expect(f.client.edits.insert).toHaveBeenCalledTimes(1);
      expect(f.client.edits.tracks.get).toHaveBeenCalledTimes(1);
      expect(f.client.edits.delete).toHaveBeenCalledTimes(1);
      expect(f.poison).not.toHaveBeenCalled();
    },
  );
});

describe("reconciliation through real runAgent approval and verification", () => {
  it.each([undefined, "no"] as const)(
    "stops without remote calls when approval is %s",
    async (answer) => {
      const f = await fixture();
      const run = await runPair(f, f.candidate, "verify_expired", answer);
      expect(run.result).toMatchObject({
        ok: false,
        code: answer === undefined ? "APPROVAL_REQUIRED" : "APPROVAL_DENIED",
        externalStateUncertain: false,
      });
      expect(f.events).toEqual([]);
      expect(await f.sessionStore.load()).toMatchObject(original);
    },
  );

  it("uses synthetic exact destructive approval and the real verifier before serializing CASE_1", async () => {
    const f = await fixture();
    const run = await runPair(f, f.candidate, "verify_expired", "yes");
    expect(run.result).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    expect(run.approved).toHaveBeenCalledTimes(1);
    const reply = run.result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(reply?.content ?? "null")).toMatchObject({
      case: "CASE_1",
      basis: "EXPECTED_STATE_OBSERVED",
      externalStateUncertain: false,
      liveReleaseVerified: true,
      commitAcknowledged: false,
      servingPropagationVerified: false,
    });
    expect(f.events[0]).toBe(`get:${original.editId}`);
    const audit = readFileSync(join(f.dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"permission":"destructive"');
    expect(audit).toContain('"code":"VERIFIED"');
    for (const secret of ["PRIVATE", original.editId, temp.editId]) {
      expect(audit).not.toContain(secret);
      expect(reply?.content).not.toContain(secret);
    }
    expect(f.poison).not.toHaveBeenCalled();
  });

  it("reports unresolved destructive recovery as runtime uncertainty rather than fabricated verification", async () => {
    const f = await fixture();
    f.client.edits.delete.mockRejectedValueOnce(new Error("PRIVATE lost delete response"));
    const run = await runPair(f, f.candidate, "verify_expired", "yes");
    expect(run.result).toMatchObject({
      ok: false,
      code: "VERIFICATION_FAILED",
      externalStateUncertain: true,
    });
    expect((await f.journal.list())[0]).toMatchObject({
      state: "REMOTE_VERIFIED",
      verificationDeleteAttempted: true,
    });
    expect(await f.sessionStore.load()).toMatchObject(original);
    expect(run.result.conversation.some((message) => message.role === "tool")).toBe(false);
  });

  it("rejects a changed journal snapshot after exact approval before any remote call", async () => {
    const f = await fixture("TRANSPORT_ATTEMPTED");
    const run = await runPair(f, f.candidate, "verify_expired", "yes", async () => {
      await f.journal.transition(
        f.candidate.attemptId,
        "TRANSPORT_ATTEMPTED",
        "AMBIGUOUS",
        now.toISOString(),
      );
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(run.result.cause).toMatchObject({ code: "COMMIT_STATE_CHANGED" });
    expect(f.events).toEqual([]);
  });

  it("allows the read-only probe to serialize CASE_3 with required:false and no destructive approval", async () => {
    const f = await fixture();
    const run = await runPair(f, f.candidate, "probe");
    expect(run.result).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(run.approved).not.toHaveBeenCalled();
    expect(f.events).toEqual([`get:${original.editId}`]);
    const reply = run.result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(reply?.content ?? "null")).toMatchObject({
      case: "CASE_3",
      externalStateUncertain: true,
      basis: "DESTRUCTIVE_APPROVAL_REQUIRED",
    });
    expect(readFileSync(join(f.dir, "audit.jsonl"), "utf8")).toContain('"required":false');
  });
});
