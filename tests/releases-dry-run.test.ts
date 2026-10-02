import { describe, expect, it, vi } from "vitest";
import type { NewAuditEntry } from "../src/audit/index.js";
import { createReleaseCommitIntent } from "../src/releases/commit-approval.js";
import { createReleaseVerificationIntent } from "../src/releases/readback-approval.js";
import {
  createHaltRolloutIntent,
  createResumeRolloutIntent,
} from "../src/releases/status-control-approval.js";
import { createReleaseRolloutIntent } from "../src/releases/rollout-approval.js";
import type { ReleaseEditSession, ReleaseState, ReleaseTrackState } from "../src/releases/index.js";
import type { ReleaseRolloutGateway } from "../src/releases/gateway.js";
import {
  MUTATING_RELEASE_TOOL_NAMES,
  createReleaseDryRunPlan,
  renderReleaseDryRunPlan,
  type ReleaseDryRunRequest,
} from "../src/releases/dry-run.js";
import { runReleasesCli, type ReleaseDryRunCliDeps } from "../src/cli/releases.js";
import { runCli } from "../src/cli/main.js";

const packageName = "com.example.dryrun";
const targetTrack = "production";
const versionCode = "321";
const releaseName = "3.2.1";
const artifactPath = "/private/operator/releases/app-release.aab";
const noteText = "PRIVATE-DRY-RUN-NOTE";
const expiryTimeSeconds = "4102444800";

function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: releaseName,
    status: "inProgress",
    versionCodes: [versionCode],
    userFraction: 0.1,
    releaseNotes: [{ language: "en-US", text: noteText }],
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 4,
    ...overrides,
  };
}

function trackState(release: ReleaseState = targetRelease()): ReleaseTrackState {
  return {
    track: targetTrack,
    releases: [
      {
        name: "Older release",
        status: "completed",
        versionCodes: ["320"],
        releaseNotes: [{ language: "en-US", text: "Older private note" }],
        inAppUpdatePriority: 1,
      },
      release,
    ],
  };
}

function commitIntent() {
  return createReleaseCommitIntent({
    packageName,
    editId: "edit-1",
    targetTrack,
    versionCode,
    targetTrackState: trackState(),
    validatedEdit: { valid: true, expiryTimeSeconds },
  });
}

function baseRequests(): ReleaseDryRunRequest[] {
  const commit = commitIntent();
  const rollout = createReleaseRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: trackState(),
    newFraction: 0.25,
  });
  const halt = createHaltRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: trackState(targetRelease({ countryTargeting: undefined })),
  });
  const resume = createResumeRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: trackState(targetRelease({ status: "halted" })),
  });
  return [
    { kind: "open_edit", packageName },
    { kind: "upload_bundle", packageName, artifactPath },
    {
      kind: "configure_release",
      packageName,
      targetTrack,
      releaseName,
      releaseStatus: "inProgress",
      initialRolloutFraction: 0.1,
      uploadedBundle: { versionCode, sha256: "a".repeat(64) },
      retainVersionCodes: ["320"],
    },
    {
      kind: "attach_release_notes",
      packageName,
      targetTrack,
      configuredRelease: {
        targetTrack,
        releaseName,
        status: "inProgress",
        versionCodes: [versionCode],
        userFraction: 0.1,
      },
      uploadedBundle: { versionCode, sha256: "a".repeat(64) },
      localizedReleaseNotes: [{ language: "en-us", text: noteText }],
    },
    { kind: "commit_edit", intent: commit },
    { kind: "verify_committed_release", intent: createReleaseVerificationIntent(commit) },
    { kind: "update_rollout_fraction", intent: rollout },
    { kind: "halt_rollout", intent: halt },
    { kind: "resume_rollout", intent: resume },
    {
      kind: "cleanup_known_edit",
      packageName,
      candidate: {
        recordSource: "managed_session",
        editId: "managed-edit-1",
        expiryTimeSeconds,
      },
    },
  ];
}

function requestOf(kind: ReleaseDryRunRequest["kind"]): ReleaseDryRunRequest {
  const request = baseRequests().find((candidate) => candidate.kind === kind);
  if (!request) throw new Error(`dry-run request missing: ${kind}`);
  return request;
}

function memoryStore(initial?: ReleaseEditSession) {
  let value = initial;
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next: ReleaseEditSession) => {
      value = next;
    }),
    clear: vi.fn(async () => {
      value = undefined;
    }),
  };
}

function auditLedger() {
  const entries: NewAuditEntry[] = [];
  return {
    entries,
    append: vi.fn(async (entry: NewAuditEntry) => {
      entries.push(entry);
    }),
  };
}

function rawTrack(state: ReleaseTrackState): ReleaseTrackState {
  return structuredClone(state);
}

function rolloutFakeGateway() {
  const events: string[] = [];
  let editNumber = 0;
  let operational = trackState(targetRelease({ countryTargeting: undefined }));
  const gateway: ReleaseRolloutGateway = {
    async listReleaseSummaries() {
      events.push("applications.tracks.releases.list");
      return [
        {
          releaseName,
          track: targetTrack,
          versionCodes: [versionCode],
          releaseLifecycleState: "PUBLISHED",
        },
      ];
    },
    async createEdit() {
      editNumber += 1;
      const editId = editNumber === 1 ? "status-edit" : "verification-edit";
      events.push("edits.insert");
      return { packageName, editId, expiryTimeSeconds };
    },
    async getEdit(session) {
      events.push("edits.get");
      return { id: session.editId, expiryTimeSeconds };
    },
    async getTrack(session) {
      events.push("edits.tracks.get");
      return session.editId === "verification-edit" ? rawTrack(operational) : rawTrack(operational);
    },
    async updateTrack(_session, _track, request) {
      events.push("edits.tracks.update");
      operational = rawTrack({
        track: request.track,
        releases: request.releases.map((release) => ({
          ...(release.name !== undefined ? { name: release.name } : {}),
          status: release.status,
          versionCodes: [...release.versionCodes],
          ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
          ...(release.releaseNotes !== undefined ? { releaseNotes: release.releaseNotes } : {}),
          ...(release.countryTargeting !== undefined
            ? { countryTargeting: release.countryTargeting }
            : {}),
          ...(release.inAppUpdatePriority !== undefined
            ? { inAppUpdatePriority: release.inAppUpdatePriority }
            : {}),
        })),
      });
      return rawTrack(operational);
    },
    async validateEdit() {
      events.push("edits.validate");
      return { id: "status-edit", expiryTimeSeconds };
    },
    async commitEdit() {
      events.push("edits.commit");
      return { id: "status-edit", expiryTimeSeconds };
    },
    async deleteEdit() {
      events.push("edits.delete");
    },
  };
  return { gateway, events };
}

describe("Phase 4.14 shared dry-run plan", () => {
  it("covers exactly the current mutating Release Agent capability set", () => {
    expect([...MUTATING_RELEASE_TOOL_NAMES].sort()).toEqual(
      [
        "releases.attach_release_notes",
        "releases.cleanup_known_edit",
        "releases.commit_edit",
        "releases.configure_release",
        "releases.halt_rollout",
        "releases.open_edit",
        "releases.resume_rollout",
        "releases.update_rollout_fraction",
        "releases.upload_bundle",
        "releases.verify_committed_release",
      ].sort(),
    );
    expect(
      baseRequests()
        .map((request) => createReleaseDryRunPlan(request).toolName)
        .sort(),
    ).toEqual([...MUTATING_RELEASE_TOOL_NAMES].sort());
  });

  it("is deterministic, immutable, side-effect-free, and uses no real edit ids", () => {
    const request = requestOf("commit_edit");
    const first = createReleaseDryRunPlan(request);
    const second = createReleaseDryRunPlan(request);
    expect(first).toEqual(second);
    expect(first.sideEffectsExecuted).toBe(false);
    expect(first.executionEvidence).toEqual({
      apiCalls: 0,
      networkCalls: 0,
      browserCalls: 0,
      approvalRequests: 0,
      approvalTokensConsumed: 0,
      sessionSaves: 0,
      sessionClears: 0,
      auditWrites: 0,
    });
    expect(JSON.stringify(first)).not.toContain("edit-1");
    expect(() => (first.apiCalls as unknown as unknown[]).push({})).toThrow();
  });

  it("plans exact fraction workflow order with symbolic and conditional verification steps", () => {
    const request = baseRequests().find(
      (candidate) => candidate.kind === "update_rollout_fraction",
    );
    if (!request) throw new Error("rollout request missing");
    const plan = createReleaseDryRunPlan(request);
    expect(plan.apiCalls.map((call) => call.operation)).toEqual([
      "applications.tracks.releases.list",
      "edits.insert",
      "edits.get",
      "edits.tracks.get",
      "edits.tracks.update",
      "edits.tracks.get",
      "edits.validate",
      "edits.commit",
      "applications.tracks.releases.list",
      "edits.insert",
      "edits.tracks.get",
      "edits.delete",
    ]);
    expect(plan.apiCalls[1]?.resultBinding).toMatchObject({ field: "id" });
    expect(plan.apiCalls[9]?.condition).toContain("post-commit direct summary observes");
    expect(plan.apiCalls[11]?.pathParams.editId).toMatchObject({
      kind: "result",
      step: 10,
      field: "id",
    });
    expect(plan.remotePreconditions.join(" ")).toContain("newFraction > currentFraction");
    expect(JSON.stringify(plan)).toContain("0.25");
    expect(JSON.stringify(plan)).not.toContain(noteText);
  });

  it("represents each operation's permission and approval requirement", () => {
    const plans = baseRequests().map((request) => createReleaseDryRunPlan(request));
    const byTool = new Map(plans.map((plan) => [plan.toolName, plan]));
    expect(byTool.get("releases.open_edit")).toMatchObject({
      realPermission: "destructive",
      approvalRequiredForRealRun: true,
    });
    expect(byTool.get("releases.upload_bundle")).toMatchObject({
      realPermission: "write",
      approvalRequiredForRealRun: false,
    });
    expect(byTool.get("releases.configure_release")).toMatchObject({
      realPermission: "write",
      approvalRequiredForRealRun: false,
    });
    expect(byTool.get("releases.attach_release_notes")).toMatchObject({
      realPermission: "write",
      approvalRequiredForRealRun: false,
    });
    expect(byTool.get("releases.commit_edit")).toMatchObject({
      realPermission: "publish",
      approvalRequiredForRealRun: true,
    });
    expect(byTool.get("releases.verify_committed_release")).toMatchObject({
      realPermission: "destructive",
      approvalRequiredForRealRun: true,
    });
    expect(byTool.get("releases.update_rollout_fraction")).toMatchObject({
      realPermission: "destructive",
      approvalRequiredForRealRun: true,
    });
    expect(byTool.get("releases.halt_rollout")).toMatchObject({
      realPermission: "destructive",
      approvalRequiredForRealRun: true,
    });
    expect(byTool.get("releases.resume_rollout")).toMatchObject({
      realPermission: "destructive",
      approvalRequiredForRealRun: true,
    });
  });

  it("plans upload semantics without exposing artifact path/bytes or deprecated acknowledgement", () => {
    const plan = createReleaseDryRunPlan(requestOf("upload_bundle"));
    expect(plan.apiCalls.map((call) => call.operation)).toEqual([
      "edits.get",
      "edits.bundles.upload",
      "edits.bundles.list",
    ]);
    expect(plan.apiCalls[1]).toMatchObject({
      httpMethod: "POST",
      mutation: true,
      retryPolicy: "retry:false",
      media: { contentType: "application/octet-stream", pathShown: false, bytesShown: false },
    });
    expect(JSON.stringify(plan)).not.toContain(artifactPath);
    expect(JSON.stringify(plan)).not.toContain("ackBundleInstallationWarning");
  });

  it("plans configure and notes bodies without collapsing them into generic update", () => {
    const configure = createReleaseDryRunPlan(requestOf("configure_release"));
    expect(configure.apiCalls.map((call) => call.operation)).toEqual([
      "edits.get",
      "edits.bundles.list",
      "edits.tracks.get",
      "edits.tracks.update",
      "edits.tracks.get",
    ]);
    expect(JSON.stringify(configure.apiCalls[3]?.bodyShape)).toContain("releaseNotes");
    expect(JSON.stringify(configure.apiCalls[3]?.bodyShape)).toContain("omittedFields");
    const notes = createReleaseDryRunPlan(requestOf("attach_release_notes"));
    expect(notes.apiCalls.map((call) => call.operation)).toEqual([
      "edits.get",
      "edits.bundles.list",
      "edits.tracks.get",
      "edits.tracks.update",
      "edits.tracks.get",
    ]);
    expect(JSON.stringify(notes.apiCalls[3]?.bodyShape)).toContain("releaseNotes");
    expect(JSON.stringify(notes.apiCalls[3]?.bodyShape)).toContain(
      "<operator-bound text redacted>",
    );
    expect(JSON.stringify(notes.apiCalls[3]?.bodyShape)).not.toContain(noteText);
  });

  it("plans commit and deep verification with correct symbolic/conditional behavior", () => {
    const commit = createReleaseDryRunPlan(requestOf("commit_edit"));
    expect(commit.apiCalls.map((call) => call.operation)).toEqual([
      "edits.get",
      "edits.tracks.get",
      "edits.validate",
      "edits.commit",
    ]);
    expect(commit.apiCalls[3]).toMatchObject({
      httpMethod: "POST",
      mutation: true,
      retryPolicy: "retry:false",
      query: { changesInReviewBehavior: "ERROR_IF_IN_REVIEW", changesNotSentForReview: false },
      bodyShape: { kind: "empty" },
    });
    expect(
      commit.localActions
        .map((action: { readonly action: string }) => action.action)
        .some((action: string) => action.includes("clear managed session after confirmed commit")),
    ).toBe(true);
    const verify = createReleaseDryRunPlan(requestOf("verify_committed_release"));
    expect(verify.apiCalls.map((call) => call.operation)).toEqual([
      "applications.tracks.releases.list",
      "edits.insert",
      "edits.tracks.get",
      "edits.delete",
    ]);
    expect(verify.apiCalls[1]?.condition).toContain("expected release is observed");
    expect(verify.apiCalls[3]?.pathParams.editId).toMatchObject({
      kind: "result",
      step: 2,
      field: "id",
    });
  });

  it("distinguishes HALT and RESUME with immutable fraction and status-only intent", () => {
    const halt = createReleaseDryRunPlan(requestOf("halt_rollout"));
    const resume = createReleaseDryRunPlan(requestOf("resume_rollout"));
    expect(halt).not.toEqual(resume);
    expect(JSON.stringify(halt)).toContain("inProgress");
    expect(JSON.stringify(halt)).toContain("halted");
    expect(JSON.stringify(resume)).toContain("halted");
    expect(JSON.stringify(resume)).toContain("inProgress");
    expect(halt.remotePreconditions.join(" ")).toContain("userFraction remains unchanged");
    expect(resume.remotePreconditions.join(" ")).toContain("userFraction remains unchanged");
    expect(JSON.stringify(halt)).not.toContain("newFraction");
    expect(JSON.stringify(resume)).not.toContain("newFraction");
  });

  it("renders a stable human plan from the structured plan", () => {
    const plan = createReleaseDryRunPlan(requestOf("commit_edit"));
    const rendered = renderReleaseDryRunPlan(plan);
    expect(rendered).toContain("DRY RUN — NO API CALLS EXECUTED");
    expect(rendered).toContain("Tool: releases.commit_edit");
    expect(rendered).toContain("POST edits.commit");
    expect(rendered).toContain("ERROR_IF_IN_REVIEW");
    expect(rendered).toContain("NO API CALLS WERE EXECUTED.");
    expect(rendered).not.toContain("edit-1");
    expect(rendered).not.toContain("PRIVATE");
  });
});

describe("Phase 4.14 operator dry-run CLI adapter", () => {
  it("recognizes --dry-run only in the trusted operator layer", async () => {
    const plan = createReleaseDryRunPlan(requestOf("open_edit"));
    const output: string[] = [];
    let calls = 0;
    const deps: ReleaseDryRunCliDeps = {
      createPlan: async (toolName) => {
        calls += 1;
        expect(toolName).toBe("releases.open_edit");
        return plan;
      },
    };
    const code = await runReleasesCli(
      ["--dry-run", "releases.open_edit"],
      {
        write: (text) => output.push(text),
        writeError: (text) => output.push(`ERROR:${text}`),
      },
      deps,
    );
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(output.join("\n")).toContain("NO API CALLS WERE EXECUTED.");
  });

  it("rejects --dry-run=false and unknown operations without invoking the trusted factory", async () => {
    const createPlan = vi.fn(async () => createReleaseDryRunPlan(requestOf("open_edit")));
    const deps: ReleaseDryRunCliDeps = { createPlan };
    const output: string[] = [];
    await expect(
      runReleasesCli(
        ["--dry-run=false", "releases.open_edit"],
        {
          write: (text) => output.push(text),
          writeError: (text) => output.push(`ERROR:${text}`),
        },
        deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runReleasesCli(
        ["--dry-run", "releases.not_real"],
        {
          write: (text) => output.push(text),
          writeError: (text) => output.push(`ERROR:${text}`),
        },
        deps,
      ),
    ).resolves.toBe(1);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("routes the existing CLI architecture without initializing doctor credentials", async () => {
    const output: string[] = [];
    const plan = createReleaseDryRunPlan(requestOf("open_edit"));
    const code = await runCli(
      ["releases", "--dry-run", "releases.open_edit"],
      {} as never,
      {
        log: (text) => output.push(text),
        error: (text) => output.push(`ERROR:${text}`),
      },
      undefined,
      {
        io: {
          write: (text) => output.push(text),
          writeError: (text) => output.push(`ERROR:${text}`),
        },
        dryRun: { createPlan: async () => plan },
      },
    );
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("NO API CALLS WERE EXECUTED.");
  });
});

describe("Phase 4.14 real/fake conformance", () => {
  it("matches the real Phase 4.12 rollout gateway sequence against the pure plan", async () => {
    const intent = createReleaseRolloutIntent({
      packageName,
      targetTrack,
      versionCode,
      releaseName,
      currentTrackState: trackState(targetRelease({ countryTargeting: undefined })),
      newFraction: 0.25,
    });
    const plan = createReleaseDryRunPlan({ kind: "update_rollout_fraction", intent });
    const fake = rolloutFakeGateway();
    const audit = auditLedger();
    const store = memoryStore();

    // The pure plan is compared to the production tool's gateway calls below;
    // no Google client or network is involved.
    const { createReleaseRolloutTool } = await import("../src/releases/rollout-tool.js");
    const tool = createReleaseRolloutTool({
      packageName,
      intent,
      gateway: fake.gateway,
      sessionStore: store,
      cleanupJournal: {
        list: async () => [],
        record: async () => undefined,
        remove: async () => undefined,
      },
      auditLedger: audit,
      now: () => new Date("2026-09-30T08:00:00.000Z"),
    });
    await tool.tool.execute({}, {});
    expect(fake.events).toEqual(plan.apiCalls.map((call) => call.operation));
  });
});

describe("Phase 4.15 cleanup dry-run coverage", () => {
  it("includes the cleanup capability in the mutating tool set", () => {
    expect(MUTATING_RELEASE_TOOL_NAMES).toContain("releases.cleanup_known_edit");
  });

  it("plans a fresh state check, one conditional retry-disabled delete, a post-delete get, and contextual verification", () => {
    const request = {
      kind: "cleanup_known_edit",
      packageName,
      candidate: {
        recordSource: "managed_session",
        editId: "managed-edit-1",
        expiryTimeSeconds,
      },
    } satisfies ReleaseDryRunRequest;
    const plan = createReleaseDryRunPlan(request);
    expect(plan.toolName).toBe("releases.cleanup_known_edit");
    expect(plan.realPermission).toBe("destructive");
    expect(plan.approvalRequiredForRealRun).toBe(true);
    expect(plan.executionEvidence).toMatchObject({
      apiCalls: 0,
      networkCalls: 0,
      approvalRequests: 0,
      approvalTokensConsumed: 0,
      sessionSaves: 0,
      sessionClears: 0,
      auditWrites: 0,
    });
    const deleteCall = plan.apiCalls.find((call) => call.operation === "edits.delete");
    expect(deleteCall?.mutation).toBe(true);
    expect(deleteCall?.retryPolicy).toBe("retry:false");
    expect(String(deleteCall?.condition)).toContain("exactly ONE attempt with retries disabled");
    expect(plan.apiCalls.filter((call) => call.operation === "edits.get")).toHaveLength(2);
    expect(plan.apiCalls.filter((call) => call.operation === "edits.delete")).toHaveLength(1);
    expect(plan.remotePreconditions.join(" ")).toContain("complete confirmed-delete context");
    expect(
      plan.localActions.some((action) => action.condition === "now >= expiryTimeSeconds"),
    ).toBe(true);
    expect(
      plan.localActions.some(
        (action) =>
          action.condition === "complete confirmed-delete context" &&
          action.action.includes("verified inactive"),
      ),
    ).toBe(true);
    expect(
      plan.localActions.some((action) => action.condition === "verified post-delete inactivity"),
    ).toBe(true);
    const rendered = renderReleaseDryRunPlan(plan);
    expect(rendered).not.toContain("managed-edit-1");
    expect(rendered).not.toContain(expiryTimeSeconds);
  });
});
