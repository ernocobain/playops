import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  isReleaseEditSessionExpired,
  parseEpochSeconds,
  type ReleaseEditSession,
} from "../src/releases/index.js";
import {
  createFileReleaseEditSessionStore,
  loadReleaseEditSessionState,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";

const packageName = "com.example.release";
const otherPackageName = "com.example.other";
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
});

function makeDir(): string {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-edit-session-"));
  return tempDir;
}

function session(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId: "edit-1",
    expiryTimeSeconds: "1900000000",
    createdAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function storeAt(path: string, expectedPackageName: string = packageName): ReleaseEditSessionStore {
  return createFileReleaseEditSessionStore(path, { expectedPackageName });
}

/** Raw session JSON with arbitrary (possibly invalid) field values for parser tests. */
function rawSession(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...session(), ...overrides });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("release edit session store", () => {
  it("1. reports no session when the store file does not exist", async () => {
    const path = join(makeDir(), "nested", "edit-session.json");
    await expect(storeAt(path).load()).resolves.toBeUndefined();
  });

  it("2. loads a valid tracked session", async () => {
    const path = join(makeDir(), "edit-session.json");
    const store = storeAt(path);
    await store.save(session());
    const loaded = await store.load();
    expect(loaded).toEqual(session());
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it("3. rejects malformed JSON and preserves the original file", async () => {
    const path = join(makeDir(), "edit-session.json");
    writeFileSync(path, "{ definitely not json", "utf8");
    await expect(storeAt(path).load()).rejects.toMatchObject({
      name: "ReleaseError",
      code: "EDIT_SESSION_STORE_INVALID",
    });
    expect(readFileSync(path, "utf8")).toBe("{ definitely not json");
  });

  it("4. rejects an unsupported session version", async () => {
    const path = join(makeDir(), "edit-session.json");
    writeFileSync(path, JSON.stringify({ ...session(), version: 2 }), "utf8");
    await expect(storeAt(path).load()).rejects.toMatchObject({
      code: "EDIT_SESSION_STORE_INVALID",
    });
  });

  it("5. rejects a session bound to a different package", async () => {
    const path = join(makeDir(), "edit-session.json");
    writeFileSync(path, rawSession({ packageName: otherPackageName }), "utf8");
    await expect(storeAt(path, packageName).load()).rejects.toMatchObject({
      code: "EDIT_SESSION_PACKAGE_MISMATCH",
    });
    expect(readJson(path).packageName).toBe(otherPackageName);
  });

  it("6. rejects an invalid edit id", async () => {
    const path = join(makeDir(), "edit-session.json");
    for (const editId of ["", " padded ", "with space", "with\u0000control", 42, null]) {
      writeFileSync(path, rawSession({ editId }), "utf8");
      await expect(storeAt(path).load()).rejects.toMatchObject({
        code: "EDIT_SESSION_STORE_INVALID",
      });
    }
  });

  it("7. rejects an invalid expiry value", async () => {
    const path = join(makeDir(), "edit-session.json");
    for (const expiryTimeSeconds of [
      "",
      "-1",
      "1.5",
      "1e9",
      "999999999999999999999999999999abc",
      42,
      null,
    ]) {
      writeFileSync(path, rawSession({ expiryTimeSeconds }), "utf8");
      await expect(storeAt(path).load()).rejects.toMatchObject({
        code: "EDIT_SESSION_STORE_INVALID",
      });
    }
  });

  it("8. creates parent directories on save", async () => {
    const dir = makeDir();
    const path = join(dir, "deep", "nested", "edit-session.json");
    await storeAt(path).save(session());
    expect(JSON.parse(readFileSync(path, "utf8")).editId).toBe("edit-1");
  });

  it("9. saves atomically and leaves no temporary files behind", async () => {
    const dir = makeDir();
    const path = join(dir, "edit-session.json");
    const store = storeAt(path);
    await store.save(session({ editId: "edit-first" }));
    await store.save(session({ editId: "edit-second" }));
    expect(readdirSync(dir)).toEqual(["edit-session.json"]);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(readJson(path)).toEqual(session({ editId: "edit-second" }));
  });

  it("10. clear removes tracked state and tolerates an absent file", async () => {
    const path = join(makeDir(), "edit-session.json");
    const store = storeAt(path);
    await store.save(session());
    await store.clear();
    await expect(store.load()).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("11. does not mutate the session object or reject unknown extra state fields silently", async () => {
    const path = join(makeDir(), "edit-session.json");
    const input = session();
    const snapshot = structuredClone(input);
    await storeAt(path).save(input);
    expect(input).toEqual(snapshot);

    writeFileSync(path, JSON.stringify({ ...session(), accessToken: "LEAK" }), "utf8");
    await expect(storeAt(path).load()).rejects.toMatchObject({
      code: "EDIT_SESSION_STORE_INVALID",
    });
    expect(readFileSync(path, "utf8")).toContain("LEAK");
  });
});

describe("release edit session expiry", () => {
  const nowSeconds = epochSecondsFromDate(() => new Date(1_800_000_000_000));

  it("12. treats a future expiry as valid", async () => {
    expect(nowSeconds).toBe("1800000000");
    const path = join(makeDir(), "edit-session.json");
    const store = storeAt(path);
    await store.save(session({ expiryTimeSeconds: "1800000001" }));
    await expect(loadReleaseEditSessionState(store, nowSeconds)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("13. treats an expiry exactly at now as expired", async () => {
    const path = join(makeDir(), "edit-session.json");
    const store = storeAt(path);
    await store.save(session({ expiryTimeSeconds: nowSeconds }));
    expect(
      isReleaseEditSessionExpired(session({ expiryTimeSeconds: nowSeconds }), nowSeconds),
    ).toBe(true);
    await expect(loadReleaseEditSessionState(store, nowSeconds)).resolves.toMatchObject({
      status: "expired",
    });
  });

  it("14. treats a past expiry as expired", async () => {
    const path = join(makeDir(), "edit-session.json");
    const store = storeAt(path);
    await store.save(session({ expiryTimeSeconds: "1700000000" }));
    await expect(loadReleaseEditSessionState(store, nowSeconds)).resolves.toMatchObject({
      status: "expired",
    });
  });

  it("15. compares very large epoch values losslessly", () => {
    expect(compareEpochSeconds("9223372036854775807", "9223372036854775806")).toBe(1);
    expect(compareEpochSeconds("9223372036854775807", "9223372036854775807")).toBe(0);
    expect(compareEpochSeconds("99999999999999999999", "9223372036854775807")).toBe(1);
    expect(compareEpochSeconds("000000000001800000000", "1800000000")).toBe(0);
    // A float conversion would collapse these two onto the same value.
    expect(compareEpochSeconds("9007199254740993", "9007199254740992")).toBe(1);
  });

  it("16. rejects invalid epoch seconds", () => {
    for (const invalid of ["", "-1", "1.5", "1e9", "abc", 42, null, undefined]) {
      expect(() => parseEpochSeconds(invalid)).toThrowError(/invalid/i);
      expect(() => compareEpochSeconds(invalid, "1")).toThrowError(/invalid/i);
    }
  });

  it("17. reports an absent session as none", async () => {
    const path = join(makeDir(), "edit-session.json");
    await expect(loadReleaseEditSessionState(storeAt(path), nowSeconds)).resolves.toEqual({
      status: "none",
    });
  });
});
