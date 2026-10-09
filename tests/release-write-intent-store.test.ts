/**
 * Stage 2.4 — durable release write-intent gate.
 *
 * Real filesystem durability throughout: 0700 root, 0600 record, exclusive
 * O_EXCL creation, fsync. The primary concurrency proof spawns a real second
 * Node process, matching the request-claim tests.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import {
  LEGAL_WRITE_INTENT_TRANSITIONS,
  RELEASE_WRITE_INTENT_SCHEMA_VERSION,
  ReleaseWriteIntentError,
  createFileReleaseWriteIntentStore,
  parseReleaseWriteIntentRecord,
  releaseWriteIntentNoteDigest,
  releaseWriteIntentPath,
  releaseWriteIntentScopeKey,
  type ReleaseWriteIntentRecord,
  type ReleaseWriteIntentState,
  type ReleaseWriteIntentStore,
} from "../src/releases/release-write-intent-store.js";
import type { ReleaseTrackState } from "../src/releases/index.js";

const PACKAGE = "com.example.release";
const EDIT_ID = "edit-abc";
const TRACK = "internal";
const VERSION_CODE = "42";
const LOCALE = "en-ID";
const SENTINEL_NOTE = "SENTINEL-NOTE-TEXT-do-not-persist-9f3a";
const dirs: string[] = [];

function tempDir(mode = 0o700): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-write-intent-"));
  chmodSync(dir, mode);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Canonical track digests come from the existing production helper (not invented here). */
const PRIOR_DIGEST = createReleaseCommitStateDigest({
  track: TRACK,
  releases: [{ name: "42 (1.0)", status: "completed", versionCodes: [VERSION_CODE] }],
});
const EXPECTED_DIGEST = createReleaseCommitStateDigest({
  track: TRACK,
  releases: [{ name: "42 (1.0)", status: "completed", versionCodes: [VERSION_CODE, "43"] }],
});

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (cause) {
    return cause instanceof ReleaseWriteIntentError ? cause.code : `UNEXPECTED:${String(cause)}`;
  }
}

function acquireInput(overrides: Partial<Parameters<ReleaseWriteIntentStore["acquire"]>[0]> = {}) {
  return {
    packageName: PACKAGE,
    editId: EDIT_ID,
    track: TRACK,
    versionCode: VERSION_CODE,
    locale: LOCALE,
    noteDigest: releaseWriteIntentNoteDigest(SENTINEL_NOTE),
    priorTrackDigest: PRIOR_DIGEST,
    expectedTrackDigest: EXPECTED_DIGEST,
    ...overrides,
  };
}

function storeAt(dir: string): ReleaseWriteIntentStore {
  return createFileReleaseWriteIntentStore(dir);
}

function scope(): { packageName: string; editId: string } {
  return { packageName: PACKAGE, editId: EDIT_ID };
}

function recordPath(dir: string): string {
  return releaseWriteIntentPath(dir, PACKAGE, EDIT_ID);
}

describe("release write-intent store: durable acquisition", () => {
  it("creates a PREPARED intent with a private root and record", async () => {
    const dir = tempDir();
    const store = storeAt(dir);

    const record = await store.acquire(acquireInput());

    expect(record.state).toBe("PREPARED");
    expect(record.schemaVersion).toBe(RELEASE_WRITE_INTENT_SCHEMA_VERSION);
    expect(record.packageName).toBe(PACKAGE);
    expect(record.editId).toBe(EDIT_ID);
    expect(record.track).toBe(TRACK);
    expect(record.versionCode).toBe(VERSION_CODE);
    expect(record.locale).toBe(LOCALE);
    expect(record.noteDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.priorTrackDigest).toBe(PRIOR_DIGEST);
    expect(record.expectedTrackDigest).toBe(EXPECTED_DIGEST);
    expect(record.attemptId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(recordPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("reports clear when nothing is recorded and held once acquired", async () => {
    const dir = tempDir();
    const store = storeAt(dir);

    expect(await store.inspect(scope())).toEqual({ status: "clear" });

    const record = await store.acquire(acquireInput());

    const gate = await store.inspect(scope());
    expect(gate.status).toBe("held");
    if (gate.status !== "held") throw new Error("expected a held gate");
    expect(gate.state).toBe("PREPARED");
    expect(gate.attemptId).toBe(record.attemptId);
    // PREPARED means another attempt owns the gate, not that anything is ambiguous.
    expect(gate.outcome).toBe("operation_in_progress");
  });

  it("refuses a second acquisition for the same edit and leaves the winner intact", async () => {
    const dir = tempDir();
    const first = storeAt(dir);
    const second = storeAt(dir);

    const winner = await first.acquire(acquireInput());
    expect(await codeOf(() => second.acquire(acquireInput()))).toBe("WRITE_INTENT_ACTIVE");

    const reloaded = await second.load(scope());
    expect(reloaded?.attemptId).toBe(winner.attemptId);
    expect(reloaded?.state).toBe("PREPARED");
    // The loser performed no read-then-write and overwrote nothing.
    expect(readFileSync(recordPath(dir), "utf8")).toContain(winner.attemptId);
  });

  it("serialises writers across a real second process via O_EXCL", async () => {
    const dir = tempDir();
    const store = storeAt(dir);

    // Child first: it wins the exclusive create, then the parent must be denied.
    const childResult = acquireInChildProcess(recordPath(dir));
    expect(childResult).toBe("ACQUIRED");
    expect(await codeOf(() => store.acquire(acquireInput()))).toBe("WRITE_INTENT_ACTIVE");
    // A record the store did not write is never silently ignored.
    expect(await codeOf(() => store.load(scope()))).toBe("WRITE_INTENT_RECORD_INVALID");

    // Parent first: the child must be denied.
    const other = tempDir();
    await storeAt(other).acquire(acquireInput());
    expect(acquireInChildProcess(releaseWriteIntentPath(other, PACKAGE, EDIT_ID))).toBe(
      "DENIED:EEXIST",
    );
  });

  it("keys the record by a fixed hash so no raw edit id becomes a path component", async () => {
    const dir = tempDir();
    const path = releaseWriteIntentPath(dir, PACKAGE, EDIT_ID);
    expect(path).not.toContain(EDIT_ID);
    expect(path.endsWith(".write-intent.json")).toBe(true);
    expect(releaseWriteIntentScopeKey(PACKAGE, EDIT_ID)).toMatch(/^[0-9a-f]{64}$/u);
    // Different scope, different key; the separator stops boundary collisions.
    expect(releaseWriteIntentScopeKey(PACKAGE, EDIT_ID)).not.toBe(
      releaseWriteIntentScopeKey(`${PACKAGE}x`, EDIT_ID),
    );
    expect(releaseWriteIntentScopeKey(PACKAGE, EDIT_ID)).not.toBe(
      releaseWriteIntentScopeKey(PACKAGE, `x${EDIT_ID}`),
    );
    expect(() => releaseWriteIntentScopeKey(PACKAGE, "")).toThrow(ReleaseWriteIntentError);
    expect(() => releaseWriteIntentScopeKey(PACKAGE, "a\u0000b")).toThrow(ReleaseWriteIntentError);
  });
});

describe("release write-intent store: schema strictness", () => {
  it("fails closed on an unknown schema version, unknown key or malformed value", () => {
    const base = {
      schemaVersion: RELEASE_WRITE_INTENT_SCHEMA_VERSION,
      attemptId: "11111111-2222-4333-8444-555555555555",
      packageName: PACKAGE,
      editId: EDIT_ID,
      track: TRACK,
      versionCode: VERSION_CODE,
      locale: LOCALE,
      noteDigest: releaseWriteIntentNoteDigest(SENTINEL_NOTE),
      priorTrackDigest: PRIOR_DIGEST,
      expectedTrackDigest: EXPECTED_DIGEST,
      state: "PREPARED",
      createdAtUtc: "2026-01-01T00:00:00.000Z",
      updatedAtUtc: "2026-01-01T00:00:00.000Z",
    };
    expect(parseReleaseWriteIntentRecord(base).state).toBe("PREPARED");
    for (const version of [0, 2, 99]) {
      expect(() => parseReleaseWriteIntentRecord({ ...base, schemaVersion: version })).toThrow(
        ReleaseWriteIntentError,
      );
    }
    expect(() => parseReleaseWriteIntentRecord({ ...base, extra: 1 })).toThrow(
      ReleaseWriteIntentError,
    );
    expect(() => parseReleaseWriteIntentRecord({ ...base, state: "DONE" })).toThrow(
      ReleaseWriteIntentError,
    );
    expect(() => parseReleaseWriteIntentRecord({ ...base, noteDigest: "nope" })).toThrow(
      ReleaseWriteIntentError,
    );
    expect(() => parseReleaseWriteIntentRecord({ ...base, versionCode: "-1" })).toThrow(
      ReleaseWriteIntentError,
    );
    expect(() => parseReleaseWriteIntentRecord({ ...base, updatedAtUtc: "not-a-time" })).toThrow(
      ReleaseWriteIntentError,
    );
  });

  it("does not auto-repair a malformed on-disk record", async () => {
    const dir = tempDir();
    const store = storeAt(dir);
    await store.acquire(acquireInput());
    const path = recordPath(dir);
    const tampered = { ...(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) };
    tampered.state = "NOT_A_STATE";
    writeFileSync(path, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    expect(await codeOf(() => store.load(scope()))).toBe("WRITE_INTENT_RECORD_INVALID");
    expect(await codeOf(() => store.inspect(scope()))).toBe("WRITE_INTENT_RECORD_INVALID");
    // Untouched on disk.
    expect(readFileSync(path, "utf8")).toContain("NOT_A_STATE");
  });

  it("refuses an insecure store root", async () => {
    const dir = tempDir(0o755);
    const store = storeAt(dir);
    expect(await codeOf(() => store.acquire(acquireInput()))).toBe("WRITE_INTENT_STORE_INSECURE");
  });
});

describe("release write-intent store: state machine", () => {
  it("allows exactly the declared transitions", async () => {
    expect(LEGAL_WRITE_INTENT_TRANSITIONS.PREPARED).toEqual([
      "TRANSPORT_ATTEMPTED",
      "VERIFIED_PRIOR",
    ]);
    expect(LEGAL_WRITE_INTENT_TRANSITIONS.TRANSPORT_ATTEMPTED).toEqual([
      "VERIFIED_EXPECTED",
      "VERIFIED_PRIOR",
      "AMBIGUOUS",
    ]);
    expect(LEGAL_WRITE_INTENT_TRANSITIONS.AMBIGUOUS).toEqual([
      "VERIFIED_EXPECTED",
      "VERIFIED_PRIOR",
    ]);
    expect(LEGAL_WRITE_INTENT_TRANSITIONS.VERIFIED_EXPECTED).toEqual([]);
    expect(LEGAL_WRITE_INTENT_TRANSITIONS.VERIFIED_PRIOR).toEqual([]);

    const dir = tempDir();
    const store = storeAt(dir);
    const created = await store.acquire(acquireInput());

    // Illegal: skipping the transport marker entirely.
    expect(
      await codeOf(() =>
        store.transition({ ...scope(), from: "PREPARED", to: "VERIFIED_EXPECTED" }),
      ),
    ).toBe("WRITE_INTENT_TRANSITION_ILLEGAL");
    // Illegal: a `from` that does not match the durable state.
    expect(
      await codeOf(() =>
        store.transition({ ...scope(), from: "TRANSPORT_ATTEMPTED", to: "AMBIGUOUS" }),
      ),
    ).toBe("WRITE_INTENT_TRANSITION_ILLEGAL");

    // Legal: the durable transport marker before the remote call.
    const attempted = await store.transition({
      ...scope(),
      from: "PREPARED",
      to: "TRANSPORT_ATTEMPTED",
    });
    expect(attempted.state).toBe("TRANSPORT_ATTEMPTED");
    // Identity is immutable across a transition; only updatedAtUtc moves.
    expect(attempted.createdAtUtc).toBe(created.createdAtUtc);
    expect(attempted.attemptId).toBe(created.attemptId);
    expect(attempted.updatedAtUtc >= created.updatedAtUtc).toBe(true);
  });

  it("never transitions back to PREPARED and never auto-retries transport", async () => {
    const dir = tempDir();
    const store = storeAt(dir);
    await store.acquire(acquireInput());
    await store.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
    await store.transition({ ...scope(), from: "TRANSPORT_ATTEMPTED", to: "AMBIGUOUS" });

    expect(
      await codeOf(() => store.transition({ ...scope(), from: "AMBIGUOUS", to: "PREPARED" })),
    ).toBe("WRITE_INTENT_TRANSITION_ILLEGAL");
    expect(
      await codeOf(() =>
        store.transition({ ...scope(), from: "AMBIGUOUS", to: "TRANSPORT_ATTEMPTED" }),
      ),
    ).toBe("WRITE_INTENT_TRANSITION_ILLEGAL");
  });

  it("lets an ambiguous record be settled by explicit recovery, then terminalises", async () => {
    for (const settled of ["VERIFIED_EXPECTED", "VERIFIED_PRIOR"] as const) {
      const dir = tempDir();
      const store = storeAt(dir);
      await store.acquire(acquireInput());
      await store.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
      await store.transition({ ...scope(), from: "TRANSPORT_ATTEMPTED", to: "AMBIGUOUS" });

      const terminal = await store.transition({ ...scope(), from: "AMBIGUOUS", to: settled });
      expect(terminal.state).toBe(settled);

      for (const target of ["PREPARED", "TRANSPORT_ATTEMPTED", "AMBIGUOUS"] as const) {
        expect(
          await codeOf(() => store.transition({ ...scope(), from: settled, to: target })),
        ).toBe("WRITE_INTENT_TRANSITION_ILLEGAL");
      }
      // The store performs no mutation and no retry of its own.
      expect((await store.load(scope()))?.state).toBe(settled);
    }
  });

  it("marks TRANSPORT_ATTEMPTED and AMBIGUOUS as ambiguous to a new writer", async () => {
    for (const state of ["TRANSPORT_ATTEMPTED", "AMBIGUOUS"] as const) {
      const dir = tempDir();
      const store = storeAt(dir);
      await store.acquire(acquireInput());
      if (state === "AMBIGUOUS") {
        await store.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
        await store.transition({ ...scope(), from: "TRANSPORT_ATTEMPTED", to: "AMBIGUOUS" });
      } else {
        await store.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
      }
      const gate = await store.inspect(scope());
      if (gate.status !== "held") throw new Error("expected a held gate");
      expect(gate.outcome).toBe("external_state_ambiguous");
    }
  });

  it("releases the gate only from a durably verified terminal state", async () => {
    const dir = tempDir();
    const store = storeAt(dir);
    await store.acquire(acquireInput());

    expect(
      await codeOf(() =>
        store.release({ ...scope(), expectedState: "PREPARED" as ReleaseWriteIntentState }),
      ),
    ).toBe("WRITE_INTENT_RELEASE_DENIED");
    expect(await codeOf(() => store.release({ ...scope(), expectedState: "VERIFIED_PRIOR" }))).toBe(
      "WRITE_INTENT_RELEASE_DENIED",
    );
    expect((await store.load(scope()))?.state).toBe("PREPARED");

    await store.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
    await store.transition({ ...scope(), from: "TRANSPORT_ATTEMPTED", to: "VERIFIED_EXPECTED" });
    await store.release({ ...scope(), expectedState: "VERIFIED_EXPECTED" });

    expect(await store.inspect(scope())).toEqual({ status: "clear" });
    expect(await store.load(scope())).toBeUndefined();
  });

  it("no longer exposes any PREPARED bypass: release is terminal-only", async () => {
    // The bypass API is gone entirely.
    const prepared = storeAt(tempDir());
    await prepared.acquire(acquireInput());
    expect("releaseAfterNoop" in prepared).toBe(false);
    expect(await codeOf(() => prepared.release({ ...scope(), expectedState: "PREPARED" }))).toBe(
      "WRITE_INTENT_RELEASE_DENIED",
    );
    expect((await prepared.load(scope()))?.state).toBe("PREPARED");

    const attempted = storeAt(tempDir());
    await attempted.acquire(acquireInput());
    await attempted.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
    expect(
      await codeOf(() => attempted.release({ ...scope(), expectedState: "TRANSPORT_ATTEMPTED" })),
    ).toBe("WRITE_INTENT_RELEASE_DENIED");
    expect((await attempted.load(scope()))?.state).toBe("TRANSPORT_ATTEMPTED");

    const ambiguous = storeAt(tempDir());
    await ambiguous.acquire(acquireInput());
    await ambiguous.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
    await ambiguous.transition({ ...scope(), from: "TRANSPORT_ATTEMPTED", to: "AMBIGUOUS" });
    expect(await codeOf(() => ambiguous.release({ ...scope(), expectedState: "AMBIGUOUS" }))).toBe(
      "WRITE_INTENT_RELEASE_DENIED",
    );
    expect((await ambiguous.load(scope()))?.state).toBe("AMBIGUOUS");
  });

  it("walks the ordinary no-op path: PREPARED -> VERIFIED_PRIOR -> release", async () => {
    const dir = tempDir();
    const store = storeAt(dir);
    await store.acquire(acquireInput());

    // A proven no-op never marks transport: it settles straight to VERIFIED_PRIOR.
    const settled = await store.transition({
      ...scope(),
      from: "PREPARED",
      to: "VERIFIED_PRIOR",
    });
    expect(settled.state).toBe("VERIFIED_PRIOR");

    // Until it is released, an ordinary writer sees cleanup_pending: the external
    // state is settled, only local cleanup remains.
    const gate = await store.inspect(scope());
    if (gate.status !== "held") throw new Error("expected a held gate");
    expect(gate.outcome).toBe("cleanup_pending");

    await store.release({ ...scope(), expectedState: "VERIFIED_PRIOR" });
    expect(await store.inspect(scope())).toEqual({ status: "clear" });

    // A subsequent acquisition then succeeds with a new attempt identity.
    const next = await store.acquire(acquireInput());
    expect(next.state).toBe("PREPARED");
    expect(next.attemptId).not.toBe(settled.attemptId);
  });

  it("maps a crash-left terminal record to cleanup_pending for both terminal states", async () => {
    for (const terminal of ["VERIFIED_EXPECTED", "VERIFIED_PRIOR"] as const) {
      const dir = tempDir();
      const writer = storeAt(dir);
      await writer.acquire(acquireInput());
      if (terminal === "VERIFIED_EXPECTED") {
        await writer.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
        await writer.transition({
          ...scope(),
          from: "TRANSPORT_ATTEMPTED",
          to: "VERIFIED_EXPECTED",
        });
      } else {
        await writer.transition({ ...scope(), from: "PREPARED", to: "VERIFIED_PRIOR" });
      }

      // Crash here. A brand new writer must neither proceed nor report a wrong
      // reason: the external edit state is already settled.
      const reader = storeAt(dir);
      const gate = await reader.inspect(scope());
      if (gate.status !== "held") throw new Error("expected a held gate");
      expect(gate.state).toBe(terminal);
      expect(gate.outcome).toBe("cleanup_pending");
      expect(gate.outcome).not.toBe("operation_in_progress");
      expect(gate.outcome).not.toBe("external_state_ambiguous");

      // Never silently deleted; still blocks a new write.
      expect((await reader.load(scope()))?.state).toBe(terminal);
      expect(await codeOf(() => reader.acquire(acquireInput()))).toBe("WRITE_INTENT_ACTIVE");

      // Explicit terminal release is the only way forward, and it works.
      await reader.release({ ...scope(), expectedState: terminal });
      expect(await reader.inspect(scope())).toEqual({ status: "clear" });
      expect((await reader.acquire(acquireInput())).state).toBe("PREPARED");
    }
  });
});

describe("release write-intent store: restart and staleness", () => {
  it("reloads exactly in a fresh store instance and keeps the gate held", async () => {
    for (const state of ["PREPARED", "TRANSPORT_ATTEMPTED", "AMBIGUOUS"] as const) {
      const dir = tempDir();
      const writer = storeAt(dir);
      const created = await writer.acquire(acquireInput());
      if (state !== "PREPARED") {
        await writer.transition({ ...scope(), from: "PREPARED", to: "TRANSPORT_ATTEMPTED" });
      }
      if (state === "AMBIGUOUS") {
        await writer.transition({ ...scope(), from: "TRANSPORT_ATTEMPTED", to: "AMBIGUOUS" });
      }

      // A brand new instance, as after a restart.
      const reader = storeAt(dir);
      const reloaded = await reader.load(scope());
      expect(reloaded?.state).toBe(state);
      expect(reloaded?.attemptId).toBe(created.attemptId);
      expect(reloaded?.createdAtUtc).toBe(created.createdAtUtc);
      expect(reloaded?.noteDigest).toBe(created.noteDigest);
      expect(reloaded?.priorTrackDigest).toBe(created.priorTrackDigest);
      expect(reloaded?.expectedTrackDigest).toBe(created.expectedTrackDigest);
      expect(reloaded?.track).toBe(TRACK);
      expect(reloaded?.versionCode).toBe(VERSION_CODE);
      expect(reloaded?.locale).toBe(LOCALE);
      // Still held, and never cleared automatically.
      expect(await codeOf(() => reader.acquire(acquireInput()))).toBe("WRITE_INTENT_ACTIVE");
    }
  });

  it("never infers safety from age: a stale record still holds the gate", async () => {
    const dir = tempDir();
    const store = storeAt(dir);
    const record = await store.acquire(acquireInput());
    const path = recordPath(dir);
    const veryOld = new Date("2001-01-01T00:00:00.000Z");
    utimesSync(path, veryOld, veryOld);

    expect(await codeOf(() => store.acquire(acquireInput()))).toBe("WRITE_INTENT_ACTIVE");
    expect((await store.load(scope()))?.attemptId).toBe(record.attemptId);
  });
});

describe("release write-intent store: content hygiene", () => {
  it("persists only the note digest, never the note text", async () => {
    const dir = tempDir();
    await storeAt(dir).acquire(acquireInput());

    const raw = readFileSync(recordPath(dir), "utf8");
    expect(raw).not.toContain(SENTINEL_NOTE);
    expect(raw).toContain(releaseWriteIntentNoteDigest(SENTINEL_NOTE));
    for (const forbidden of [
      "private_key",
      "privateKey",
      "access_token",
      "refresh_token",
      "Authorization",
      "authorization",
      "credential",
      "serviceAccountJson",
      "signature",
      "client_secret",
      "releaseNotes",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("accepts canonical track digests produced by the production helper", () => {
    expect(PRIOR_DIGEST).toMatch(/^[0-9a-f]{64}$/u);
    expect(EXPECTED_DIGEST).toMatch(/^[0-9a-f]{64}$/u);
    // Distinct canonical states produce distinct digests.
    expect(PRIOR_DIGEST).not.toBe(EXPECTED_DIGEST);
    const track: ReleaseTrackState = {
      track: TRACK,
      releases: [{ name: "42 (1.0)", status: "completed", versionCodes: [VERSION_CODE] }],
    };
    // Deterministic: the same canonical state always digests identically.
    expect(createReleaseCommitStateDigest(track)).toBe(PRIOR_DIGEST);
  });

  it("records the attempt id and timestamps but no note material", async () => {
    const dir = tempDir();
    const record: ReleaseWriteIntentRecord = await storeAt(dir).acquire(acquireInput());
    const raw = JSON.parse(readFileSync(recordPath(dir), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      [
        "attemptId",
        "createdAtUtc",
        "editId",
        "expectedTrackDigest",
        "locale",
        "noteDigest",
        "packageName",
        "priorTrackDigest",
        "schemaVersion",
        "state",
        "track",
        "updatedAtUtc",
        "versionCode",
      ].sort(),
    );
    expect(raw.attemptId).toBe(record.attemptId);
  });
});

/** Runs in a separate process: the same exclusive create the store performs. */
const CHILD_ACQUIRE_SCRIPT = `
const fs = require("node:fs");
const target = process.argv[process.argv.length - 1];
try {
  const fd = fs.openSync(target, "wx", 0o600);
  fs.closeSync(fd);
  console.log("ACQUIRED");
} catch (error) {
  console.log("DENIED:" + String(error && error.code));
}
`;

function acquireInChildProcess(path: string): string {
  return execFileSync(process.execPath, ["-e", CHILD_ACQUIRE_SCRIPT, path], {
    encoding: "utf8",
  }).trim();
}
