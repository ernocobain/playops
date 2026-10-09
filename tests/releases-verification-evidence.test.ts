import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { NewAuditEntry } from "../src/audit/index.js";
import { toOperatorError } from "../src/errors/index.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import type { ReleaseEditCleanupJournal } from "../src/releases/cleanup-journal.js";
import {
  ReleaseError,
  type GooglePlayEditSession,
  type ReleaseTrackState,
} from "../src/releases/index.js";
import { createReleaseStateVerificationIntent } from "../src/releases/readback-approval.js";
import type {
  ReleaseVerificationEvidenceEvent,
  ReleaseVerificationEvidenceSink,
} from "../src/releases/verification-evidence.js";
import { createReleaseExactVerificationTool } from "../src/releases/verify-committed-release-tool.js";
import { createApprovalChallenge, createApprovalRequest } from "../src/runtime/approvals/index.js";

const packageName = "com.example.evidence";
const targetTrack = "wear:production";
const editId = "INTERNAL-TEMP-EDIT-STAGE3E2A-DO-NOT-DISCLOSE";
const expiryTimeSeconds = "4102444800";
const fixedNow = new Date("2026-10-08T05:00:00.123Z");
const track: ReleaseTrackState = {
  track: targetTrack,
  releases: [{ name: "Candidate 101", status: "completed", versionCodes: ["101"] }],
};
const eventTypes = [
  "verification_insert_attempted",
  "verification_edit_identified",
  "verification_state_observed",
  "verification_pre_delete_read_verified",
  "verification_delete_attempted",
  "verification_delete_acknowledged",
  "verification_cleanup_verified",
] as const;

function build(failAt?: ReleaseVerificationEvidenceEvent["type"]) {
  const timeline: string[] = [];
  const events: ReleaseVerificationEvidenceEvent[] = [];
  const audit: NewAuditEntry[] = [];
  const records = new Map<string, Parameters<ReleaseEditCleanupJournal["record"]>[0]>();
  const sink: ReleaseVerificationEvidenceSink = {
    record: vi.fn(async (event) => {
      timeline.push(`sink:${event.type}`);
      events.push(event);
      await Promise.resolve();
      if (event.type === failAt) throw new Error(`Local sink failed for ${editId}`);
      timeline.push(`recorded:${event.type}`);
    }),
  };
  const journal: ReleaseEditCleanupJournal = {
    list: vi.fn(async () => []),
    record: vi.fn(async (entry) => {
      timeline.push("cleanup.record");
      records.set(entry.editId, entry);
    }),
    remove: vi.fn(async (id) => {
      timeline.push("cleanup.remove");
      records.delete(id);
    }),
  };
  const gateway = {
    listReleaseSummaries: vi.fn(async () => {
      timeline.push("summary");
      return [
        {
          releaseName: "Candidate 101",
          track: targetTrack,
          versionCodes: ["101"],
          releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
        },
      ];
    }),
    createEdit: vi.fn(async () => {
      timeline.push("insert");
      return { packageName, editId, expiryTimeSeconds };
    }),
    getTrack: vi.fn(async (session: GooglePlayEditSession, selectedTrack: string) => {
      expect(session.editId).toBe(editId);
      expect(selectedTrack).toBe(targetTrack);
      timeline.push("track");
      return track;
    }),
    deleteEdit: vi.fn(async (session: GooglePlayEditSession) => {
      expect(session.editId).toBe(editId);
      timeline.push("delete");
    }),
    commitEdit: vi.fn(async () => {
      throw new Error("Commit forbidden");
    }),
    updateTrack: vi.fn(async () => {
      throw new Error("Track update forbidden");
    }),
    uploadBundle: vi.fn(async () => {
      throw new Error("Upload forbidden");
    }),
  };
  const intent = createReleaseStateVerificationIntent({
    packageName,
    targetTrack,
    versionCode: "101",
    expectedReleaseName: "Candidate 101",
    expectedStateDigest: createReleaseCommitStateDigest(track),
  });
  const options = {
    packageName,
    intent,
    summaryGateway: gateway,
    temporaryEditGateway: gateway,
    sessionStore: { load: vi.fn(async () => undefined), save: vi.fn(), clear: vi.fn() },
    cleanupJournal: journal,
    auditLedger: {
      append: vi.fn(async (entry: NewAuditEntry) => {
        audit.push(entry);
      }),
    },
    now: () => new Date(fixedNow),
    evidenceSink: sink,
  };
  const built = createReleaseExactVerificationTool(options);
  return { ...built, timeline, events, audit, records, sink, journal, gateway, options };
}

describe("Stage 3E.2A trusted verification lifecycle evidence", () => {
  it("preserves the evidence failure and cleanup facts when failure-audit persistence also fails", async () => {
    const built = build("verification_pre_delete_read_verified");
    built.options.auditLedger.append.mockRejectedValue(new Error(`Audit unavailable: ${editId}`));
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
      failureDomain: "local_evidence_persistence",
      failedEvent: "verification_pre_delete_read_verified",
      committedStateObserved: true,
      temporaryEditCleanupSucceeded: true,
      verificationCleanupVerified: true,
      auditPersistenceFailed: true,
      externalStateUncertain: false,
    });
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
    expect(built.records.size).toBe(0);
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 4));
  });

  it("keeps Stage 3E.1 behaviour and clock consumption unchanged without a sink", async () => {
    const built = build();
    const now = vi.fn(() => new Date(fixedNow));
    const plain = createReleaseExactVerificationTool({
      ...built.options,
      evidenceSink: undefined,
      now,
    });
    const result = await plain.tool.execute({}, {});
    expect(result.verificationCleanupVerified).toBe(true);
    expect(built.events).toEqual([]);
    expect(built.timeline).toEqual([
      "summary",
      "insert",
      "cleanup.record",
      "track",
      "delete",
      "cleanup.remove",
    ]);
    expect(now).toHaveBeenCalledTimes(3);
  });

  it("awaits the seven immutable events in order around the existing safe Google lifecycle", async () => {
    const built = build();
    const result = await built.tool.execute({}, {});
    expect(built.events.map((event) => event.type)).toEqual(eventTypes);
    expect(built.timeline).toEqual([
      "summary",
      "sink:verification_insert_attempted",
      "recorded:verification_insert_attempted",
      "insert",
      "cleanup.record",
      "sink:verification_edit_identified",
      "recorded:verification_edit_identified",
      "track",
      "sink:verification_state_observed",
      "recorded:verification_state_observed",
      "sink:verification_pre_delete_read_verified",
      "recorded:verification_pre_delete_read_verified",
      "sink:verification_delete_attempted",
      "recorded:verification_delete_attempted",
      "delete",
      "sink:verification_delete_acknowledged",
      "recorded:verification_delete_acknowledged",
      "cleanup.remove",
      "sink:verification_cleanup_verified",
      "recorded:verification_cleanup_verified",
    ]);
    expect(built.events[1]).toEqual({
      type: "verification_edit_identified",
      editId,
      expiryTimeSeconds,
    });
    expect(built.events[2]).toEqual({
      type: "verification_state_observed",
      observedStateDigest: createReleaseCommitStateDigest(track),
      observedAtUtc: fixedNow.toISOString(),
    });
    expect(built.events.every(Object.isFrozen)).toBe(true);
    expect(new Set(built.events.map((event) => event.type)).size).toBe(eventTypes.length);
    expect(result).toMatchObject({
      observedStateDigest: built.options.intent.expectedStateDigest,
      verificationCleanupVerified: true,
    });
    expect(built.gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(built.gateway.getTrack).toHaveBeenCalledTimes(1);
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
    expect(built.gateway.commitEdit).not.toHaveBeenCalled();
    expect(built.gateway.updateTrack).not.toHaveBeenCalled();
    expect(built.gateway.uploadBundle).not.toHaveBeenCalled();
    expect(built.records.size).toBe(0);
  });

  it.each(eventTypes)(
    "fails locally at %s without success, duplicate evidence, or abandoned cleanup",
    async (failAt) => {
      const built = build(failAt);
      const position = eventTypes.indexOf(failAt);
      const failure = await built.tool.execute({}, {}).then(
        () => {
          throw new Error("Evidence failure must not return success");
        },
        (cause: unknown) => cause,
      );
      expect(failure).toMatchObject({
        code: "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
        failureDomain: "local_evidence_persistence",
        failedEvent: failAt,
        committedStateObserved: position >= 2,
        temporaryEditCleanupSucceeded: position > 0,
        verificationCleanupVerified: position > 0,
        externalStateUncertain: false,
      });
      expect(toOperatorError(failure)).toMatchObject({
        code: "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
        category: "persistence",
        externalStateUncertain: false,
      });
      expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, position + 1));
      expect(new Set(built.events.map((event) => event.type)).size).toBe(built.events.length);
      expect(built.events.every(Object.isFrozen)).toBe(true);
      expect(built.gateway.createEdit).toHaveBeenCalledTimes(position === 0 ? 0 : 1);
      expect(built.gateway.getTrack).toHaveBeenCalledTimes(position < 2 ? 0 : 1);
      expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(position === 0 ? 0 : 1);
      expect(built.gateway.commitEdit).not.toHaveBeenCalled();
      expect(built.gateway.updateTrack).not.toHaveBeenCalled();
      expect(built.gateway.uploadBundle).not.toHaveBeenCalled();
      expect(built.records.size).toBe(0);
      expect(built.audit.at(-1)).toMatchObject({
        status: "failure",
        metadata: {
          errorCode: "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
          exactTrackStateVerified: position >= 2,
          temporaryEditCleanupSucceeded: position > 0,
          externalStateUncertain: false,
        },
      });
      expect((failure as Error).message).not.toContain(editId);
      expect(JSON.stringify(built.audit)).not.toContain(editId);
      expect(JSON.stringify(toOperatorError(failure))).not.toContain(editId);
    },
  );

  it.each(eventTypes.slice(1, 5))(
    "preserves LOCAL %s failure with an uncertain single cleanup delete",
    async (failAt) => {
      const built = build(failAt);
      built.gateway.deleteEdit.mockRejectedValue(new Error(`Transport uncertain for ${editId}`));
      const position = eventTypes.indexOf(failAt);
      const failure = await built.tool.execute({}, {}).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({
        code: "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
        failureDomain: "local_evidence_persistence",
        failedEvent: failAt,
        committedStateObserved: position >= 2,
        temporaryEditCleanupSucceeded: false,
        verificationCleanupVerified: false,
        externalStateUncertain: true,
      });
      expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, position + 1));
      expect(built.gateway.createEdit).toHaveBeenCalledTimes(1);
      expect(built.gateway.getTrack).toHaveBeenCalledTimes(position < 2 ? 0 : 1);
      expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
      expect(built.gateway.commitEdit).not.toHaveBeenCalled();
      expect(built.gateway.updateTrack).not.toHaveBeenCalled();
      expect(built.gateway.uploadBundle).not.toHaveBeenCalled();
      expect(built.records.get(editId)).toMatchObject({ editId, expiryTimeSeconds });
      expect(built.journal.remove).not.toHaveBeenCalled();
      expect(built.audit.at(-1)?.metadata).toMatchObject({
        temporaryEditCleanupSucceeded: false,
        externalStateUncertain: true,
      });
      expect((failure as Error).message).not.toContain(editId);
      expect(JSON.stringify(built.audit)).not.toContain(editId);
      expect(toOperatorError(failure)).toMatchObject({
        category: "persistence",
        externalStateUncertain: true,
      });
    },
  );

  it("does not mask LOCAL evidence failure or claim complete cleanup when cleanup-record removal fails", async () => {
    const built = build("verification_delete_acknowledged");
    vi.mocked(built.journal.remove).mockRejectedValue(new Error("Cleanup record unavailable"));
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
      committedStateObserved: true,
      temporaryEditCleanupSucceeded: true,
      verificationCleanupVerified: false,
      externalStateUncertain: false,
    });
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
    expect(built.journal.remove).toHaveBeenCalledTimes(1);
    expect(built.records.has(editId)).toBe(true);
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 6));
  });

  it("emits only insert/identity on a mismatch while exact-ID cleanup still runs once", async () => {
    const built = build();
    built.gateway.getTrack.mockResolvedValue({
      track: targetTrack,
      releases: [
        { ...track.releases[0], name: "Other", status: "completed", versionCodes: ["101"] },
      ],
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
      externalStateUncertain: false,
    });
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 2));
    expect(built.timeline).toEqual([
      "summary",
      "sink:verification_insert_attempted",
      "recorded:verification_insert_attempted",
      "insert",
      "cleanup.record",
      "sink:verification_edit_identified",
      "recorded:verification_edit_identified",
      "delete",
      "cleanup.remove",
    ]);
    expect(built.gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(built.gateway.getTrack).toHaveBeenCalledTimes(1);
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
    expect(built.records.size).toBe(0);
  });

  it("does not emit observed proof after a failed track read", async () => {
    const built = build();
    built.gateway.getTrack.mockRejectedValue(new Error("Read failed"));
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_TRACK_READ_FAILED",
    });
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 2));
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
  });

  it("emits insert_attempted once on deterministic insert failure, without identity, retry, read or delete", async () => {
    const built = build();
    built.gateway.createEdit.mockRejectedValue(
      new ReleaseError("INVALID_ARGUMENT", "Deterministic insert rejection", {
        externalStateUncertain: false,
      }),
    );
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EDIT_CREATE_FAILED",
    });
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 1));
    expect(built.gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(built.gateway.getTrack).not.toHaveBeenCalled();
    expect(built.gateway.deleteEdit).not.toHaveBeenCalled();
    expect(built.journal.record).not.toHaveBeenCalled();
  });

  it.each(["", "1"])(
    "never identifies or guesses deletion of an invalid/expired insert response (%s)",
    async (expiry) => {
      const built = build();
      built.gateway.createEdit.mockResolvedValue({
        packageName,
        editId,
        expiryTimeSeconds: expiry,
      });
      await expect(built.tool.execute({}, {})).rejects.toMatchObject({
        code: "VERIFICATION_EDIT_RESPONSE_INVALID",
        externalStateUncertain: true,
      });
      expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 1));
      expect(built.gateway.createEdit).toHaveBeenCalledTimes(1);
      expect(built.gateway.getTrack).not.toHaveBeenCalled();
      expect(built.gateway.deleteEdit).not.toHaveBeenCalled();
    },
  );

  it("keeps the existing cleanup-journal write barrier ahead of deep reads and evidence identity delivery", async () => {
    const built = build();
    vi.mocked(built.journal.record).mockRejectedValue(new Error("Journal unavailable"));
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_JOURNAL_WRITE_FAILED",
      externalStateUncertain: false,
    });
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 1));
    expect(built.gateway.getTrack).not.toHaveBeenCalled();
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
  });

  it("never emits delete acknowledgement or cleanup proof for an uncertain delete transport", async () => {
    const built = build();
    built.gateway.deleteEdit.mockRejectedValue(new Error("Delete uncertain"));
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EDIT_CLEANUP_FAILED",
      externalStateUncertain: true,
    });
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 5));
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
    expect(built.journal.remove).not.toHaveBeenCalled();
    expect(built.records.has(editId)).toBe(true);
    expect(built.audit.at(-1)?.metadata).toMatchObject({ temporaryEditCleanupSucceeded: false });
  });

  it("withholds cleanup_verified if the acknowledged delete's cleanup-record removal fails", async () => {
    const built = build();
    vi.mocked(built.journal.remove).mockRejectedValue(new Error("Remove unavailable"));
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_JOURNAL_REMOVE_FAILED",
      externalStateUncertain: false,
    });
    expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, 6));
    expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(1);
    expect(built.journal.remove).toHaveBeenCalledTimes(1);
    expect(built.records.has(editId)).toBe(true);
  });

  it.each(eventTypes)(
    "does not cross the awaited %s barrier before the sink resolves",
    async (at) => {
      const built = build();
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(built.sink.record).mockImplementation(async (event) => {
        built.events.push(event);
        if (event.type === at) {
          entered();
          await barrier;
        }
      });
      let settled = false;
      const execution = built.tool.execute({}, {}).then((result) => {
        settled = true;
        return result;
      });
      await reached;
      try {
        const position = eventTypes.indexOf(at);
        expect(settled).toBe(false);
        expect(built.events.map((event) => event.type)).toEqual(eventTypes.slice(0, position + 1));
        expect(built.gateway.createEdit).toHaveBeenCalledTimes(position === 0 ? 0 : 1);
        expect(built.gateway.getTrack).toHaveBeenCalledTimes(position < 2 ? 0 : 1);
        expect(built.gateway.deleteEdit).toHaveBeenCalledTimes(position < 5 ? 0 : 1);
      } finally {
        release();
        await execution;
      }
      expect(built.events.map((event) => event.type)).toEqual(eventTypes);
    },
  );

  it("preserves exact trusted response identity and decimal expiry without reconstruction", async () => {
    const built = build();
    const exactExpiry = "0004102444800";
    built.gateway.createEdit.mockResolvedValue({
      packageName,
      editId,
      expiryTimeSeconds: exactExpiry,
    });
    await built.tool.execute({}, {});
    expect(built.events[1]).toEqual({
      type: "verification_edit_identified",
      editId,
      expiryTimeSeconds: exactExpiry,
    });
    expect(built.journal.record).toHaveBeenCalledWith(
      expect.objectContaining({ editId, expiryTimeSeconds: exactExpiry }),
    );
  });

  it("keeps temporary identity and lifecycle details out of serialization, audit, safe summaries and approval challenge", async () => {
    const built = build();
    const result = await built.tool.execute({}, {});
    const serialized = built.binding.serializeResult(result, {
      toolName: built.tool.name,
      permission: "destructive",
      required: true,
      code: "VERIFIED",
      verified: true,
    } as never);
    expect(JSON.parse(serialized)).toEqual({
      targetTrack,
      versionCode: "101",
      releaseName: "Candidate 101",
      status: "completed",
      releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
      releaseObserved: true,
      exactTrackStateVerified: true,
      liveReleaseVerified: true,
      servingPropagationVerified: false,
      observedStateDigest: built.options.intent.expectedStateDigest,
      verificationCleanupVerified: true,
    });
    const approval = built.binding.approval;
    if (!approval) throw new Error("Destructive approval missing");
    const summary = approval.createSafeSummary({});
    const ledger = { append: vi.fn(), read: () => [] };
    const request = createApprovalRequest(
      {
        toolName: built.tool.name,
        permission: "destructive",
        requestDigest: approval.createRequestDigest({}),
        safeSummary: summary,
      },
      { ledger, now: () => fixedNow },
    );
    const challenge = createApprovalChallenge(request, { ledger, now: () => fixedNow });
    for (const safe of [
      serialized,
      JSON.stringify(result),
      JSON.stringify(built.audit),
      summary,
      JSON.stringify(request),
      JSON.stringify(challenge),
      JSON.stringify(ledger.append.mock.calls),
      JSON.stringify(built.binding.llm),
    ]) {
      expect(safe).not.toContain(editId);
      expect(safe).not.toContain(expiryTimeSeconds);
      expect(safe).not.toContain("verification_insert_attempted");
      expect(safe).not.toContain("verification_delete_attempted");
    }
    expect(built.events[1]).toMatchObject({ editId, expiryTimeSeconds });
    expect(Reflect.set(built.events[1] ?? {}, "editId", "replacement")).toBe(false);
    expect(built.events[1]).toMatchObject({ editId, expiryTimeSeconds });
    const before = built.events.length;
    await expect(built.tool.verify?.({}, result, {})).resolves.toBe(true);
    expect(built.events).toHaveLength(before);
    expect(() => built.tool.outputSchema.parse({ ...result, temporaryEditId: editId })).toThrow();
  });

  it("refuses model-supplied sink or lifecycle fields before any evidence or Google call", async () => {
    const built = build();
    for (const input of [
      { evidenceSink: {} },
      { editId },
      { temporaryEditExpiry: expiryTimeSeconds },
    ]) {
      await expect(built.tool.execute(input as never, {})).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(built.events).toEqual([]);
    expect(built.gateway.listReleaseSummaries).not.toHaveBeenCalled();
    expect(built.gateway.createEdit).not.toHaveBeenCalled();
    expect(built.binding.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("emits no lifecycle event before Layer-A observation and managed-session refusal pass", async () => {
    const built = build();
    built.gateway.listReleaseSummaries.mockResolvedValue([]);
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "COMMITTED_RELEASE_NOT_OBSERVED",
    });
    expect(built.events).toEqual([]);
    expect(built.gateway.createEdit).not.toHaveBeenCalled();
    built.gateway.listReleaseSummaries.mockResolvedValue([
      {
        releaseName: "Candidate 101",
        track: targetTrack,
        versionCodes: ["101"],
        releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
      },
    ]);
    const blocked = createReleaseExactVerificationTool({
      ...built.options,
      sessionStore: {
        ...built.options.sessionStore,
        load: async () => ({
          version: 1,
          packageName,
          editId: "managed-not-temp",
          expiryTimeSeconds,
          createdAt: fixedNow.toISOString(),
        }),
      },
    });
    await expect(blocked.tool.execute({}, {})).rejects.toMatchObject({
      code: "MANAGED_EDIT_ALREADY_OPEN",
    });
    expect(built.events).toEqual([]);
    expect(built.gateway.createEdit).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid trusted sink construction option", () => {
    const built = build();
    expect(() =>
      createReleaseExactVerificationTool({ ...built.options, evidenceSink: {} as never }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("has no commit-journal, daemon, updateVerification or journal-transition dependency", () => {
    for (const file of ["verify-committed-release-tool.ts", "verification-evidence.ts"]) {
      const source = readFileSync(new URL(`../src/releases/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["'][^"']*(?:commit-attempt-journal|daemon\/)/u);
      expect(source).not.toContain("updateVerification(");
      expect(source).not.toContain(".transition(");
    }
  });
});
