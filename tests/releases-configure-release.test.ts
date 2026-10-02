import { describe, expect, it, vi } from "vitest";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import {
  createReleaseConfigureReleaseTool,
  RELEASES_CONFIGURE_RELEASE_TOOL_NAME,
  type ReleaseConfigureReleaseToolOptions,
} from "../src/releases/configure-release-tool.js";
import type { ReleaseConfigurationGateway, ReleaseEditReadback } from "../src/releases/gateway.js";
import type {
  ReleaseBundle,
  ReleaseEditSession,
  ReleaseTrackState,
  ReleaseTrackUpdateRequest,
} from "../src/releases/index.js";

const packageName = "com.example.release";
const targetTrack = "production";
const editId = "edit-phase46";
const expiryTimeSeconds = "1900000000";
const uploadedBundle: ReleaseBundle = Object.freeze({
  versionCode: "101",
  sha256: "a".repeat(64),
});

function trackedSession(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function memoryStore(session: ReleaseEditSession | undefined): ReleaseEditSessionStore {
  return {
    load: vi.fn(async () => session),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
}

interface GatewayFixture {
  readonly gateway: ReleaseConfigurationGateway;
  readonly state: {
    track: ReleaseTrackState;
    readonly updateCalls: ReleaseTrackUpdateRequest[];
    readonly getTrackCalls: string[];
  };
}

function makeGateway(
  options: {
    readonly track?: ReleaseTrackState;
    readonly updateResponse?: unknown;
    readonly updateError?: unknown;
    readonly bundles?: readonly ReleaseBundle[];
    readonly edit?: ReleaseEditReadback;
  } = {},
): GatewayFixture {
  const state = {
    track: options.track ?? { track: targetTrack, releases: [] },
    updateCalls: [] as ReleaseTrackUpdateRequest[],
    getTrackCalls: [] as string[],
  };
  const gateway: ReleaseConfigurationGateway = {
    getEdit: vi.fn(async () => options.edit ?? { id: editId, expiryTimeSeconds }),
    listBundles: vi.fn(async () => options.bundles ?? [uploadedBundle]),
    getTrack: vi.fn(async (_session, requestedTrack) => {
      state.getTrackCalls.push(requestedTrack);
      return state.track;
    }),
    updateTrack: vi.fn(
      async (_session, requestedTrack: string, request: ReleaseTrackUpdateRequest) => {
        state.updateCalls.push(request);
        if (options.updateError !== undefined) throw options.updateError;
        if (options.updateResponse !== undefined)
          return options.updateResponse as ReleaseTrackState;
        state.track = {
          track: requestedTrack,
          releases: request.releases.map((release) => ({
            name: release.name,
            status: release.status,
            versionCodes: [...release.versionCodes],
            ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
          })),
        };
        return state.track;
      },
    ),
  };
  return { gateway, state };
}

function makeOptions(
  overrides: Partial<ReleaseConfigureReleaseToolOptions> = {},
): ReleaseConfigureReleaseToolOptions {
  const { gateway, state } = makeGateway();
  void state;
  return {
    packageName,
    targetTrack,
    releaseName: "Candidate 101",
    releaseStatus: "draft",
    uploadedBundle,
    sessionStore: memoryStore(trackedSession()),
    gateway,
    now: () => new Date("2026-09-29T04:00:00.000Z"),
    ...overrides,
  };
}

async function executeWith(options: ReleaseConfigureReleaseToolOptions) {
  const composed = createReleaseConfigureReleaseTool(options);
  const output = await composed.tool.execute({}, Object.freeze({}));
  return { composed, output };
}

describe("Phase 4.6 release configuration contract", () => {
  it("uses the required tool name, write permission, empty input, and verifier", () => {
    const composed = createReleaseConfigureReleaseTool(makeOptions());

    expect(composed.tool.name).toBe(RELEASES_CONFIGURE_RELEASE_TOOL_NAME);
    expect(composed.tool.permission).toBe("write");
    expect(composed.tool.verify).toBeTypeOf("function");
    expect(composed.binding.toolName).toBe(RELEASES_CONFIGURE_RELEASE_TOOL_NAME);
    expect(composed.binding.approval).toBeUndefined();
    expect(composed.binding.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(() => composed.tool.inputSchema.parse({ releaseName: "model override" })).toThrow(
      "Release configuration input is invalid.",
    );
  });

  it.each([
    { releaseStatus: "halted" },
    { releaseStatus: "statusUnspecified" },
    { releaseStatus: "unknown" },
  ])("rejects unsupported status $releaseStatus", ({ releaseStatus }) => {
    expect(() =>
      createReleaseConfigureReleaseTool(makeOptions({ releaseStatus: releaseStatus as never })),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELEASE_CONFIGURATION" }));
  });

  it.each([
    { releaseStatus: "draft" as const, initialRolloutFraction: 0.05 },
    { releaseStatus: "completed" as const, initialRolloutFraction: 0.05 },
    { releaseStatus: "draft" as const, initialRolloutFraction: 0 },
    { releaseStatus: "completed" as const, initialRolloutFraction: 1 },
    { releaseStatus: "inProgress" as const, initialRolloutFraction: undefined },
    { releaseStatus: "inProgress" as const, initialRolloutFraction: 0 },
    { releaseStatus: "inProgress" as const, initialRolloutFraction: 1 },
    { releaseStatus: "inProgress" as const, initialRolloutFraction: -0.1 },
    { releaseStatus: "inProgress" as const, initialRolloutFraction: 1.1 },
    { releaseStatus: "inProgress" as const, initialRolloutFraction: Number.NaN },
    { releaseStatus: "inProgress" as const, initialRolloutFraction: Number.POSITIVE_INFINITY },
  ])("rejects invalid fraction intent %j", (intent) => {
    expect(() => createReleaseConfigureReleaseTool(makeOptions(intent))).toThrowError(
      expect.objectContaining({ code: "INVALID_RELEASE_CONFIGURATION" }),
    );
  });

  it.each([{ releaseStatus: "draft" as const }, { releaseStatus: "completed" as const }])(
    "accepts $releaseStatus without a fraction and omits it from the request",
    async (intent) => {
      const fixture = makeGateway({ track: { track: targetTrack, releases: [] } });
      const { composed, output } = await executeWith(
        makeOptions({ ...intent, gateway: fixture.gateway }),
      );

      expect(output).toEqual({
        targetTrack,
        releaseName: "Candidate 101",
        status: intent.releaseStatus,
        versionCodes: ["101"],
      });
      expect(fixture.state.updateCalls).toEqual([
        {
          track: targetTrack,
          releases: [
            { name: "Candidate 101", versionCodes: ["101"], status: intent.releaseStatus },
          ],
        },
      ]);
      expect(composed.tool.verify).toBeTypeOf("function");
    },
  );

  it.each([0.05, 0.5])(
    "accepts inProgress fraction %s and preserves it exactly",
    async (fraction) => {
      const fixture = makeGateway({
        track: { track: targetTrack, releases: [{ status: "completed", versionCodes: ["100"] }] },
      });
      const { output } = await executeWith(
        makeOptions({
          releaseStatus: "inProgress",
          initialRolloutFraction: fraction,
          gateway: fixture.gateway,
        }),
      );

      expect(output).toEqual({
        targetTrack,
        releaseName: "Candidate 101",
        status: "inProgress",
        versionCodes: ["101"],
        userFraction: fraction,
      });
      expect(fixture.state.updateCalls[0]).toEqual({
        track: targetTrack,
        releases: [
          {
            name: "Candidate 101",
            versionCodes: ["101"],
            status: "inProgress",
            userFraction: fraction,
          },
        ],
      });
    },
  );

  it("trims a valid release name and rejects blank names", async () => {
    const fixture = makeGateway();
    const { output } = await executeWith(
      makeOptions({ releaseName: "  Candidate 101  ", gateway: fixture.gateway }),
    );
    expect(output.releaseName).toBe("Candidate 101");
    expect(fixture.state.updateCalls[0]?.releases[0]?.name).toBe("Candidate 101");

    expect(() =>
      createReleaseConfigureReleaseTool(makeOptions({ releaseName: "   " })),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELEASE_CONFIGURATION" }));
  });

  it.each([
    { label: "no session", session: undefined },
    {
      label: "expired session",
      session: trackedSession({ expiryTimeSeconds: "1" }),
    },
    {
      label: "package mismatch",
      session: trackedSession({ packageName: "com.example.other" }),
    },
  ])("blocks before update when $label", async ({ session }) => {
    const fixture = makeGateway();
    const composed = createReleaseConfigureReleaseTool(
      makeOptions({ sessionStore: memoryStore(session), gateway: fixture.gateway }),
    );

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: expect.stringMatching(
        /EDIT_SESSION_REQUIRED|EDIT_SESSION_EXPIRED|EDIT_SESSION_PACKAGE_MISMATCH|EDIT_SESSION_STORE_INVALID/,
      ),
    });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it("blocks an invalid remote edit before update", async () => {
    const fixture = makeGateway({ edit: { id: "other-edit", expiryTimeSeconds } });
    const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
    });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it("requires the exact verified uploaded bundle identity before reading the target track", async () => {
    const fixture = makeGateway({ bundles: [{ versionCode: "101", sha256: "b".repeat(64) }] });
    const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "UPLOADED_BUNDLE_NOT_FOUND",
    });
    expect(fixture.state.getTrackCalls).toHaveLength(0);
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it("requires exact target-track identity", async () => {
    const fixture = makeGateway({ track: { track: "beta", releases: [] } });
    const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "TRACK_MISMATCH",
    });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it.each(["101", "102"])(
    "refreshes the strict version guard against current %s",
    async (current) => {
      const fixture = makeGateway({
        track: { track: targetTrack, releases: [{ status: "completed", versionCodes: [current] }] },
      });
      const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));

      await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
        code: "VERSION_CODE_NOT_GREATER",
      });
      expect(fixture.state.updateCalls).toHaveLength(0);
    },
  );

  it.each(["draft", "inProgress", "halted"] as const)(
    "blocks an outstanding %s release",
    async (status) => {
      const fixture = makeGateway({
        track: { track: targetTrack, releases: [{ status, versionCodes: ["100"] }] },
      });
      const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));

      await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
        code: "OUTSTANDING_RELEASE_EXISTS",
      });
      expect(fixture.state.updateCalls).toHaveLength(0);
    },
  );

  it("allows a track containing only completed releases", async () => {
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [{ status: "completed", versionCodes: ["100"] }] },
    });
    await executeWith(makeOptions({ gateway: fixture.gateway }));
    expect(fixture.state.updateCalls).toHaveLength(1);
  });

  it("blocks first-release inProgress instead of silently falling back to completed", async () => {
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [{ status: "statusUnspecified", versionCodes: [] }] },
    });
    const composed = createReleaseConfigureReleaseTool(
      makeOptions({
        releaseStatus: "inProgress",
        initialRolloutFraction: 0.05,
        gateway: fixture.gateway,
      }),
    );

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "STAGED_ROLLOUT_REQUIRES_EXISTING_RELEASE",
    });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it("includes only the uploaded code by default and retains only explicit existing codes", async () => {
    const fixture = makeGateway({
      track: {
        track: targetTrack,
        releases: [
          { status: "completed", versionCodes: ["99", "100"] },
          { status: "completed", versionCodes: ["98"] },
        ],
      },
    });
    await executeWith(
      makeOptions({
        gateway: fixture.gateway,
        retainVersionCodes: ["100", "99", "100"],
      }),
    );
    expect(fixture.state.updateCalls[0]?.releases[0]?.versionCodes).toEqual(["99", "100", "101"]);
  });

  it("rejects a retained version code that is not on the fresh target track", async () => {
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [{ status: "completed", versionCodes: ["100"] }] },
    });
    const composed = createReleaseConfigureReleaseTool(
      makeOptions({ gateway: fixture.gateway, retainVersionCodes: ["99"] }),
    );

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "INVALID_RELEASE_CONFIGURATION",
    });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it("performs exactly one update attempt and never retries an ambiguous failure", async () => {
    const failure = Object.assign(new Error("PRIVATE-TRANSPORT-MARKER"), { status: 503 });
    const fixture = makeGateway({ updateError: failure });
    const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "TRACK_UPDATE_FAILED",
      cause: failure,
    });
    expect(fixture.state.updateCalls).toHaveLength(1);
  });

  it("rejects a malformed update response as externally uncertain", async () => {
    const fixture = makeGateway({ updateResponse: { track: targetTrack, releases: "bad" } });
    const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "TRACK_UPDATE_RESPONSE_INVALID",
    });
    expect(fixture.state.updateCalls).toHaveLength(1);
  });

  it("verifies the configured release by a fresh exact target-track read-back", async () => {
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [{ status: "completed", versionCodes: ["100"] }] },
    });
    const composed = createReleaseConfigureReleaseTool(
      makeOptions({
        releaseStatus: "inProgress",
        initialRolloutFraction: 0.05,
        gateway: fixture.gateway,
      }),
    );
    const output = await composed.tool.execute({}, Object.freeze({}));
    expect(await composed.tool.verify?.({}, output, Object.freeze({}))).toBe(true);
    expect(fixture.state.getTrackCalls).toEqual([targetTrack, targetTrack]);
  });

  it.each([
    { label: "wrong name", release: { name: "Other", status: "draft", versionCodes: ["101"] } },
    {
      label: "wrong status",
      release: { name: "Candidate 101", status: "completed", versionCodes: ["101"] },
    },
    {
      label: "wrong version set",
      release: { name: "Candidate 101", status: "draft", versionCodes: ["101", "100"] },
    },
    {
      label: "draft fraction",
      release: { name: "Candidate 101", status: "draft", versionCodes: ["101"], userFraction: 0.5 },
    },
    {
      label: "missing staged fraction",
      release: { name: "Candidate 101", status: "inProgress", versionCodes: ["101"] },
    },
    {
      label: "wrong staged fraction",
      release: {
        name: "Candidate 101",
        status: "inProgress",
        versionCodes: ["101"],
        userFraction: 0.5,
      },
    },
    {
      label: "completed fraction",
      release: {
        name: "Candidate 101",
        status: "completed",
        versionCodes: ["101"],
        userFraction: 0.5,
      },
    },
  ])("verifier rejects $label", async ({ release }) => {
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [{ status: "completed", versionCodes: ["100"] }] },
    });
    const composed = createReleaseConfigureReleaseTool(makeOptions({ gateway: fixture.gateway }));
    const output = await composed.tool.execute({}, Object.freeze({}));
    fixture.state.track = { track: targetTrack, releases: [release as never] };
    expect(await composed.tool.verify?.({}, output, Object.freeze({}))).toBe(false);
  });

  it("serializes only the safe configuration result after VERIFIED", async () => {
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [{ status: "completed", versionCodes: ["100"] }] },
    });
    const composed = createReleaseConfigureReleaseTool(
      makeOptions({ releaseStatus: "completed", gateway: fixture.gateway }),
    );
    const output = await composed.tool.execute({}, Object.freeze({}));
    const serialized = composed.binding.serializeResult(output, {
      toolName: RELEASES_CONFIGURE_RELEASE_TOOL_NAME,
      permission: "write",
      required: true,
      status: "passed",
      code: "VERIFIED",
      verified: true,
    });
    expect(JSON.parse(serialized)).toEqual({
      targetTrack,
      releaseName: "Candidate 101",
      status: "completed",
      versionCodes: ["101"],
    });
    expect(serialized).not.toContain(editId);
    expect(serialized).not.toContain(uploadedBundle.sha256);
  });
});
