/**
 * Exclusive per-request execution claim.
 *
 * The primary concurrency proof spawns a real second Node process that attempts
 * the same O_EXCL claim; O_EXCL is never mocked. A control case proves the child
 * really can claim when the path is free, so a DENIED result is meaningful.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PendingStoreError, createFilePendingOperationStore } from "../src/daemon/pending-store.js";
import {
  RequestClaimError,
  acquireRequestClaim,
  inspectRequestClaim,
  releaseRequestClaim,
  requestClaimPath,
} from "../src/daemon/request-claim.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-claim-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

/** Runs in a separate process. Attempts the same exclusive claim the daemon would. */
const CHILD_CLAIM_SCRIPT = `
const fs = require("node:fs");
const target = process.argv[process.argv.length - 1];
try {
  const fd = fs.openSync(target, "wx", 0o600);
  fs.closeSync(fd);
  console.log("CLAIMED");
} catch (error) {
  console.log("DENIED:" + String(error && error.code));
}
`;

function attemptClaimInChildProcess(path: string): string {
  return execFileSync(process.execPath, ["-e", CHILD_CLAIM_SCRIPT, path], {
    encoding: "utf8",
  }).trim();
}

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (cause) {
    if (cause instanceof RequestClaimError) return cause.code;
    if (cause instanceof PendingStoreError) return cause.code;
    return `UNEXPECTED:${String(cause)}`;
  }
}

describe("exclusive request claim", () => {
  it("grants a claim once and keeps the claim file private", async () => {
    const dir = tempDir();
    const claim = await acquireRequestClaim(dir, REQUEST_ID);
    expect(claim.requestId).toBe(REQUEST_ID);
    expect(claim.pid).toBe(process.pid);
    expect(claim.token.length).toBeGreaterThanOrEqual(40);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(claim.path).mode & 0o777).toBe(0o600);
    expect(claim.path).toBe(requestClaimPath(dir, REQUEST_ID));
  });

  it("stores only a token digest, never the raw token", async () => {
    const dir = tempDir();
    const claim = await acquireRequestClaim(dir, REQUEST_ID);
    const contents = readFileSync(claim.path, "utf8");
    expect(contents.includes(claim.token)).toBe(false);
    expect(contents.includes("tokenDigest")).toBe(true);
    expect(contents.includes(REQUEST_ID)).toBe(true);
  });

  it("refuses a second claim from the same process", async () => {
    const dir = tempDir();
    await acquireRequestClaim(dir, REQUEST_ID);
    expect(await codeOf(() => acquireRequestClaim(dir, REQUEST_ID))).toBe("CLAIM_ALREADY_HELD");
  });

  it("proves exclusivity against a real concurrent process (unmocked O_EXCL)", async () => {
    const dir = tempDir();
    const claim = await acquireRequestClaim(dir, REQUEST_ID);

    // Control: with the path free, the same child script genuinely claims.
    const freeDir = tempDir();
    const freePath = join(freeDir, "free.claim");
    expect(attemptClaimInChildProcess(freePath)).toBe("CLAIMED");

    // Subject: with the parent holding the claim, the child must fail closed.
    expect(attemptClaimInChildProcess(claim.path)).toBe("DENIED:EEXIST");

    // The failed attempt must not have disturbed the holder.
    const inspected = await inspectRequestClaim(dir, REQUEST_ID);
    expect(inspected.status).toBe("held");
    if (inspected.status === "held") {
      expect(inspected.pid).toBe(process.pid);
      expect(inspected.claimedAtUtc).toBe(claim.claimedAtUtc);
    }
    expect(lstatSync(claim.path).mode & 0o777).toBe(0o600);
  });

  it("survives a fresh helper instance and never auto-steals a stale-looking claim", async () => {
    const dir = tempDir();
    await acquireRequestClaim(dir, REQUEST_ID, { pid: 999_999 });
    const inspected = await inspectRequestClaim(dir, REQUEST_ID);
    expect(inspected.status).toBe("held");
    if (inspected.status === "held") expect(inspected.pid).toBe(999_999);
    // A dead/absent pid is NOT grounds to reclaim.
    expect(await codeOf(() => acquireRequestClaim(dir, REQUEST_ID))).toBe("CLAIM_ALREADY_HELD");
  });

  it("reports absent when nothing is claimed", async () => {
    const dir = tempDir();
    expect(await inspectRequestClaim(dir, REQUEST_ID)).toEqual({ status: "absent" });
  });

  it("releases only with the holder's token, then allows a fresh claim", async () => {
    const dir = tempDir();
    const claim = await acquireRequestClaim(dir, REQUEST_ID);
    expect(await codeOf(() => releaseRequestClaim({ ...claim, token: "wrong-token-value" }))).toBe(
      "CLAIM_RELEASE_DENIED",
    );
    expect((await inspectRequestClaim(dir, REQUEST_ID)).status).toBe("held");

    await releaseRequestClaim(claim);
    expect((await inspectRequestClaim(dir, REQUEST_ID)).status).toBe("absent");
    const again = await acquireRequestClaim(dir, REQUEST_ID);
    expect(again.requestId).toBe(REQUEST_ID);
  });

  it("refuses to release a claim that is not held", async () => {
    const dir = tempDir();
    const claim = await acquireRequestClaim(dir, REQUEST_ID);
    await releaseRequestClaim(claim);
    expect(await codeOf(() => releaseRequestClaim(claim))).toBe("CLAIM_NOT_HELD");
  });

  it("rejects a non-canonical request identifier (no path traversal)", async () => {
    const dir = tempDir();
    for (const bad of ["../../etc/passwd", "not-a-uuid", "", "../x"]) {
      expect(await codeOf(() => acquireRequestClaim(dir, bad))).toBe("CLAIM_REQUEST_ID_INVALID");
    }
  });

  it("refuses an insecure claim directory mode", async () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    expect(await codeOf(() => acquireRequestClaim(dir, REQUEST_ID))).toBe("CLAIM_STORE_INSECURE");
  });

  it("fails closed on a malformed claim file", async () => {
    const dir = tempDir();
    const path = join(dir, `${REQUEST_ID}.claim`);
    for (const contents of [
      JSON.stringify({ schemaVersion: 99 }),
      JSON.stringify({
        schemaVersion: 1,
        requestId: REQUEST_ID,
        claimedAtUtc: "x",
        pid: 1,
        tokenDigest: "z",
      }),
      JSON.stringify({
        schemaVersion: 1,
        requestId: REQUEST_ID,
        claimedAtUtc: new Date().toISOString(),
        pid: 1,
        tokenDigest: "a".repeat(64),
        extra: 1,
      }),
      "{ not json",
    ]) {
      writeFileSync(path, contents, { mode: 0o600 });
      expect(await codeOf(() => inspectRequestClaim(dir, REQUEST_ID))).toMatch(
        /CLAIM_FILE_INVALID|UNEXPECTED:SyntaxError/u,
      );
    }
  });
});

describe("claim / pending-record crash window", () => {
  it("normalizes a claimed-but-untransitioned request into recovery and keeps the claim", async () => {
    const dir = tempDir();
    const store = createFilePendingOperationStore(dir);
    const record = await store.prepare({
      operation: "open_edit",
      toolName: "releases.open_edit",
      permission: "destructive",
      packageName: "com.dhikrama.driver",
      requestDigest: "a".repeat(64),
      intent: { kind: "open_edit" },
    });

    // The O_EXCL claim is created first; the process then dies before the
    // durable PENDING -> CLAIMED record transition is written. This is the
    // unavoidable window between the two durable operations.
    await acquireRequestClaim(dir, record.requestId);

    // Fresh instances must observe the true, split state.
    const freshStore = createFilePendingOperationStore(dir);
    expect((await freshStore.load(record.requestId))?.state).toBe("PENDING");
    expect(await freshStore.state(record.requestId)).toBe("pending");
    expect((await inspectRequestClaim(dir, record.requestId)).status).toBe("held");

    // Recovery may only normalize the request into a non-reusable state. Process
    // liveness is never treated as proof that execution did not happen.
    const normalized = await freshStore.transition(
      record.requestId,
      "PENDING",
      "RECOVERY_REQUIRED",
    );
    expect(normalized.state).toBe("RECOVERY_REQUIRED");
    expect(await freshStore.state(record.requestId)).toBe("recovery_required");

    // The claim is neither stolen nor auto-released, and the request is not
    // reusable through any path.
    expect((await inspectRequestClaim(dir, record.requestId)).status).toBe("held");
    expect(await codeOf(() => acquireRequestClaim(dir, record.requestId))).toBe(
      "CLAIM_ALREADY_HELD",
    );
    expect(
      await codeOf(() => freshStore.transition(record.requestId, "RECOVERY_REQUIRED", "PENDING")),
    ).toBe("PENDING_TRANSITION_ILLEGAL");
  });
});
