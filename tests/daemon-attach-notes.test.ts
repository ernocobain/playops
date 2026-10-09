/**
 * Stage 3C — `attach_notes` durable write path.
 *
 * Real: protocol parsing (v4), the dispatcher, managed-session store, the
 * production `releases.attach_release_notes` tool + its verifier through
 * executeOneTool/runAgent, the shared release-notes canonical semantics, the
 * O_EXCL write-intent store, the transparent transport wrapper, and the Stage-3B
 * Unix socket server. Fake: the Google gateway only.
 *
 * Offline throughout. No network, no real Google, no commit, no edit commit.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonAttachNotesDependencies } from "../src/daemon/attach-notes.js";
import { createDaemonOperations, type DaemonOperations } from "../src/daemon/operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import { createFilePendingOperationStore } from "../src/daemon/pending-store.js";
import {
  encodeDaemonFrame,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  parseDaemonRequest,
  parseDaemonResponse,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { createDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import type { ReleaseEditGateway, ReleaseTrackUpdateGateway } from "../src/releases/gateway.js";
import {
  RELEASE_EDIT_SESSION_VERSION,
  ReleaseError,
  type GooglePlayEditSession,
  type ReleaseBundle,
  type ReleaseStatus,
  type ReleaseTrackUpdateRequest,
} from "../src/releases/index.js";
import {
  createFileReleaseWriteIntentStore,
  releaseWriteIntentPath,
  type ReleaseWriteIntentState,
  type ReleaseWriteIntentStore,
} from "../src/releases/release-write-intent-store.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";

const PACKAGE = "com.example.release";
const EDIT_ID = "edit-attach";
const TRACK = "internal";
const TARGET_VERSION_CODE = "42";
const OTHER_VERSION_CODE = "40";
const EXPIRY = "1900000000";
const LOCALE = "en-US";
const NOTE_TEXT = "Fresh release notes";
const CORRELATION = "corr-stage3c";
const SHA256_B = "b".repeat(64);

interface ReleaseShape {
  name?: string;
  status: ReleaseStatus;
  versionCodes: string[];
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
  countryTargeting?: { countries: string[]; includeRestOfWorld: boolean };
  inAppUpdatePriority?: number;
}

interface TrackShape {
  track: string;
  releases: ReleaseShape[];
}

/** Realistic target: multiple releases, multi-versionCode, multi-locale, full metadata. */
function initialTrack(): TrackShape {
  return {
    track: TRACK,
    releases: [
      {
        name: "42 (1.0)",
        status: "inProgress",
        versionCodes: ["41", TARGET_VERSION_CODE],
        userFraction: 0.25,
        releaseNotes: [
          { language: "en-US", text: "English old" },
          { language: "id-ID", text: "Catatan lama" },
        ],
        countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
        inAppUpdatePriority: 3,
      },
      {
        name: "40 (1.0)",
        status: "completed",
        versionCodes: [OTHER_VERSION_CODE],
        releaseNotes: [{ language: "en-US", text: "Legacy notes" }],
      },
    ],
  };
}

const BUNDLES: readonly ReleaseBundle[] = Object.freeze([
  Object.freeze({ versionCode: "41", sha256: "a".repeat(64) }),
  Object.freeze({ versionCode: TARGET_VERSION_CODE, sha256: SHA256_B, sha1: "c".repeat(40) }),
]);

const clone = <T>(value: T): T => structuredClone(value);

/** Mutable fixture release lookup. `trackOf` is for reads, `releaseOf` for edits. */
function releaseOf(track: TrackShape, name: string): ReleaseShape {
  const found = track.releases.find((release) => release.name === name);
  if (found === undefined) throw new Error(`missing fixture release ${name}`);
  return found;
}

function trackOf(track: TrackShape, name: string): ReleaseShape {
  return releaseOf(track, name);
}

const dirs: string[] = [];
const servers: DaemonServer[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-daemon-attach-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface GatewayFaults {
  /** Throw from the real transport (after the attempt is counted). */
  updateThrows: boolean;
  /** Await this before performing the update, to hold the gate open. */
  updateHold: Promise<void> | undefined;
  /** Rewrite the managed state right after the update applied. */
  tamperAfterUpdate: ((track: TrackShape) => void) | undefined;
  /** Called with the 1-based getTrack index; can rewrite the managed state. */
  onGetTrack: ((callIndex: number) => void) | undefined;
  /** Fail every getTrack from this 1-based index onward. */
  failGetTrackFrom: number;
  /** Replace the bundle listing returned by listBundles. */
  bundlesOverride: readonly ReleaseBundle[] | undefined;
}

interface FakeGateway {
  readonly gateway: ReleaseTrackUpdateGateway;
  readonly calls: { getEdit: number; listBundles: number; getTrack: number; updateTrack: number };
  readonly faults: GatewayFaults;
  managed(): TrackShape;
  setManaged(next: TrackShape): void;
  committed(): TrackShape;
}

function createFakeGateway(): FakeGateway {
  let managed = initialTrack();
  const committed = initialTrack();
  const calls = { getEdit: 0, listBundles: 0, getTrack: 0, updateTrack: 0 };
  const faults: GatewayFaults = {
    updateThrows: false,
    updateHold: undefined,
    tamperAfterUpdate: undefined,
    onGetTrack: undefined,
    failGetTrackFrom: 0,
    bundlesOverride: undefined,
  };

  const findTrack = (state: TrackShape, name: string): TrackShape => {
    if (state.track !== name) throw new Error("fake gateway: unknown track");
    return state;
  };

  const gateway: ReleaseTrackUpdateGateway = {
    getEdit: async () => {
      calls.getEdit += 1;
      return { id: EDIT_ID, expiryTimeSeconds: EXPIRY };
    },
    listBundles: async () => {
      calls.listBundles += 1;
      return faults.bundlesOverride ?? BUNDLES;
    },
    getTrack: async (_session, targetTrack) => {
      calls.getTrack += 1;
      const index = calls.getTrack;
      if (faults.failGetTrackFrom > 0 && index >= faults.failGetTrackFrom) {
        throw new Error("fake gateway: track read failed");
      }
      faults.onGetTrack?.(index);
      return clone(findTrack(managed, targetTrack));
    },
    updateTrack: async (_session, targetTrack, request: ReleaseTrackUpdateRequest) => {
      calls.updateTrack += 1;
      if (faults.updateHold !== undefined) await faults.updateHold;
      if (faults.updateThrows) {
        throw new ReleaseError("TRACK_UPDATE_FAILED", "fake gateway: transport failed");
      }
      const track = findTrack(managed, targetTrack);
      // Google's tracks.update replaces the track's release list.
      track.releases = clone(request.releases) as ReleaseShape[];
      faults.tamperAfterUpdate?.(track);
      return clone(track);
    },
  };

  return {
    gateway,
    calls,
    faults,
    managed: () => clone(managed),
    setManaged: (next): void => {
      managed = clone(next);
    },
    committed: () => clone(committed),
  };
}

interface StoreFaults {
  releaseFails: boolean;
  transitionToFails: ReleaseWriteIntentState | undefined;
  /** Evidence: every durable transition the daemon attempted, in order. */
  readonly transitions: { from: string; to: string }[];
  /** Evidence: every release() call's declared terminal state, in order. */
  readonly releases: string[];
  /** Fired when a transition to the given state is attempted. */
  onTransitionAttempt: ((to: ReleaseWriteIntentState) => void) | undefined;
}

function wrapWriteIntentStore(
  inner: ReleaseWriteIntentStore,
  faults: StoreFaults,
): ReleaseWriteIntentStore {
  return {
    acquire: (input) => inner.acquire(input),
    load: (scope) => inner.load(scope),
    inspect: (scope) => inner.inspect(scope),
    transition: async (scope) => {
      faults.transitions.push({ from: scope.from, to: scope.to });
      faults.onTransitionAttempt?.(scope.to);
      if (faults.transitionToFails === scope.to) {
        throw new Error("wrapped store: durable transition failed");
      }
      return inner.transition(scope);
    },
    release: async (scope) => {
      // Recorded BEFORE the call, so a refused release still shows what was declared.
      faults.releases.push(scope.expectedState);
      if (faults.releaseFails) throw new Error("wrapped store: release failed");
      await inner.release(scope);
    },
  };
}

interface Harness {
  readonly dir: string;
  readonly operations: DaemonOperations;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly fake: FakeGateway;
  readonly storeFaults: StoreFaults;
  readonly writeIntentRoot: string;
  readonly auditPath: string;
  readonly approvalPath: string;
  readonly privateKey: KeyObject;
  readonly dispatched: string[];
  readonly socketPath: string;
  attach(overrides?: Partial<Record<string, string>>): Promise<DaemonResponseEnvelope>;
  envelopeOf(request: unknown): DaemonRequestEnvelope;
  gateState(): Promise<ReleaseWriteIntentState | "clear">;
  writeIntentFile(): string;
}

interface HarnessOptions {
  readonly session?: boolean;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = tempDir();
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: PACKAGE,
  });
  if (options.session !== false) {
    await sessionStore.save({
      version: RELEASE_EDIT_SESSION_VERSION,
      packageName: PACKAGE,
      editId: EDIT_ID,
      expiryTimeSeconds: EXPIRY,
      createdAt: new Date().toISOString(),
    });
  }

  const fake = createFakeGateway();
  const storeFaults: StoreFaults = {
    releaseFails: false,
    transitionToFails: undefined,
    transitions: [],
    releases: [],
    onTransitionAttempt: undefined,
  };
  const writeIntentRoot = join(dir, "write-intents");
  const writeIntentStore = wrapWriteIntentStore(
    createFileReleaseWriteIntentStore(writeIntentRoot),
    storeFaults,
  );

  const auditPath = join(dir, "agent.jsonl");
  const approvalPath = join(dir, "approval.jsonl");
  const ledger = createFileAgentLedger(auditPath);
  const verificationLedger = createFileVerificationLedger(join(dir, "verification.jsonl"));

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  // The open-edit path is real; only its gateway is the same fake.
  const openGateway: ReleaseEditGateway = {
    createEdit: async (): Promise<GooglePlayEditSession> => ({
      packageName: PACKAGE,
      editId: EDIT_ID,
      expiryTimeSeconds: EXPIRY,
    }),
    getEdit: (session) => fake.gateway.getEdit(session),
    listTracks: async () => [],
  };
  const openBuilt = createReleaseEditOpenTool({
    packageName: PACKAGE,
    gateway: openGateway,
    store: sessionStore,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const attachNotesDeps: DaemonAttachNotesDependencies = {
    packageName: PACKAGE,
    managedSessionStore: sessionStore,
    releaseGateway: fake.gateway,
    writeIntentStore,
    ledger,
    verificationLedger,
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  const registry = new ToolRegistry();
  registry.register(openBuilt.tool);

  const dispatched: string[] = [];
  const operations = createDaemonOperations({
    packageName: PACKAGE,
    pendingStore: createFilePendingOperationStore(join(dir, "pending")),
    claimRoot: join(dir, "claims"),
    packageOperations: createPackageOperationSingleFlightCoordinator(),
    registry,
    openEdit: { binding: openBuilt.binding, input: {} },
    attachNotes: attachNotesDeps,
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "stage3c-test-anchor"),
    ledger,
    approvalLedger: createFileApprovalLedger(approvalPath),
    verificationLedger,
  });

  const socketPath = join(dir, "daemon.sock");
  const server = createDaemonServer({
    socketPath,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    handle: async (envelope) => {
      dispatched.push(envelope.request.kind);
      return operations.handle(envelope);
    },
  });
  await server.start();
  servers.push(server);

  const envelopeOf = (request: unknown): DaemonRequestEnvelope =>
    parseDaemonRequest({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
      request,
    });

  return {
    dir,
    operations,
    sessionStore,
    fake,
    storeFaults,
    writeIntentRoot,
    auditPath,
    approvalPath,
    privateKey,
    dispatched,
    socketPath,
    envelopeOf,
    attach: (overrides = {}): Promise<DaemonResponseEnvelope> =>
      operations.handle(
        envelopeOf({
          kind: "attach_notes",
          track: TRACK,
          versionCode: TARGET_VERSION_CODE,
          locale: LOCALE,
          noteText: NOTE_TEXT,
          ...overrides,
        }),
      ),
    gateState: async (): Promise<ReleaseWriteIntentState | "clear"> => {
      const gate = await createFileReleaseWriteIntentStore(writeIntentRoot).inspect({
        packageName: PACKAGE,
        editId: EDIT_ID,
      });
      return gate.status === "clear" ? "clear" : gate.state;
    },
    writeIntentFile: (): string => releaseWriteIntentPath(writeIntentRoot, PACKAGE, EDIT_ID),
  };
}

// ---------------------------------------------------------------- managed edit

describe("attach_notes: managed edit is required and never created", () => {
  it("fails closed with zero mutation when no managed edit exists", async () => {
    const harness = await buildHarness({ session: false });

    const response = await harness.attach();

    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("NO_MANAGED_EDIT");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(harness.fake.calls.getTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
    await expect(harness.sessionStore.load()).resolves.toBeUndefined();
  });
});

// ------------------------------------------------------- target derivation

describe("attach_notes: exact trusted target derivation", () => {
  it("rejects a versionCode no release contains, with zero mutation", async () => {
    const harness = await buildHarness();

    const response = await harness.attach({ versionCode: "999" });

    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("TARGET_RELEASE_NOT_FOUND");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("rejects an ambiguous release match rather than picking one", async () => {
    const harness = await buildHarness();
    const track = initialTrack();
    releaseOf(track, "40 (1.0)").versionCodes = [OTHER_VERSION_CODE, TARGET_VERSION_CODE];
    harness.fake.setManaged(track);

    const response = await harness.attach();

    expect(response.error?.code).toBe("TARGET_RELEASE_AMBIGUOUS");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("rejects a release with no name", async () => {
    const harness = await buildHarness();
    const track = initialTrack();
    delete releaseOf(track, "42 (1.0)").name;
    harness.fake.setManaged(track);

    const response = await harness.attach();

    expect(response.error?.code).toBe("TARGET_RELEASE_NAME_ABSENT");
    expect(harness.fake.calls.updateTrack).toBe(0);
  });

  it.each([
    ["halted", "halted"],
    ["statusUnspecified", "statusUnspecified"],
  ])("rejects release status %s", async (_label, status) => {
    const harness = await buildHarness();
    const track = initialTrack();
    releaseOf(track, "42 (1.0)").status = status as ReleaseStatus;
    harness.fake.setManaged(track);

    const response = await harness.attach();

    // `halted`/`statusUnspecified` are refused either by the explicit
    // configuration-status guard or earlier by the trusted normalizer.
    expect(["TARGET_RELEASE_STATUS_UNSUPPORTED", "TARGET_DERIVATION_FAILED"]).toContain(
      response.error?.code,
    );
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("rejects an ambiguous bundle match", async () => {
    const harness = await buildHarness();
    harness.fake.faults.bundlesOverride = [
      { versionCode: TARGET_VERSION_CODE, sha256: SHA256_B },
      { versionCode: TARGET_VERSION_CODE, sha256: "d".repeat(64) },
    ];

    const response = await harness.attach();

    expect(response.error?.code).toBe("TARGET_BUNDLE_AMBIGUOUS");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("rejects a missing bundle for the matched release", async () => {
    const harness = await buildHarness();
    harness.fake.faults.bundlesOverride = [{ versionCode: "41", sha256: "a".repeat(64) }];

    const response = await harness.attach();

    expect(response.error?.code).toBe("TARGET_BUNDLE_NOT_FOUND");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("fails closed when the trusted read fails during derivation", async () => {
    const harness = await buildHarness();
    harness.fake.faults.failGetTrackFrom = 1;

    const response = await harness.attach();

    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("TARGET_DERIVATION_FAILED");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("rejects an invalid locale at the wire and an over-long note before any mutation", async () => {
    const harness = await buildHarness();

    // The wire contract validates the locale shape, so it never reaches the daemon.
    expect(() =>
      harness.envelopeOf({
        kind: "attach_notes",
        track: TRACK,
        versionCode: TARGET_VERSION_CODE,
        locale: "not a locale!",
        noteText: NOTE_TEXT,
      }),
    ).toThrow();

    // An over-long note passes the transport limit but is not a valid note.
    const tooLong = await harness.attach({ noteText: "x".repeat(600) });

    expect(tooLong.error?.code).toBe("INVALID_RELEASE_NOTES");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("derives the complete versionCode set and trusted bundle sha256, not just the requested code", async () => {
    const harness = await buildHarness();

    const response = await harness.attach();

    expect(response.outcome).toBe("success");
    // The update carried the COMPLETE versionCode set of the matched release.
    expect(harness.fake.managed().releases[0]?.versionCodes).toEqual(["41", TARGET_VERSION_CODE]);
    expect(harness.fake.calls.updateTrack).toBe(1);
  });
});

// ----------------------------------------------------------- success path

describe("attach_notes: verified success lifecycle", () => {
  it("attaches through the production tool and settles VERIFIED_EXPECTED", async () => {
    const harness = await buildHarness();

    const response = await harness.attach();

    expect(response.outcome).toBe("success");
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("clear");
    const notes = trackOf(harness.fake.managed(), "42 (1.0)").releaseNotes ?? [];
    expect(notes.find((note) => note.language === LOCALE)?.text).toBe(NOTE_TEXT);
  });

  it("preserves every other part of the track (preservation contract)", async () => {
    const harness = await buildHarness();
    const before = harness.fake.managed();

    expect((await harness.attach()).outcome).toBe("success");

    const after = harness.fake.managed();
    const targetBefore = trackOf(before, "42 (1.0)");
    const targetAfter = trackOf(after, "42 (1.0)");

    expect(after.releases).toHaveLength(before.releases.length);
    expect(after.releases.map((release) => release.name)).toEqual(
      before.releases.map((release) => release.name),
    );
    expect(targetAfter.name).toBe(targetBefore.name);
    expect(targetAfter.status).toBe(targetBefore.status);
    expect(targetAfter.versionCodes).toEqual(targetBefore.versionCodes);
    expect(targetAfter.userFraction).toBe(targetBefore.userFraction);
    expect(targetAfter.countryTargeting).toEqual(targetBefore.countryTargeting);
    expect(targetAfter.inAppUpdatePriority).toBe(targetBefore.inAppUpdatePriority);
    // Unrelated release untouched, including its own notes.
    expect(after.releases[1]).toEqual(before.releases[1]);
    // The other locale on the target release is untouched.
    expect(targetAfter.releaseNotes?.find((note) => note.language === "id-ID")).toEqual({
      language: "id-ID",
      text: "Catatan lama",
    });
    expect(targetAfter.releaseNotes).toHaveLength(2);
  });

  it("keeps the managed edit and never commits", async () => {
    const harness = await buildHarness();

    expect((await harness.attach()).outcome).toBe("success");

    const session = await harness.sessionStore.load();
    expect(session?.editId).toBe(EDIT_ID);
  });

  it("allows sequential writes and accumulates both locales", async () => {
    const harness = await buildHarness();

    expect((await harness.attach()).outcome).toBe("success");
    const second = await harness.attach({ locale: "id-ID", noteText: "Catatan baru" });

    expect(second.outcome).toBe("success");
    expect(harness.fake.calls.updateTrack).toBe(2);
    const notes = trackOf(harness.fake.managed(), "42 (1.0)").releaseNotes ?? [];
    expect(notes.find((note) => note.language === "en-US")?.text).toBe(NOTE_TEXT);
    expect(notes.find((note) => note.language === "id-ID")?.text).toBe("Catatan baru");
    expect(notes).toHaveLength(2);
    expect(await harness.gateState()).toBe("clear");
  });
});

// ------------------------------------------------------------- no-op path

describe("attach_notes: locale cases and the no-op path", () => {
  it("treats an already-exact locale as a no-op: zero transport, VERIFIED_PRIOR", async () => {
    const harness = await buildHarness();
    const track = initialTrack();
    trackOf(track, "42 (1.0)").releaseNotes = [{ language: LOCALE, text: NOTE_TEXT }];
    harness.fake.setManaged(track);

    const response = await harness.attach();

    expect(response.outcome).toBe("success");
    expect(response.summary).toContain("already match");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });

  it("replaces only the requested locale when the text differs", async () => {
    const harness = await buildHarness();

    expect((await harness.attach()).outcome).toBe("success");

    const notes = trackOf(harness.fake.managed(), "42 (1.0)").releaseNotes ?? [];
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((note) => note.language)).size).toBe(2);
    expect(notes.find((note) => note.language === LOCALE)?.text).toBe(NOTE_TEXT);
  });
});

// ---------------------------------- non-round-trippable / invalid remote notes

describe("attach_notes: invalid remote notes state", () => {
  it("fails closed with zero mutation when the notes digest cannot be built", async () => {
    const harness = await buildHarness();
    const track = initialTrack();
    trackOf(track, "42 (1.0)").releaseNotes = [
      { language: "en-US", text: "one" },
      { language: "en-US", text: "two" },
    ];
    harness.fake.setManaged(track);

    const response = await harness.attach();

    expect(response.outcome).toBe("local_state_failure");
    expect(["TRACK_STATE_NOT_ROUNDTRIPPABLE", "TARGET_DERIVATION_FAILED"]).toContain(
      response.error?.code,
    );
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });
});

// ------------------------------------------------------- committed state

describe("attach_notes: committed state is untouched", () => {
  it("distinguishes managed edit state from committed state", async () => {
    const harness = await buildHarness();
    const committedBefore = harness.fake.committed();

    expect((await harness.attach()).outcome).toBe("success");

    expect(harness.fake.committed()).toEqual(committedBefore);
    const committedNotes = trackOf(harness.fake.committed(), "42 (1.0)").releaseNotes ?? [];
    expect(committedNotes.find((note) => note.language === LOCALE)?.text).toBe("English old");
  });
});

// ------------------------------------------------------- failure verdicts

describe("attach_notes: transport outcomes", () => {
  it("reports external_state_ambiguous after one unknown attempt and blocks the next", async () => {
    const harness = await buildHarness();
    harness.fake.faults.tamperAfterUpdate = (track): void => {
      // Neighbour release rewritten: neither the prior nor the expected state.
      const neighbour = track.releases.find((release) =>
        release.versionCodes.includes(OTHER_VERSION_CODE),
      );
      if (neighbour !== undefined) neighbour.name = "40 (1.1)";
    };

    const first = await harness.attach();

    expect(first.outcome).toBe("external_state_ambiguous");
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("AMBIGUOUS");

    const second = await harness.attach();

    expect(second.outcome).toBe("external_state_ambiguous");
    expect(second.error?.code).toBe("WRITE_INTENT_AMBIGUOUS");
    expect(harness.fake.calls.updateTrack).toBe(1);
  });

  it("reports remote_failure when the update definitely did not apply", async () => {
    const harness = await buildHarness();
    harness.fake.faults.updateThrows = true;

    const response = await harness.attach();

    expect(response.outcome).toBe("remote_failure");
    expect(response.error?.code).toBe("TRACK_UPDATE_NOT_APPLIED");
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("clear");
    expect(trackOf(harness.fake.managed(), "42 (1.0)").releaseNotes).toEqual([
      { language: "en-US", text: "English old" },
      { language: "id-ID", text: "Catatan lama" },
    ]);
  });

  it("retains the gate as cleanup_pending when the terminal settle cannot complete", async () => {
    const harness = await buildHarness();
    harness.storeFaults.releaseFails = true;

    const response = await harness.attach();

    expect(response.outcome).toBe("cleanup_pending");
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("VERIFIED_EXPECTED");

    const second = await harness.attach();

    expect(second.outcome).toBe("cleanup_pending");
    expect(second.error?.code).toBe("WRITE_INTENT_VERIFIED_EXPECTED");
    expect(harness.fake.calls.updateTrack).toBe(1);
  });

  it("releases the gate through VERIFIED_PRIOR after proving the prior state (never from PREPARED)", async () => {
    const harness = await buildHarness();
    harness.storeFaults.transitionToFails = "TRANSPORT_ATTEMPTED";

    const response = await harness.attach();

    // Remote mutation is proven impossible: the marker never became durable.
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("TRANSPORT_MARKER_FAILED");
    // HOW the gate was released: only after the exact trusted prior state was proven.
    expect(harness.storeFaults.transitions).toContainEqual({
      from: "PREPARED",
      to: "VERIFIED_PRIOR",
    });
    expect(harness.storeFaults.releases).toEqual(["VERIFIED_PRIOR"]);
    expect(harness.storeFaults.releases).not.toContain("PREPARED");
    expect(harness.storeFaults.releases).not.toContain("TRANSPORT_ATTEMPTED");
    expect(await harness.gateState()).toBe("clear");
  });

  it("retains the PREPARED gate and never releases when the prior state cannot be proven", async () => {
    const harness = await buildHarness();
    harness.storeFaults.transitionToFails = "TRANSPORT_ATTEMPTED";
    // From the moment the marker transition is attempted, no read can establish
    // the exact prior state any more.
    harness.storeFaults.onTransitionAttempt = (to): void => {
      if (to === "TRANSPORT_ATTEMPTED") {
        harness.fake.faults.failGetTrackFrom = harness.fake.calls.getTrack + 1;
      }
    };

    const response = await harness.attach();

    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("TRANSPORT_MARKER_FAILED");
    // No release was declared at all, and none from a non-terminal state.
    expect(harness.storeFaults.releases).toEqual([]);
    expect(harness.storeFaults.transitions).not.toContainEqual({
      from: "PREPARED",
      to: "VERIFIED_PRIOR",
    });
    expect(await harness.gateState()).toBe("PREPARED");

    // The retained gate blocks a new attempt and still admits no remote write.
    // (Reads are healthy again: it is the gate, not the read fault, that blocks.)
    harness.fake.faults.failGetTrackFrom = 0;
    const second = await harness.attach();
    expect(second.outcome).toBe("operation_in_progress");
    expect(second.error?.code).toBe("WRITE_INTENT_PREPARED");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(harness.storeFaults.releases).toEqual([]);
    expect(await harness.gateState()).toBe("PREPARED");
  });
});

// --------------------------------------------------------- drift / recheck

describe("attach_notes: post-acquisition recheck", () => {
  it("refuses to write and retains the gate when the target drifted after acquisition", async () => {
    const harness = await buildHarness();
    harness.fake.faults.onGetTrack = (index): void => {
      // getTrack #1 is derivation, #2 is the post-acquisition recheck.
      if (index === 2) {
        const drifted = initialTrack();
        trackOf(drifted, "42 (1.0)").releaseNotes = [{ language: "en-US", text: "Moved" }];
        harness.fake.setManaged(drifted);
      }
    };

    const response = await harness.attach();

    expect(response.outcome).toBe("operation_in_progress");
    expect(response.error?.code).toBe("WRITE_INTENT_TARGET_DRIFT");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("PREPARED");
  });

  it("fails closed before transport when the recorded state cannot be read back", async () => {
    const harness = await buildHarness();
    harness.fake.faults.failGetTrackFrom = 2;

    const response = await harness.attach();

    expect(response.outcome).toBe("operation_in_progress");
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("PREPARED");
  });
});

// ------------------------------------------------------------- concurrency

describe("attach_notes: O_EXCL concurrency", () => {
  it("lets exactly one concurrent attempt win and keeps the loser read-only", async () => {
    const harness = await buildHarness();
    let release: (() => void) | undefined;
    harness.fake.faults.updateHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const winner = harness.attach();
    // Wait until the winner is inside the real transport.
    for (let i = 0; i < 200 && harness.fake.calls.updateTrack === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.fake.calls.updateTrack).toBe(1);

    const loser = await harness.attach();

    expect(["operation_in_progress", "external_state_ambiguous"]).toContain(loser.outcome);
    expect(harness.fake.calls.updateTrack).toBe(1);

    release?.();
    const winnerResponse = await winner;
    expect(winnerResponse.outcome).toBe("success");
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("clear");
  });
});

// ------------------------------------------------ no approval / no pending

describe("attach_notes: no approval, no pending request, no note text on disk", () => {
  it("creates no signed pending request, no claim and no approval event", async () => {
    const harness = await buildHarness();

    expect((await harness.attach()).outcome).toBe("success");

    expect(existsSync(harness.approvalPath)).toBe(false);
    // No pending operation record and no request claim were ever created: the
    // pending store root does not even exist.
    expect(existsSync(join(harness.dir, "pending"))).toBe(false);
    const audit = readFileSync(harness.auditPath, "utf8");
    expect(audit).not.toContain("operator_signature");
    expect(audit).not.toContain("approval_required");
    // No request claim directory was ever populated for this operation.
    expect(existsSync(join(harness.dir, "claims"))).toBe(false);
  });

  it("persists only the note digest, never the note text", async () => {
    const harness = await buildHarness();
    const noteText = "Sensitive operator note text";
    let record = "";
    harness.fake.faults.tamperAfterUpdate = (): void => {
      // Read the durable intent while the gate is still held: a released record
      // is removed, so this is the only moment it exists on disk.
      if (existsSync(harness.writeIntentFile())) {
        record = readFileSync(harness.writeIntentFile(), "utf8");
      }
    };

    expect((await harness.attach({ noteText })).outcome).toBe("success");

    expect(record).not.toBe("");
    expect(record).not.toContain(noteText);
    expect(record).toContain("noteDigest");
    expect(record).toContain("priorTrackDigest");
    expect(record).toContain("expectedTrackDigest");
    // The audit trail must not leak it either.
    expect(readFileSync(harness.auditPath, "utf8")).not.toContain(noteText);
  });

  it("exposes no note text on the response envelope", async () => {
    const harness = await buildHarness();
    const noteText = "Envelope privacy check";

    const response = await harness.attach({ noteText });

    expect(JSON.stringify(response)).not.toContain(noteText);
  });
});

// ------------------------------------------------------- shared semantics

describe("attach_notes: shared canonical semantics only", () => {
  it("contains no private note merge, track equality or projection", async () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "daemon", "attach-notes.ts"),
      "utf8",
    );

    for (const forbidden of [
      "function sameTrack",
      "function sameNotes",
      "function sameRelease",
      "function notesMap",
      "canonicalVersionCodeSet(",
      "createReleaseCommitStateDigest",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("sameReleaseNotesTrackState");
    expect(source).toContain("createReleaseNotesTrackStateDigest");
    expect(source).toContain("createExpectedReleaseNotesTrack");
  });

  it("declares only terminal states to release(): no PREPARED/AMBIGUOUS bypass exists", async () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "daemon", "attach-notes.ts"),
      "utf8",
    );

    const declared = [...source.matchAll(/tryRelease\([^)]*?"([A-Z_]+)"/gu)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const state of declared) {
      expect(["VERIFIED_EXPECTED", "VERIFIED_PRIOR"]).toContain(state);
    }
    expect(source).not.toMatch(/tryRelease\([^)]*"(PREPARED|TRANSPORT_ATTEMPTED|AMBIGUOUS)"/u);
    // No bypass helper of any kind.
    expect(source).not.toMatch(/releaseAfterNoop|bypass|forceRelease/u);
  });
});

// ------------------------------------------------------------- socket path

interface SocketExchange {
  readonly raw: Buffer;
  readonly response?: DaemonResponseEnvelope;
}

async function exchange(
  socketPath: string,
  request: unknown,
  options: {
    halfClose?: boolean;
    trailing?: Buffer;
    onSocket?: (socket: { destroy(): void }) => void;
  } = {},
): Promise<SocketExchange> {
  const halfClose = options.halfClose ?? true;
  return await new Promise<SocketExchange>((resolve) => {
    const socket = createConnection(socketPath);
    const received: Buffer[] = [];
    let settled = false;
    const finalize = (): void => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(received);
      let response: DaemonResponseEnvelope | undefined;
      if (raw.byteLength > 0) {
        try {
          response = parseDaemonResponse(JSON.parse(raw.toString("utf8")) as unknown);
        } catch {
          response = undefined;
        }
      }
      socket.destroy();
      resolve(raw.byteLength === 0 ? { raw } : { raw, response });
    };
    socket.on("connect", () => {
      socket.write(encodeDaemonFrame(Buffer.from(JSON.stringify(request), "utf8")));
      if (options.trailing !== undefined) socket.write(options.trailing);
      options.onSocket?.(socket);
      if (halfClose) socket.end();
    });
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", finalize);
    setTimeout(finalize, 5_000);
  });
}

const frameOf = (envelope: DaemonRequestEnvelope): unknown => JSON.parse(JSON.stringify(envelope));

describe("attach_notes: real Unix socket round trip", () => {
  it("serves open_edit then attach_notes, each on its own connection", async () => {
    const harness = await buildHarness({ session: false });

    // 1. prepare_open_edit
    const prepared = await exchange(
      harness.socketPath,
      frameOf(harness.envelopeOf({ kind: "prepare_open_edit" })),
    );
    expect(prepared.response?.outcome).toBe("approval_required");
    const challenge = prepared.response?.approval;
    expect(challenge).toBeDefined();
    if (challenge === undefined) throw new Error("missing approval challenge");

    // 2. execute_open_edit with a real Ed25519 signature over the exact bytes
    const signature = sign(
      null,
      Buffer.from(challenge.canonicalPayload, "utf8"),
      harness.privateKey,
    ).toString("base64url");
    const executed = await exchange(
      harness.socketPath,
      frameOf(
        harness.envelopeOf({
          kind: "execute_open_edit",
          requestId: challenge.requestId,
          signature,
        }),
      ),
    );
    expect(executed.response?.outcome).toBe("success");

    // 3. attach_notes
    const attached = await exchange(
      harness.socketPath,
      frameOf(
        harness.envelopeOf({
          kind: "attach_notes",
          track: TRACK,
          versionCode: TARGET_VERSION_CODE,
          locale: LOCALE,
          noteText: NOTE_TEXT,
        }),
      ),
    );

    expect(attached.response?.outcome).toBe("success");
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("clear");
    await expect(harness.sessionStore.load()).resolves.toMatchObject({ editId: EDIT_ID });
    expect(harness.dispatched).toEqual(["prepare_open_edit", "execute_open_edit", "attach_notes"]);
  });

  it("keeps the write lifecycle independent of the socket", async () => {
    const harness = await buildHarness();
    let release: (() => void) | undefined;
    harness.fake.faults.updateHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let client: { destroy(): void } | undefined;
    const pending = exchange(
      harness.socketPath,
      frameOf(
        harness.envelopeOf({
          kind: "attach_notes",
          track: TRACK,
          versionCode: TARGET_VERSION_CODE,
          locale: LOCALE,
          noteText: NOTE_TEXT,
        }),
      ),
      {
        onSocket: (socket): void => {
          client = socket;
        },
      },
    );
    for (let i = 0; i < 400 && harness.fake.calls.updateTrack === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.fake.calls.updateTrack).toBe(1);

    // The client goes away while the remote update is still in flight.
    client?.destroy();
    release?.();
    await pending;

    // The daemon finished the operation; no retry, no gate deletion.
    for (let i = 0; i < 400 && (await harness.gateState()) !== "clear"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("clear");
    await expect(harness.sessionStore.load()).resolves.toMatchObject({ editId: EDIT_ID });
    expect(harness.dispatched).toEqual(["attach_notes"]);
  });

  it("keeps the Stage-3B framing guarantees: trailing junk is never dispatched", async () => {
    const harness = await buildHarness();

    const junk = await exchange(
      harness.socketPath,
      frameOf(
        harness.envelopeOf({
          kind: "attach_notes",
          track: TRACK,
          versionCode: TARGET_VERSION_CODE,
          locale: LOCALE,
          noteText: NOTE_TEXT,
        }),
      ),
      { trailing: Buffer.from("trailing-junk", "utf8") },
    );

    expect(junk.response?.outcome).toBe("protocol_error");
    expect(harness.dispatched).toHaveLength(0);
    expect(harness.fake.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
  });
});

// ------------------------------------------- real socket concurrency proof

describe("attach_notes: two real concurrent Unix-socket clients", () => {
  it("admits exactly one remote write, leaves the winner's gate record intact, then lets a later attach proceed", async () => {
    const harness = await buildHarness();
    let release: (() => void) | undefined;
    harness.fake.faults.updateHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const frameFor = (locale: string): unknown =>
      frameOf(
        harness.envelopeOf({
          kind: "attach_notes",
          track: TRACK,
          versionCode: TARGET_VERSION_CODE,
          locale,
          noteText: NOTE_TEXT,
        }),
      );

    // Client A: independent connection, one v4 frame, half-close.
    const winner = exchange(harness.socketPath, frameFor(LOCALE));

    // Deterministic synchronization: wait until the winner is inside the REAL
    // transport with its durable gate held, instead of relying on timing luck.
    for (let i = 0; i < 400 && harness.fake.calls.updateTrack === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("TRANSPORT_ATTEMPTED");
    const recordWhileWinnerHeld = readFileSync(harness.writeIntentFile(), "utf8");

    // Client B: independent connection, one v4 frame, half-close.
    const loser = await exchange(harness.socketPath, frameFor("id-ID"));

    expect(["operation_in_progress", "external_state_ambiguous"]).toContain(
      loser.response?.outcome,
    );
    // Exactly one remote write exists while the winner's gate is active.
    expect(harness.fake.calls.updateTrack).toBe(1);
    // The loser did not alter the winner's durable record.
    expect(readFileSync(harness.writeIntentFile(), "utf8")).toBe(recordWhileWinnerHeld);
    // The loser introduced no spurious terminal/ambiguous state.
    expect(await harness.gateState()).toBe("TRANSPORT_ATTEMPTED");

    release?.();
    const settled = await winner;

    expect(settled.response?.outcome).toBe("success");
    expect(harness.fake.calls.updateTrack).toBe(1);
    expect(harness.storeFaults.releases).toEqual(["VERIFIED_EXPECTED"]);
    expect(await harness.gateState()).toBe("clear");

    // Only now may a later normal attach proceed.
    const later = await exchange(harness.socketPath, frameFor("id-ID"));

    expect(later.response?.outcome).toBe("success");
    expect(harness.fake.calls.updateTrack).toBe(2);
    expect(harness.dispatched).toHaveLength(3);
  });
});

// --------------------------------------------------------------- served map

describe("attach_notes: served map", () => {
  it("serves exactly status, prepare_open_edit, execute_open_edit and attach_notes", async () => {
    const harness = await buildHarness();

    const unserved = await harness.operations.handle(
      harness.envelopeOf({
        kind: "prepare_commit",
        track: TRACK,
        versionCode: TARGET_VERSION_CODE,
      }),
    );
    expect(unserved.outcome).toBe("operation_unavailable");

    const status = await harness.operations.handle(harness.envelopeOf({ kind: "status" }));
    expect(status.outcome).toBe("status");
    expect(harness.fake.calls.updateTrack).toBe(0);
  });
});
