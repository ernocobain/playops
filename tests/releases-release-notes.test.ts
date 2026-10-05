import { describe, expect, it, vi } from "vitest";
import type { ReleaseConfigurationGateway, ReleaseEditReadback } from "../src/releases/gateway.js";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import {
  createReleaseNotesAttachmentTool,
  normalizeReleaseNotesIntent,
  RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME,
  RELEASE_NOTE_MAX_UNICODE_CODE_POINTS,
  type ReleaseNotesAttachmentToolOptions,
} from "../src/releases/release-notes-tool.js";
import type { ReleaseConfigurationResult } from "../src/releases/configure-release-tool.js";
import { normalizeReleaseTracks } from "../src/releases/index.js";
import type {
  ReleaseBundle,
  ReleaseEditSession,
  ReleaseState,
  ReleaseTrackState,
  ReleaseTrackUpdateRequest,
} from "../src/releases/index.js";

const packageName = "com.example.release";
const targetTrack = "production";
const editId = "edit-phase47";
const expiryTimeSeconds = "1900000000";
const uploadedBundle: ReleaseBundle = Object.freeze({ versionCode: "101", sha256: "a".repeat(64) });
const configuredRelease: ReleaseConfigurationResult = Object.freeze({
  targetTrack,
  releaseName: "Candidate 101",
  status: "inProgress",
  versionCodes: Object.freeze(["101"]),
  userFraction: 0.05,
});
const intendedNotes = Object.freeze([
  { language: "en-US", text: "Improved login reliability." },
  { language: "id", text: "Meningkatkan keandalan proses masuk." },
]);

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

function release(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "Candidate 101",
    status: "inProgress",
    versionCodes: ["101"],
    userFraction: 0.05,
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 5,
    ...overrides,
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

function requestToTrack(request: ReleaseTrackUpdateRequest): ReleaseTrackState {
  return {
    track: request.track,
    releases: request.releases.map((item) => ({
      ...(item.name !== undefined ? { name: item.name } : {}),
      status: item.status,
      versionCodes: [...item.versionCodes],
      ...(item.userFraction !== undefined ? { userFraction: item.userFraction } : {}),
      ...(item.releaseNotes !== undefined ? { releaseNotes: [...item.releaseNotes] } : {}),
      ...(item.countryTargeting !== undefined
        ? {
            countryTargeting: {
              countries: [...item.countryTargeting.countries],
              includeRestOfWorld: item.countryTargeting.includeRestOfWorld,
            },
          }
        : {}),
      ...(item.inAppUpdatePriority !== undefined
        ? { inAppUpdatePriority: item.inAppUpdatePriority }
        : {}),
    })),
  };
}

function makeGateway(
  options: {
    readonly track?: ReleaseTrackState;
    readonly bundles?: readonly ReleaseBundle[];
    readonly edit?: ReleaseEditReadback;
    readonly updateResponse?: unknown;
    readonly updateError?: unknown;
  } = {},
): GatewayFixture {
  const state = {
    track: options.track ?? { track: targetTrack, releases: [release()] },
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
    updateTrack: vi.fn(async (_session, requestedTrack, request) => {
      state.updateCalls.push(request);
      if (options.updateError !== undefined) throw options.updateError;
      if (options.updateResponse !== undefined) return options.updateResponse as ReleaseTrackState;
      state.track = requestToTrack({ ...request, track: requestedTrack });
      return state.track;
    }),
  };
  return { gateway, state };
}

function makeOptions(
  overrides: Partial<ReleaseNotesAttachmentToolOptions> = {},
): ReleaseNotesAttachmentToolOptions {
  const fixture = makeGateway();
  return {
    packageName,
    targetTrack,
    configuredRelease,
    uploadedBundle,
    localizedReleaseNotes: intendedNotes,
    sessionStore: memoryStore(trackedSession()),
    gateway: fixture.gateway,
    now: () => new Date("2026-09-29T04:00:00.000Z"),
    ...overrides,
  };
}

async function executeWith(options: ReleaseNotesAttachmentToolOptions) {
  const composed = createReleaseNotesAttachmentTool(options);
  const output = await composed.tool.execute({}, Object.freeze({}));
  return { composed, output };
}

describe("R6 protected normalized restoration snapshot conformance", () => {
  it("round-trips completed internal notes with id preserved and en-US absent again", async () => {
    const bundle: ReleaseBundle = { versionCode: "3", sha256: "a".repeat(64) };
    const identity: ReleaseConfigurationResult = {
      targetTrack: "internal",
      releaseName: "3 (1.1)",
      status: "completed",
      versionCodes: ["3"],
    };
    const [initial] = normalizeReleaseTracks([
      {
        track: "internal",
        releases: [
          { name: "Unrelated draft", status: "draft", versionCodes: [] },
          {
            name: "3 (1.1)",
            status: "completed",
            versionCodes: ["3"],
            releaseNotes: [{ language: "id", text: "  Catatan ID asli.  " }],
            countryTargeting: { countries: ["ID", "US"], includeRestOfWorld: false },
            inAppUpdatePriority: 5,
          },
        ],
      },
    ]);
    if (!initial) throw new Error("normalized snapshot unavailable");
    // In a future live probe this complete normalized snapshot belongs only in
    // private scratch0700/file0600, never in audit or the commit-attempt journal.
    const snapshot = structuredClone(initial);
    let current = initial;
    const updates: ReleaseTrackUpdateRequest[] = [];
    const gateway: ReleaseConfigurationGateway = {
      getEdit: async () => ({ id: editId, expiryTimeSeconds }),
      listBundles: async () => [bundle],
      getTrack: async (_session, trackName) => {
        expect(trackName).toBe("internal");
        return current;
      },
      updateTrack: async (_session, trackName, request) => {
        expect(trackName).toBe("internal");
        updates.push(request);
        current = requestToTrack(request);
        return current;
      },
    };
    const common = {
      packageName,
      targetTrack: "internal",
      configuredRelease: identity,
      uploadedBundle: bundle,
      sessionStore: memoryStore(trackedSession()),
      gateway,
      now: () => new Date("2026-10-05T10:00:00.000Z"),
    };
    const originalNotes = snapshot.releases.find((item) =>
      item.versionCodes.includes("3"),
    )?.releaseNotes;
    if (!originalNotes) throw new Error("private original notes missing");
    const temporary = createReleaseNotesAttachmentTool({
      ...common,
      localizedReleaseNotes: [
        ...originalNotes,
        { language: "en-US", text: "Offline R6 temporary marker." },
      ],
    });
    const attached = await temporary.tool.execute({}, {});
    expect(await temporary.tool.verify?.({}, attached, {})).toBe(true);
    expect(current.releases.find((item) => item.versionCodes.includes("3"))?.releaseNotes).toEqual([
      { language: "en-US", text: "Offline R6 temporary marker." },
      ...originalNotes,
    ]);
    const restore = createReleaseNotesAttachmentTool({
      ...common,
      localizedReleaseNotes: originalNotes,
    });
    const restored = await restore.tool.execute({}, {});
    expect(await restore.tool.verify?.({}, restored, {})).toBe(true);
    expect(current).toEqual(snapshot);
    expect(
      current.releases
        .find((item) => item.versionCodes.includes("3"))
        ?.releaseNotes?.some((note) => note.language === "en-US"),
    ).toBe(false);
    expect(updates).toHaveLength(2);
    // This proves PlayOps construction/verifier behavior with a fake gateway,
    // NOT live Google locale-removal behavior or a commit+restore experiment.
  });
});

describe("Phase 4.7 localized release-note validator", () => {
  it.each(["en", "en-US", "id", "de-AT", "pt-BR", "zh-Hant-TW"])(
    "accepts valid BCP-47 locale %s",
    (language) => {
      expect(normalizeReleaseNotesIntent([{ language, text: "Valid note" }])).toEqual([
        { language: language === "en-us" ? "en-US" : language, text: "Valid note" },
      ]);
    },
  );

  it.each(["en-us", "pt-br", "zh-hant-tw"])("canonicalizes locale %s", (language) => {
    const [note] = normalizeReleaseNotesIntent([{ language, text: "Note" }]);
    expect(note?.language).toBe(
      language === "en-us" ? "en-US" : language === "pt-br" ? "pt-BR" : "zh-Hant-TW",
    );
  });

  it.each(["", " ", "en_US", "en--US", "not a locale", "en\u0000US"])(
    "rejects malformed or blank locale %j",
    (language) => {
      expect(() => normalizeReleaseNotesIntent([{ language, text: "Note" }])).toThrowError(
        expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }),
      );
    },
  );

  it("rejects duplicate canonical locales instead of first/last-wins", () => {
    expect(() =>
      normalizeReleaseNotesIntent([
        { language: "en-US", text: "First" },
        { language: "en-us", text: "Second" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }));
  });

  it("requires at least one note", () => {
    expect(() => normalizeReleaseNotesIntent([])).toThrowError(
      expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }),
    );
  });

  it("accepts exactly 500 Unicode code points", () => {
    const text = "🙂".repeat(RELEASE_NOTE_MAX_UNICODE_CODE_POINTS);
    const [note] = normalizeReleaseNotesIntent([{ language: "en", text }]);
    expect(Array.from(note?.text ?? "")).toHaveLength(RELEASE_NOTE_MAX_UNICODE_CODE_POINTS);
  });

  it("rejects 501 Unicode code points without truncating", () => {
    const text = "🙂".repeat(RELEASE_NOTE_MAX_UNICODE_CODE_POINTS + 1);
    expect(() => normalizeReleaseNotesIntent([{ language: "en", text }])).toThrowError(
      expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }),
    );
    expect(Array.from(text)).toHaveLength(RELEASE_NOTE_MAX_UNICODE_CODE_POINTS + 1);
  });

  it.each(["", " ", "\t\n"])("rejects blank note text %j", (text) => {
    expect(() => normalizeReleaseNotesIntent([{ language: "en", text }])).toThrowError(
      expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }),
    );
  });

  it("rejects NUL and unsafe controls but allows normal note formatting", () => {
    expect(() =>
      normalizeReleaseNotesIntent([{ language: "en", text: "bad\u0000note" }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }));
    expect(() =>
      normalizeReleaseNotesIntent([{ language: "en", text: "bad\u000bnote" }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }));
    expect(normalizeReleaseNotesIntent([{ language: "en", text: "line 1\nline 2\t" }])).toEqual([
      { language: "en", text: "line 1\nline 2\t" },
    ]);
  });

  it("preserves operator text exactly and sorts notes by canonical locale", () => {
    const input = [
      { language: "id", text: "  Exact punctuation!  " },
      { language: "en-us", text: "Keep CAPS / punctuation." },
    ];
    const normalized = normalizeReleaseNotesIntent(input);
    expect(normalized).toEqual([
      { language: "en-US", text: "Keep CAPS / punctuation." },
      { language: "id", text: "  Exact punctuation!  " },
    ]);
    expect(input).toEqual([
      { language: "id", text: "  Exact punctuation!  " },
      { language: "en-us", text: "Keep CAPS / punctuation." },
    ]);
  });
});

describe("Phase 4.7 tool contract and intent binding", () => {
  it("uses the stable name, write permission, empty input, verifier, and no approval", () => {
    const composed = createReleaseNotesAttachmentTool(makeOptions());
    expect(composed.tool.name).toBe(RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME);
    expect(composed.tool.permission).toBe("write");
    expect(composed.tool.verify).toBeTypeOf("function");
    expect(composed.binding.approval).toBeUndefined();
    expect(composed.binding.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(() => composed.tool.inputSchema.parse({ localizedReleaseNotes: intendedNotes })).toThrow(
      "Release-note attachment input is invalid.",
    );
  });

  it("rejects a malformed caller-bound configured release before any gateway call", () => {
    expect(() =>
      createReleaseNotesAttachmentTool(
        makeOptions({
          configuredRelease: { ...configuredRelease, targetTrack: "beta" },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELEASE_CONFIGURATION" }));
  });

  it("rejects a caller-bound note collection that is empty before any mutation", () => {
    expect(() =>
      createReleaseNotesAttachmentTool(makeOptions({ localizedReleaseNotes: [] })),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RELEASE_NOTES" }));
  });

  it("serializes only targetTrack, versionCode, languages, noteCount, and updated", async () => {
    const { composed, output } = await executeWith(makeOptions());
    const serialized = composed.binding.serializeResult(output, {
      toolName: RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME,
      permission: "write",
      required: true,
      status: "passed",
      code: "VERIFIED",
      verified: true,
    });
    expect(JSON.parse(serialized)).toEqual({
      targetTrack,
      versionCode: "101",
      languages: ["en-US", "id"],
      noteCount: 2,
      updated: true,
    });
    expect(serialized).not.toContain("Improved login reliability");
  });
});

describe("Phase 4.7 fresh preflight and preservation", () => {
  it.each([
    { label: "no session", session: undefined, code: "EDIT_SESSION_REQUIRED" },
    {
      label: "expired session",
      session: trackedSession({ expiryTimeSeconds: "1" }),
      code: "EDIT_SESSION_EXPIRED",
    },
    {
      label: "package mismatch",
      session: trackedSession({ packageName: "com.example.other" }),
      code: "EDIT_SESSION_PACKAGE_MISMATCH",
    },
  ])("blocks before update for $label", async ({ session, code }) => {
    const fixture = makeGateway();
    const composed = createReleaseNotesAttachmentTool(
      makeOptions({ sessionStore: memoryStore(session), gateway: fixture.gateway }),
    );
    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({ code });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it("blocks invalid remote edit and wrong target track before update", async () => {
    const editFixture = makeGateway({ edit: { id: "other-edit", expiryTimeSeconds } });
    const editTool = createReleaseNotesAttachmentTool(
      makeOptions({ gateway: editFixture.gateway }),
    );
    await expect(editTool.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
    });
    expect(editFixture.state.updateCalls).toHaveLength(0);

    const trackFixture = makeGateway({ track: { track: "beta", releases: [] } });
    const trackTool = createReleaseNotesAttachmentTool(
      makeOptions({ gateway: trackFixture.gateway }),
    );
    await expect(trackTool.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "TRACK_MISMATCH",
    });
    expect(trackFixture.state.updateCalls).toHaveLength(0);
  });

  it("identifies exactly one configured release by uploaded versionCode", async () => {
    const missing = makeGateway({
      track: { track: targetTrack, releases: [release({ versionCodes: ["100"] })] },
    });
    await expect(
      createReleaseNotesAttachmentTool(makeOptions({ gateway: missing.gateway })).tool.execute(
        {},
        Object.freeze({}),
      ),
    ).rejects.toMatchObject({ code: "CONFIGURED_RELEASE_NOT_FOUND" });
    expect(missing.state.updateCalls).toHaveLength(0);

    const ambiguous = makeGateway({
      track: {
        track: targetTrack,
        releases: [release({ name: "A" }), release({ name: "B" })],
      },
    });
    await expect(
      createReleaseNotesAttachmentTool(makeOptions({ gateway: ambiguous.gateway })).tool.execute(
        {},
        Object.freeze({}),
      ),
    ).rejects.toMatchObject({ code: "CONFIGURED_RELEASE_AMBIGUOUS" });
    expect(ambiguous.state.updateCalls).toHaveLength(0);
  });

  it.each([
    { label: "name", configured: { ...configuredRelease, releaseName: "Other" } },
    {
      label: "status",
      configured: { ...configuredRelease, status: "completed" as const, userFraction: undefined },
    },
    { label: "version set", configured: { ...configuredRelease, versionCodes: ["100", "101"] } },
    { label: "fraction", configured: { ...configuredRelease, userFraction: 0.1 } },
  ])("blocks stale Phase 4.6 $label before update", async ({ configured }) => {
    const fixture = makeGateway();
    const composed = createReleaseNotesAttachmentTool(
      makeOptions({ gateway: fixture.gateway, configuredRelease: configured }),
    );
    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "CONFIGURED_RELEASE_CHANGED",
    });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });

  it("preserves every active release and changes only target releaseNotes", async () => {
    const unrelated: ReleaseState = {
      name: "Older",
      status: "completed",
      versionCodes: ["100"],
      releaseNotes: [{ language: "de-AT", text: "Older note" }],
      countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
      inAppUpdatePriority: 2,
    };
    const target = release({ releaseNotes: [{ language: "en-US", text: "Old note" }] });
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [unrelated, target] },
    });
    const { output } = await executeWith(makeOptions({ gateway: fixture.gateway }));
    const request = fixture.state.updateCalls[0];
    expect(request?.track).toBe(targetTrack);
    expect(request?.releases).toHaveLength(2);
    expect(request?.releases[0]).toEqual({
      name: "Older",
      status: "completed",
      versionCodes: ["100"],
      releaseNotes: [{ language: "de-AT", text: "Older note" }],
      countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
      inAppUpdatePriority: 2,
    });
    expect(request?.releases[1]).toEqual({
      name: "Candidate 101",
      status: "inProgress",
      versionCodes: ["101"],
      userFraction: 0.05,
      releaseNotes: intendedNotes,
      countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
      inAppUpdatePriority: 5,
    });
    expect(output).toEqual({
      targetTrack,
      versionCode: "101",
      languages: ["en-US", "id"],
      noteCount: 2,
      updated: true,
    });
  });

  it("preserves release order", async () => {
    const first = release({ name: "First", versionCodes: ["99"] });
    const target = release();
    const third = release({ name: "Third", versionCodes: ["102"] });
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [first, target, third] },
    });
    await executeWith(makeOptions({ gateway: fixture.gateway }));
    expect(fixture.state.updateCalls[0]?.releases.map((item) => item.name)).toEqual([
      "First",
      "Candidate 101",
      "Third",
    ]);
  });

  it("rejects an unroundtrippable existing note state before update", async () => {
    const fixture = makeGateway({
      track: {
        track: targetTrack,
        releases: [release({ releaseNotes: [{ language: "en-US", text: "bad\u0000note" }] })],
      },
    });
    const composed = createReleaseNotesAttachmentTool(makeOptions({ gateway: fixture.gateway }));
    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "TRACK_STATE_NOT_ROUNDTRIPPABLE",
    });
    expect(fixture.state.updateCalls).toHaveLength(0);
  });
});

describe("Phase 4.7 idempotency and verifier", () => {
  it("does not update when the exact canonical note set is already attached", async () => {
    const fixture = makeGateway({
      track: {
        track: targetTrack,
        releases: [
          release({
            releaseNotes: [
              { language: "id", text: "Meningkatkan keandalan proses masuk." },
              { language: "en-us", text: "Improved login reliability." },
            ],
          }),
        ],
      },
    });
    const { output, composed } = await executeWith(makeOptions({ gateway: fixture.gateway }));
    expect(output.updated).toBe(false);
    expect(fixture.state.updateCalls).toHaveLength(0);
    expect(await composed.tool.verify?.({}, output, Object.freeze({}))).toBe(true);
    expect(fixture.state.getTrackCalls).toEqual([targetTrack, targetTrack]);
  });

  it("requires update when one text differs", async () => {
    const fixture = makeGateway({
      track: {
        track: targetTrack,
        releases: [release({ releaseNotes: [{ language: "en-US", text: "Different" }] })],
      },
    });
    const { output } = await executeWith(makeOptions({ gateway: fixture.gateway }));
    expect(output.updated).toBe(true);
    expect(fixture.state.updateCalls).toHaveLength(1);
  });

  it.each([
    {
      label: "wrong note text",
      releases: [
        release({
          releaseNotes: [
            { language: "en-US", text: "Wrong" },
            { language: "id", text: "Meningkatkan keandalan proses masuk." },
          ],
        }),
      ],
    },
    {
      label: "missing locale",
      releases: [
        release({ releaseNotes: [{ language: "en-US", text: "Improved login reliability." }] }),
      ],
    },
    {
      label: "extra locale",
      releases: [release({ releaseNotes: [...intendedNotes, { language: "fr", text: "Extra" }] })],
    },
    {
      label: "changed name",
      releases: [release({ name: "Changed", releaseNotes: intendedNotes })],
    },
    {
      label: "changed status",
      releases: [release({ status: "completed", releaseNotes: intendedNotes })],
    },
    {
      label: "changed versionCodes",
      releases: [release({ versionCodes: ["100", "101"], releaseNotes: intendedNotes })],
    },
    {
      label: "changed fraction",
      releases: [release({ userFraction: 0.1, releaseNotes: intendedNotes })],
    },
    {
      label: "changed country targeting",
      releases: [
        release({
          countryTargeting: { countries: ["CA"], includeRestOfWorld: false },
          releaseNotes: intendedNotes,
        }),
      ],
    },
    {
      label: "changed priority",
      releases: [release({ inAppUpdatePriority: 1, releaseNotes: intendedNotes })],
    },
  ])("verifier rejects $label", async ({ releases }) => {
    const fixture = makeGateway();
    const composed = createReleaseNotesAttachmentTool(makeOptions({ gateway: fixture.gateway }));
    const output = await composed.tool.execute({}, Object.freeze({}));
    fixture.state.track = { track: targetTrack, releases };
    expect(await composed.tool.verify?.({}, output, Object.freeze({}))).toBe(false);
  });

  it("verifier rejects an unrelated release disappearing", async () => {
    const unrelated: ReleaseState = { name: "Older", status: "completed", versionCodes: ["100"] };
    const fixture = makeGateway({
      track: { track: targetTrack, releases: [unrelated, release()] },
    });
    const composed = createReleaseNotesAttachmentTool(makeOptions({ gateway: fixture.gateway }));
    const output = await composed.tool.execute({}, Object.freeze({}));
    const updatedRequest = fixture.state.updateCalls[0];
    if (!updatedRequest) throw new Error("expected one update request");
    const updatedTrack = requestToTrack(updatedRequest);
    const retainedRelease = updatedTrack.releases[1];
    if (!retainedRelease) throw new Error("expected retained release");
    fixture.state.track = { track: targetTrack, releases: [retainedRelease] };
    expect(await composed.tool.verify?.({}, output, Object.freeze({}))).toBe(false);
  });

  it("verifier rejects a wrong track and actually reads tracks.get", async () => {
    const fixture = makeGateway();
    const composed = createReleaseNotesAttachmentTool(makeOptions({ gateway: fixture.gateway }));
    const output = await composed.tool.execute({}, Object.freeze({}));
    fixture.state.track = { track: "beta", releases: [] };
    expect(await composed.tool.verify?.({}, output, Object.freeze({}))).toBe(false);
    expect(fixture.state.getTrackCalls).toHaveLength(2);
  });

  it.each([
    { label: "429", error: Object.assign(new Error("PRIVATE-429"), { status: 429 }) },
    { label: "500", error: Object.assign(new Error("PRIVATE-500"), { status: 500 }) },
    { label: "timeout", error: Object.assign(new Error("PRIVATE-TIMEOUT"), { code: "ETIMEDOUT" }) },
    {
      label: "ambiguous network",
      error: Object.assign(new Error("PRIVATE-RESET"), { code: "ECONNRESET" }),
    },
  ])("attempts tracks.update once for $label", async ({ error }) => {
    const fixture = makeGateway({ updateError: error });
    const composed = createReleaseNotesAttachmentTool(makeOptions({ gateway: fixture.gateway }));
    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "TRACK_UPDATE_FAILED",
    });
    expect(fixture.state.updateCalls).toHaveLength(1);
  });

  it("treats a malformed update response as uncertain without retry", async () => {
    const fixture = makeGateway({
      updateResponse: { track: targetTrack, releases: "not-an-array" },
    });
    const composed = createReleaseNotesAttachmentTool(makeOptions({ gateway: fixture.gateway }));
    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "TRACK_UPDATE_RESPONSE_INVALID",
    });
    expect(fixture.state.updateCalls).toHaveLength(1);
  });
});
