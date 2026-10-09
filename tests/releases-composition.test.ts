import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  type PlayOpsConfig,
  type ServiceAccountCredentials,
} from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { ANDROID_PUBLISHER_SCOPE, type GoogleAuthClient } from "../src/googleplay/auth/index.js";
import { RELEASES_VALIDATE_EDIT_TOOL_NAME } from "../src/releases/validate-edit-tool.js";
import {
  createReleaseCommitIntent,
  RELEASES_COMMIT_EDIT_TOOL_NAME,
} from "../src/releases/commit-approval.js";
import {
  createLiveReleaseComposition,
  createReleaseComposition,
  type ReleaseCompositionOptions,
} from "../src/releases/composition.js";
import {
  RELEASE_CAPABILITY_MATURITY,
  ReleaseCapabilityBlockedError,
  type ReleaseCapabilityToolName,
} from "../src/releases/capability-maturity.js";
import { createReleaseRolloutIntent } from "../src/releases/rollout-approval.js";
import {
  createHaltRolloutIntent,
  createResumeRolloutIntent,
} from "../src/releases/status-control-approval.js";
import { RELEASES_OPEN_EDIT_TOOL_NAME } from "../src/releases/open-tool.js";
import { RELEASES_INSPECT_TOOL_NAME } from "../src/releases/tool.js";
import { createReleaseDryRunPlan, MUTATING_RELEASE_TOOL_NAMES } from "../src/releases/dry-run.js";
import { createReleaseRolloutTool } from "../src/releases/rollout-tool.js";
import { createReleaseStatusControlTool } from "../src/releases/status-control-tool.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import * as releaseGateway from "../src/releases/androidpublisher.js";
import * as releaseSessionStore from "../src/releases/session-store.js";
import * as agentRuntime from "../src/runtime/agent/index.js";
import type { ReleaseVerificationEvidenceEvent } from "../src/releases/verification-evidence.js";

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function configWithAuditPath(logPath: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: {
      packageName: "com.example.release",
      serviceAccountJson: "FAKE-CREDENTIAL-PATH",
    },
    audit: { logPath },
    release: {
      editSessionPath: join(dirname(logPath), "edit-session.json"),
      editCleanupJournalPath: join(dirname(logPath), "edit-cleanup-journal.json"),
      commitAttemptJournalPath: join(dirname(logPath), "commit-attempt-journal.json"),
    },
  };
}

const credentials: ServiceAccountCredentials = {
  type: "service_account",
  clientEmail: "fake@example.invalid",
  privateKey: "FAKE-PRIVATE-KEY",
  tokenUri: "https://oauth.example.invalid/token",
  sourcePath: "/fake/credentials.json",
};
const auth: GoogleAuthClient = {
  getAccessToken: async () => ({ token: "FAKE-ACCESS-TOKEN" }),
};
const publisher = { version: "v3", reviews: {}, edits: {} } as unknown as AndroidPublisherClient;

const rolloutInput = {
  packageName: "com.example.release",
  targetTrack: "production",
  versionCode: "42",
  releaseName: "PRIVATE-RELEASE-NAME",
  currentTrackState: {
    track: "production",
    releases: [
      {
        name: "PRIVATE-RELEASE-NAME",
        status: "inProgress" as const,
        versionCodes: ["42"],
        userFraction: 0.1,
        releaseNotes: [{ language: "en-US", text: "PRIVATE-RELEASE-NOTE" }],
      },
    ],
  },
};
const commitIntent = createReleaseCommitIntent({
  packageName: rolloutInput.packageName,
  editId: "PRIVATE-EDIT-ID",
  targetTrack: rolloutInput.targetTrack,
  versionCode: rolloutInput.versionCode,
  targetTrackState: rolloutInput.currentTrackState,
  validatedEdit: { valid: true, expiryTimeSeconds: "4102444800" },
});
const rolloutIntent = createReleaseRolloutIntent({ ...rolloutInput, newFraction: 0.2 });
const haltIntent = createHaltRolloutIntent(rolloutInput);
const resumeIntent = createResumeRolloutIntent({
  ...rolloutInput,
  currentTrackState: {
    ...rolloutInput.currentTrackState,
    releases: rolloutInput.currentTrackState.releases.map((release) => ({
      ...release,
      status: "halted" as const,
    })),
  },
});
const blockedRequests = [
  {
    toolName: "releases.update_rollout_fraction",
    options: { updateRolloutFraction: { intent: rolloutIntent } },
  },
  { toolName: "releases.halt_rollout", options: { haltRollout: { intent: haltIntent } } },
  { toolName: "releases.resume_rollout", options: { resumeRollout: { intent: resumeIntent } } },
] as const satisfies readonly {
  readonly toolName: ReleaseCapabilityToolName;
  readonly options: ReleaseCompositionOptions;
}[];

function gateConfig(): PlayOpsConfig {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-release-gate-"));
  return configWithAuditPath(join(tempDir, "audit.jsonl"));
}

describe("release composition root", () => {
  it("passes the trusted optional verification evidence sink without writing a commit journal or exposing it as tool input", async () => {
    const config = gateConfig();
    const fixedNow = new Date("2026-10-08T05:00:00.000Z");
    const events: ReleaseVerificationEvidenceEvent[] = [];
    const sink = {
      record: vi.fn(async (event: ReleaseVerificationEvidenceEvent) => {
        events.push(event);
      }),
    };
    const fake = {
      ...publisher,
      applications: {
        tracks: {
          releases: {
            list: vi.fn(async () => ({
              data: {
                releases: [
                  {
                    releaseName: commitIntent.releaseName,
                    track: commitIntent.targetTrack,
                    releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
                    activeArtifacts: [{ versionCode: 42 }],
                  },
                ],
              },
            })),
          },
        },
      },
      edits: {
        insert: vi.fn(async () => ({
          data: { id: "composition-temp-3e2a", expiryTimeSeconds: "4102444800" },
        })),
        delete: vi.fn(async () => ({ data: {} })),
        tracks: { get: vi.fn(async () => ({ data: rolloutInput.currentTrackState })) },
      },
    };
    const composition = createReleaseComposition(
      config,
      { publisher: fake as unknown as AndroidPublisherClient, now: () => fixedNow },
      {
        verifyCommittedRelease: {
          targetTrack: commitIntent.targetTrack,
          versionCode: commitIntent.versionCode,
          expectedReleaseName: commitIntent.releaseName,
          expectedStateDigest: commitIntent.stateDigest,
        },
        verificationEvidenceSink: sink,
      },
    );
    const result = await composition.verifyCommittedReleaseTool?.execute({}, {});
    expect(events.map((event) => event.type)).toEqual([
      "verification_insert_attempted",
      "verification_edit_identified",
      "verification_state_observed",
      "verification_pre_delete_read_verified",
      "verification_delete_attempted",
      "verification_delete_acknowledged",
      "verification_cleanup_verified",
    ]);
    expect(events[1]).toEqual({
      type: "verification_edit_identified",
      editId: "composition-temp-3e2a",
      expiryTimeSeconds: "4102444800",
    });
    expect(events[2]).toEqual({
      type: "verification_state_observed",
      observedStateDigest: commitIntent.stateDigest,
      observedAtUtc: fixedNow.toISOString(),
    });
    expect(result?.verificationCleanupVerified).toBe(true);
    expect(fake.edits.insert).toHaveBeenCalledTimes(1);
    expect(fake.edits.delete).toHaveBeenCalledTimes(1);
    expect(composition.verifyCommittedReleaseBinding?.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(existsSync(config.release.commitAttemptJournalPath ?? "")).toBe(false);
  });

  it("loads credentials, auth, and the existing Publisher client exactly once", async () => {
    tempDir = mkdtempSync(
      join(process.env.TMPDIR ?? process.cwd(), "playops-release-composition-"),
    );
    const config = configWithAuditPath(join(tempDir, "audit.jsonl"));
    const loadConfig = vi.fn(() => config);
    const loadCredentials = vi.fn((_config: PlayOpsConfig) => credentials);
    const authenticate = vi.fn(
      (_credentials: ServiceAccountCredentials, scopes: readonly string[]) => {
        expect(scopes).toEqual([ANDROID_PUBLISHER_SCOPE]);
        return auth;
      },
    );
    const createPublisher = vi.fn((_auth: GoogleAuthClient) => publisher);

    const composition = await createLiveReleaseComposition({
      loadConfig,
      loadCredentials,
      authenticate,
      createPublisher,
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(loadCredentials).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(createPublisher).toHaveBeenCalledTimes(1);
    expect(createPublisher).toHaveBeenCalledWith(auth);
    expect(composition.packageName).toBe("com.example.release");
    expect(composition.registry.get(RELEASES_INSPECT_TOOL_NAME).permission).toBe("read");
    expect(composition.inspectBinding.toolName).toBe(RELEASES_INSPECT_TOOL_NAME);
    expect(composition.openBinding.toolName).toBe(RELEASES_OPEN_EDIT_TOOL_NAME);
    expect(composition.registry.get(RELEASES_OPEN_EDIT_TOOL_NAME).permission).toBe("destructive");
    expect(composition.registry.get(RELEASES_INSPECT_TOOL_NAME).verify).toBeUndefined();
    expect(composition.registry.get(RELEASES_OPEN_EDIT_TOOL_NAME).verify).toBeTypeOf("function");
    expect(composition.registry.get(RELEASES_VALIDATE_EDIT_TOOL_NAME).permission).toBe("read");
    expect(composition.registry.get(RELEASES_VALIDATE_EDIT_TOOL_NAME).verify).toBeUndefined();
    expect(composition.validateEditBinding.toolName).toBe(RELEASES_VALIDATE_EDIT_TOOL_NAME);
    expect(composition.registry.has(RELEASES_COMMIT_EDIT_TOOL_NAME)).toBe(false);
    // Phase 4.15: a configured cleanup-journal path adds the read-only hygiene tool.
    expect(composition.registry.has("releases.inspect_edit_hygiene")).toBe(true);
    expect(composition.registry.get("releases.inspect_edit_hygiene").permission).toBe("read");
    expect(composition.registry.list()).toHaveLength(4);
  });

  it("registers exactly one mode-bound reconciliation tool that fails closed without a journal path", () => {
    tempDir = mkdtempSync(
      join(process.env.TMPDIR ?? process.cwd(), "playops-reconcile-composition-"),
    );
    const config = configWithAuditPath(join(tempDir, "audit.jsonl"));
    const publisher = {
      version: "v3",
      reviews: {},
      edits: {},
    } as unknown as AndroidPublisherClient;
    const candidate = {
      version: 1 as const,
      attemptId: "22222222-2222-4222-8222-222222222222",
      packageName: "com.example.release",
      editId: "original-edit",
      expiryTimeSeconds: "1900000000",
      targetTrack: "internal",
      versionCode: "3",
      releaseName: "3 (1.1)",
      releaseStatus: "completed" as const,
      expectedStateDigest: "a".repeat(64),
      validationExpiryTimeSeconds: "1900000000",
      requestDigest: "c".repeat(64),
      state: "AMBIGUOUS" as const,
      attemptedAtUtc: "2026-10-05T10:00:00.000Z",
      updatedAtUtc: "2026-10-05T10:00:00.000Z",
    };
    const probe = createReleaseComposition(
      config,
      { publisher },
      { reconcileCommit: { candidate, mode: "probe" } },
    );
    expect(probe.reconcileCommitTool?.name).toBe("releases.reconcile_commit");
    expect(probe.reconcileCommitTool?.permission).toBe("read");
    expect(probe.reconcileCommitBinding?.approval).toBeUndefined();
    expect(probe.registry.get("releases.reconcile_commit").permission).toBe("read");
    const destructive = createReleaseComposition(
      config,
      { publisher },
      { reconcileCommit: { candidate, mode: "verify_expired" } },
    );
    expect(destructive.reconcileCommitTool?.permission).toBe("destructive");
    expect(destructive.reconcileCommitBinding?.approval?.createRequestDigest({})).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(destructive.registry.get("releases.reconcile_commit").verify).toBeTypeOf("function");
    const withoutJournal = {
      ...config,
      release: {
        editSessionPath: config.release.editSessionPath,
        editCleanupJournalPath: config.release.editCleanupJournalPath,
      },
    };
    expect(() =>
      createReleaseComposition(
        withoutJournal,
        { publisher },
        { reconcileCommit: { candidate, mode: "probe" } },
      ),
    ).toThrowError(
      expect.objectContaining({ name: "ReleaseCompositionError", code: "CONFIG_INVALID" }),
    );
    // Capability maturity is untouched by reconciliation: blocked capabilities stay blocked.
    expect(() =>
      createReleaseComposition(config, { publisher }, { haltRollout: { intent: {} as never } }),
    ).toThrowError(expect.objectContaining({ code: "RELEASE_CAPABILITY_NOT_HARDENED" }));
  });

  it("fails invalid package config before credentials, auth, or client construction", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      googlePlay: { packageName: "", serviceAccountJson: "FAKE-CREDENTIAL-PATH" },
      audit: { logPath: "fake-audit.jsonl" },
    } satisfies PlayOpsConfig;
    const loadCredentials = vi.fn(() => credentials);
    const authenticate = vi.fn(() => auth);
    const createPublisher = vi.fn(() => publisher);

    await expect(
      createLiveReleaseComposition({
        loadConfig: () => config,
        loadCredentials,
        authenticate,
        createPublisher,
      }),
    ).rejects.toMatchObject({ name: "ReleaseCompositionError", code: "CONFIG_INVALID" });
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(createPublisher).not.toHaveBeenCalled();
  });
  it.each(blockedRequests)(
    "rejects direct shared composition for $toolName even with a fake Publisher",
    ({ toolName, options }) => {
      const config = gateConfig();
      expect(() => createReleaseComposition(config, { publisher }, options)).toThrow(
        ReleaseCapabilityBlockedError,
      );
      expect(() => createReleaseComposition(config, { publisher }, options)).toThrow(
        expect.objectContaining({
          code: "RELEASE_CAPABILITY_NOT_HARDENED",
          toolName,
          externalStateUncertain: false,
        }),
      );
    },
  );

  it.each(blockedRequests)(
    "preflights $toolName before every live credential/auth/Publisher factory",
    async ({ toolName, options }) => {
      const config = gateConfig();
      const events: string[] = [];
      const loadConfig = vi.fn(() => {
        events.push("loadConfig");
        return config;
      });
      const loadCredentials = vi.fn(() => {
        events.push("loadCredentials");
        return credentials;
      });
      const authenticate = vi.fn(() => {
        events.push("authenticate");
        return auth;
      });
      const createPublisher = vi.fn(() => {
        events.push("createPublisher");
        return publisher;
      });
      await expect(
        createLiveReleaseComposition(
          { loadConfig, loadCredentials, authenticate, createPublisher },
          options,
        ),
      ).rejects.toMatchObject({
        name: "ReleaseCapabilityBlockedError",
        code: "RELEASE_CAPABILITY_NOT_HARDENED",
        toolName,
        externalStateUncertain: false,
      });
      expect(events).toEqual(["loadConfig"]);
      expect(loadConfig).toHaveBeenCalledTimes(1);
      expect(loadCredentials).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
      expect(createPublisher).not.toHaveBeenCalled();
    },
  );

  it.each(blockedRequests)(
    "blocks $toolName before gateway, store, or ledger construction",
    ({ options }) => {
      const config = gateConfig();
      const createGateway = vi.spyOn(releaseGateway, "createAndroidPublisherReleaseGateway");
      const createStore = vi.spyOn(releaseSessionStore, "createFileReleaseEditSessionStore");
      const createLedger = vi.spyOn(agentRuntime, "createFileAgentLedger");
      expect(() => createReleaseComposition(config, { publisher }, options)).toThrow(
        ReleaseCapabilityBlockedError,
      );
      expect(createGateway).not.toHaveBeenCalled();
      expect(createStore).not.toHaveBeenCalled();
      expect(createLedger).not.toHaveBeenCalled();
    },
  );

  it.each(blockedRequests)(
    "does not let missing cleanup-journal configuration mask $toolName",
    async ({ toolName, options }) => {
      const base = gateConfig();
      const config: PlayOpsConfig = {
        ...base,
        release: { editSessionPath: base.release.editSessionPath, editCleanupJournalPath: "" },
      };
      // A second journal-backed request must not replace the maturity error.
      const requested = {
        ...options,
        verifyCommittedRelease: {
          targetTrack: commitIntent.targetTrack,
          versionCode: commitIntent.versionCode,
          expectedReleaseName: commitIntent.releaseName,
          expectedStateDigest: commitIntent.stateDigest,
        },
      };
      expect(() => createReleaseComposition(config, { publisher }, requested)).toThrow(
        expect.objectContaining({ code: "RELEASE_CAPABILITY_NOT_HARDENED", toolName }),
      );
      const loadCredentials = vi.fn(() => credentials);
      const authenticate = vi.fn(() => auth);
      const createPublisher = vi.fn(() => publisher);
      await expect(
        createLiveReleaseComposition(
          { loadConfig: () => config, loadCredentials, authenticate, createPublisher },
          requested,
        ),
      ).rejects.toMatchObject({ code: "RELEASE_CAPABILITY_NOT_HARDENED", toolName });
      expect(loadCredentials).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
      expect(createPublisher).not.toHaveBeenCalled();
    },
  );

  it.each(blockedRequests)(
    "does not let valid approval or caller-supplied policy allow $toolName",
    ({ toolName, options }) => {
      const config = gateConfig();
      const base = createReleaseComposition(config, { publisher });
      const cleanupJournal = base.cleanupJournal;
      if (!cleanupJournal) throw new Error("test cleanup journal unavailable");
      const dependencies = {
        packageName: base.packageName,
        gateway: base.gateway,
        sessionStore: base.store,
        cleanupJournal,
        auditLedger: base.ledger,
      };
      // Test-only low-level fake tool: valid approval in the unchanged permission
      // engine must never make production composition accept an immature capability.
      const registry = new ToolRegistry();
      if (toolName === "releases.update_rollout_fraction") {
        registry.register(
          createReleaseRolloutTool({ ...dependencies, intent: rolloutIntent }).tool,
        );
      } else {
        registry.register(
          createReleaseStatusControlTool({
            ...dependencies,
            intent: toolName === "releases.halt_rollout" ? haltIntent : resumeIntent,
          }).tool,
        );
      }
      const approval = { toolName, permission: "destructive", decision: "approved" } as const;
      expect(evaluateToolPermission(registry.get(toolName), approval)).toMatchObject({
        allowed: true,
        code: "ALLOWED",
      });
      const transitionPolicy = Object.freeze({
        ...RELEASE_CAPABILITY_MATURITY,
        [toolName]: "LIVE_ALLOWED" as const,
      });
      vi.stubEnv("PLAYOPS_ALLOW_NOT_HARDENED_RELEASE_CAPABILITIES", "true");
      const injectedConfig = {
        ...config,
        capabilityMaturity: transitionPolicy,
        allowLiveBlockedCapabilities: true,
      };
      const injectedOptions = {
        ...options,
        approval,
        capabilityMaturity: transitionPolicy,
        allowLiveBlockedCapabilities: true,
        modelContext: { liveAllowed: true },
      };
      const injectedDependencies = { publisher, capabilityMaturity: transitionPolicy };
      expect(() =>
        createReleaseComposition(injectedConfig, injectedDependencies, injectedOptions),
      ).toThrow(ReleaseCapabilityBlockedError);
      expect(RELEASE_CAPABILITY_MATURITY[toolName]).toBe("LIVE_BLOCKED_NOT_HARDENED");
    },
  );

  it("validates configuration before the live maturity gate", async () => {
    const base = gateConfig();
    const config = { ...base, googlePlay: { ...base.googlePlay, packageName: "" } };
    const loadCredentials = vi.fn(() => credentials);
    const authenticate = vi.fn(() => auth);
    const createPublisher = vi.fn(() => publisher);
    await expect(
      createLiveReleaseComposition(
        { loadConfig: () => config, loadCredentials, authenticate, createPublisher },
        { haltRollout: { intent: haltIntent } },
      ),
    ).rejects.toMatchObject({ name: "ReleaseCompositionError", code: "CONFIG_INVALID" });
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(createPublisher).not.toHaveBeenCalled();
  });

  it.each(blockedRequests)(
    "does not expose secret operation/configuration input when blocking $toolName",
    async ({ toolName, options }) => {
      const base = gateConfig();
      const config = {
        ...base,
        googlePlay: { ...base.googlePlay, serviceAccountJson: "/private/SECRET-CREDENTIAL.json" },
      };
      const failure: unknown = await createLiveReleaseComposition(
        {
          loadConfig: () => config,
          loadCredentials: () => {
            throw new Error("SECRET-PRIVATE-KEY SECRET-ACCESS-TOKEN");
          },
        },
        options,
      ).then(
        () => {
          throw new Error("blocked composition unexpectedly succeeded");
        },
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(ReleaseCapabilityBlockedError);
      expect(failure).toMatchObject({ toolName, externalStateUncertain: false });
      expect(failure).not.toHaveProperty("cause");
      const diagnostic = String(failure) + JSON.stringify(failure);
      for (const secret of [
        "SECRET-CREDENTIAL",
        "SECRET-PRIVATE-KEY",
        "SECRET-ACCESS-TOKEN",
        "PRIVATE-RELEASE-NAME",
        "PRIVATE-RELEASE-NOTE",
        "PRIVATE-EDIT-ID",
        base.audit.logPath,
        base.release.editSessionPath,
      ]) {
        expect(diagnostic).not.toContain(secret);
      }
    },
  );

  it.each(blockedRequests)(
    "keeps $toolName available to pure offline dry-run planning",
    ({ toolName }) => {
      const request =
        toolName === "releases.update_rollout_fraction"
          ? ({ kind: "update_rollout_fraction", intent: rolloutIntent } as const)
          : toolName === "releases.halt_rollout"
            ? ({ kind: "halt_rollout", intent: haltIntent } as const)
            : ({ kind: "resume_rollout", intent: resumeIntent } as const);
      const plan = createReleaseDryRunPlan(request);
      expect(MUTATING_RELEASE_TOOL_NAMES).toContain(toolName);
      expect(plan).toMatchObject({
        toolName,
        realPermission: "destructive",
        approvalRequiredForRealRun: true,
        sideEffectsExecuted: false,
        executionEvidence: {
          apiCalls: 0,
          networkCalls: 0,
          browserCalls: 0,
          approvalRequests: 0,
          approvalTokensConsumed: 0,
          sessionSaves: 0,
          sessionClears: 0,
          auditWrites: 0,
        },
      });
      expect(plan.apiCalls.some((call) => call.operation === "edits.commit")).toBe(true);
    },
  );

  it("composes every other release capability and keeps the existing verification guard", () => {
    const config = gateConfig();
    const uploadedBundle = { versionCode: "42", sha256: "a".repeat(64) };
    const composition = createReleaseComposition(
      config,
      { publisher },
      {
        bundleUpload: { artifactPath: "/private/operator/fake.aab" },
        versionCodeVerification: { targetTrack: "production", uploadedBundle },
        targetTrackInspection: { targetTrack: "production" },
        configureRelease: {
          targetTrack: "production",
          releaseName: "PRIVATE-RELEASE-NAME",
          releaseStatus: "inProgress",
          initialRolloutFraction: 0.1,
          uploadedBundle,
        },
        attachReleaseNotes: {
          targetTrack: "production",
          configuredRelease: {
            targetTrack: "production",
            releaseName: "PRIVATE-RELEASE-NAME",
            status: "inProgress",
            versionCodes: ["42"],
            userFraction: 0.1,
          },
          uploadedBundle,
          localizedReleaseNotes: [{ language: "en-US", text: "PRIVATE-RELEASE-NOTE" }],
        },
        commitEdit: { intent: commitIntent },
        inspectCommittedRelease: { intent: commitIntent },
        verifyCommittedRelease: {
          targetTrack: commitIntent.targetTrack,
          versionCode: commitIntent.versionCode,
          expectedReleaseName: commitIntent.releaseName,
          expectedStateDigest: commitIntent.stateDigest,
        },
        cleanupKnownEdit: {
          candidate: {
            recordSource: "managed_session",
            editId: "PRIVATE-EDIT-ID",
            expiryTimeSeconds: "4102444800",
          },
        },
      },
    );
    expect(composition.registry.list().map((tool) => tool.name)).toEqual([
      "releases.open_edit",
      "releases.inspect",
      "releases.upload_bundle",
      "releases.verify_version_code",
      "releases.inspect_target_track",
      "releases.configure_release",
      "releases.attach_release_notes",
      "releases.validate_edit",
      "releases.commit_edit",
      "releases.inspect_committed_release",
      "releases.verify_committed_release",
      "releases.inspect_edit_hygiene",
      "releases.cleanup_known_edit",
    ]);
    const noJournal = {
      ...config,
      release: { editSessionPath: config.release.editSessionPath, editCleanupJournalPath: "" },
    };
    expect(() =>
      createReleaseComposition(
        noJournal,
        { publisher },
        {
          verifyCommittedRelease: {
            targetTrack: commitIntent.targetTrack,
            versionCode: commitIntent.versionCode,
            expectedReleaseName: commitIntent.releaseName,
            expectedStateDigest: commitIntent.stateDigest,
          },
        },
      ),
    ).toThrow(expect.objectContaining({ name: "ReleaseCompositionError", code: "CONFIG_INVALID" }));
    for (const { toolName } of blockedRequests) {
      expect(composition.registry.has(toolName)).toBe(false);
    }
  });

  it("preserves a capability error thrown by either live-wrapper catch boundary", async () => {
    const config = gateConfig();
    const blocked = new ReleaseCapabilityBlockedError("releases.halt_rollout");
    await expect(
      createLiveReleaseComposition({
        loadConfig: () => {
          throw blocked;
        },
      }),
    ).rejects.toBe(blocked);
    await expect(
      createLiveReleaseComposition({
        loadConfig: () => config,
        loadCredentials: () => {
          throw blocked;
        },
      }),
    ).rejects.toBe(blocked);
  });
});
