/**
 * Client approval handling: challenge validation, signer export, safe file
 * I/O and signature-token parsing. Pure/offline: no daemon, no Google.
 */
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  CLIENT_EXPORT_VERSION,
  ClientApprovalError,
  SIGNATURE_BYTE_LENGTH,
  MAX_CHALLENGE_FILE_BYTES,
  createApprovalExport,
  crossCheckChallenge,
  parseSignatureToken,
  readChallengeFile,
  serializeApprovalExport,
  validateApprovalChallenge,
  writeChallengeFile,
} from "../src/client/approval.js";
import { approvalStatementDigest } from "../src/approvals/statement.js";
import { createReleaseEditOpenStatement } from "../src/releases/open-tool.js";
import { encodeOperatorApprovalPayload } from "../src/runtime/approvals/operator-signature.js";
import {
  createReleaseCommitIntent,
  createReleaseCommitStatement,
} from "../src/releases/commit-approval.js";
import { approvalChallengeFor } from "../src/daemon/pending-view.js";
import type { DaemonApprovalChallenge } from "../src/daemon/protocol.js";

const PACKAGE = "com.example.client";
const TOOL = "releases.open_edit";
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";
const EXPIRES = "2026-10-10T00:10:00.000Z";
const NONCE = "n".repeat(43);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-client-approval-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function validChallenge(): DaemonApprovalChallenge {
  const statement = createReleaseEditOpenStatement(PACKAGE);
  const requestDigest = approvalStatementDigest(statement);
  const canonicalPayload = encodeOperatorApprovalPayload({
    protocolVersion: 1,
    requestId: REQUEST_ID,
    nonce: NONCE,
    toolName: TOOL,
    permission: "destructive",
    packageName: PACKAGE,
    requestDigest,
    expiresAtUtc: EXPIRES,
  }).toString("utf8");
  return {
    requestId: REQUEST_ID,
    toolName: TOOL,
    permission: "destructive",
    packageName: PACKAGE,
    requestDigest,
    expiresAtUtc: EXPIRES,
    canonicalPayload,
    approvalStatementVersion: 1,
    approvalStatementCanonical: statement,
  };
}

describe("client approval validation", () => {
  it("accepts a well-formed challenge", () => {
    expect(() => validateApprovalChallenge(validChallenge())).not.toThrow();
  });

  it("rejects a tampered statement (semantic fact changed)", () => {
    const challenge = validChallenge();
    const tampered = {
      ...challenge,
      approvalStatementCanonical: challenge.approvalStatementCanonical.replace("none", "tracked"),
    };
    expect(() => validateApprovalChallenge(tampered)).toThrow(ClientApprovalError);
  });

  it("rejects a mismatched statement digest", () => {
    const challenge = validChallenge();
    expect(() =>
      validateApprovalChallenge({ ...challenge, requestDigest: "a".repeat(64) }),
    ).toThrow(ClientApprovalError);
  });

  it("rejects a payload-to-visible metadata mismatch", () => {
    const challenge = validChallenge();
    expect(() =>
      validateApprovalChallenge({ ...challenge, expiresAtUtc: "2026-10-10T00:20:00.000Z" }),
    ).toThrow(ClientApprovalError);
  });

  it("rejects an unsupported statement version", () => {
    const challenge = validChallenge();
    expect(() =>
      validateApprovalChallenge({
        ...challenge,
        approvalStatementVersion: 2,
      } as unknown),
    ).toThrow(ClientApprovalError);
  });
});

describe("client approval export", () => {
  it("preserves the challenge byte-exact and carries unsigned operator echo", () => {
    const challenge = validChallenge();
    const exported = createApprovalExport(challenge, { track: "internal", requestId: REQUEST_ID });
    expect(exported.clientExportVersion).toBe(CLIENT_EXPORT_VERSION);
    expect(exported.daemonProtocolVersion).toBe(5);
    expect(exported.challenge).toEqual(challenge);
    expect(exported.challenge.approvalStatementCanonical).toBe(
      challenge.approvalStatementCanonical,
    );
    expect(exported.challenge.canonicalPayload).toBe(challenge.canonicalPayload);

    const text = serializeApprovalExport(exported);
    const parsed = JSON.parse(text) as { challenge: DaemonApprovalChallenge };
    expect(parsed.challenge.approvalStatementCanonical).toBe(challenge.approvalStatementCanonical);
    expect(parsed.challenge.canonicalPayload).toBe(challenge.canonicalPayload);
    expect(parsed.challenge.requestDigest).toBe(challenge.requestDigest);
  });
});

describe("client challenge file", () => {
  it("round-trips a valid large commit challenge above the former 64-KiB cap", () => {
    const text = "Localized synthetic note 🎉\n".repeat(3500);
    const intent = createReleaseCommitIntent({
      packageName: PACKAGE,
      editId: "synthetic-edit",
      targetTrack: "internal",
      versionCode: "42",
      targetTrackState: {
        track: "internal",
        releases: [
          {
            name: "Synthetic large candidate",
            status: "completed",
            versionCodes: ["42"],
            releaseNotes: [{ language: "en-US", text }],
          },
        ],
      },
      validatedEdit: { valid: true, expiryTimeSeconds: "4102444800" },
    });
    const canonical = createReleaseCommitStatement(intent);
    const challenge = approvalChallengeFor(
      {
        requestId: REQUEST_ID,
        nonce: NONCE,
        toolName: "releases.commit_edit",
        permission: "publish",
        packageName: PACKAGE,
        requestDigest: approvalStatementDigest(canonical),
        expiresAtUtc: EXPIRES,
      },
      canonical,
    );
    validateApprovalChallenge(challenge);
    const exported = serializeApprovalExport(createApprovalExport(challenge));
    expect(Buffer.byteLength(exported)).toBeGreaterThan(64 * 1024);
    const path = join(tempDir(), "large-valid.json");
    writeChallengeFile(path, exported);
    expect(readChallengeFile(path)).toEqual(challenge);
  });

  it("completes short writes instead of publishing a truncated challenge file", () => {
    const path = join(tempDir(), "short-write.json");
    const text = serializeApprovalExport(createApprovalExport(validChallenge()));
    const actual = fs.writeSync;
    const partial = ((
      fd: number,
      data: string | Buffer,
      offset?: number | null,
      length?: number | string,
      position?: number | null,
    ) => {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const start = typeof data === "string" ? 0 : (offset ?? 0);
      const size = typeof length === "number" ? length : bytes.length - start;
      return actual(fd, bytes, start, Math.min(7, size), position ?? null);
    }) as typeof fs.writeSync;
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(partial);
    syncBuiltinESMExports();
    try {
      writeChallengeFile(path, text);
      expect(readFileSync(path, "utf8")).toBe(text);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("rejects an incompatible export wrapper instead of ignoring its version", () => {
    const path = join(tempDir(), "future.json");
    writeFileSync(
      path,
      JSON.stringify({ ...createApprovalExport(validChallenge()), clientExportVersion: 99 }),
    );
    expect(() => readChallengeFile(path)).toThrow(ClientApprovalError);
  });

  it("does not reopen the checked challenge by pathname (symlink-swap regression)", () => {
    const path = join(tempDir(), "checked.json");
    const target = join(tempDir(), "replacement.json");
    const original = validChallenge();
    const requestId = "99999999-2222-4333-8444-555555555555";
    const replacement = {
      ...original,
      requestId,
      canonicalPayload: encodeOperatorApprovalPayload({
        protocolVersion: 1,
        requestId,
        nonce: NONCE,
        toolName: TOOL,
        permission: "destructive",
        packageName: PACKAGE,
        requestDigest: original.requestDigest,
        expiresAtUtc: EXPIRES,
      }).toString("utf8"),
    };
    writeFileSync(path, serializeApprovalExport(createApprovalExport(original)));
    writeFileSync(target, serializeApprovalExport(createApprovalExport(replacement)));
    const read = fs.readFileSync;
    const raced = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === path) {
        fs.unlinkSync(path);
        fs.symlinkSync(target, path);
      }
      return read(...args);
    }) as typeof fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(raced);
    syncBuiltinESMExports();
    try {
      expect(readChallengeFile(path).requestId).toBe(original.requestId);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("creates exclusively at mode 0600 and round-trips", () => {
    const path = join(tempDir(), "challenge.json");
    const exported = createApprovalExport(validChallenge());
    writeChallengeFile(path, serializeApprovalExport(exported));

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const readBack = readChallengeFile(path);
    expect(readBack.requestId).toBe(REQUEST_ID);
  });

  it("refuses to overwrite an existing file", () => {
    const path = join(tempDir(), "challenge.json");
    writeChallengeFile(path, "first");
    expect(() => writeChallengeFile(path, "second")).toThrow(ClientApprovalError);
    // The original content is untouched.
    expect(readFileSync(path, "utf8")).toBe("first");
  });

  it("refuses a symbolic-link target", () => {
    const dir = tempDir();
    const target = join(dir, "real.json");
    writeFileSync(target, "existing");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    expect(() => writeChallengeFile(link, "payload")).toThrow(ClientApprovalError);
  });

  it("caps the file size on read", () => {
    const path = join(tempDir(), "big.json");
    writeFileSync(path, "x".repeat(MAX_CHALLENGE_FILE_BYTES + 1));
    expect(() => readChallengeFile(path)).toThrow(ClientApprovalError);
  });
});

describe("client cross-check", () => {
  it("accepts a matching request id and rejects a mismatch", () => {
    const challenge = validChallenge();
    expect(() => crossCheckChallenge(challenge, { requestId: REQUEST_ID })).not.toThrow();
    expect(() =>
      crossCheckChallenge(challenge, { requestId: "99999999-2222-4333-8444-555555555555" }),
    ).toThrow(ClientApprovalError);
  });
});

describe("signature token parsing", () => {
  it("accepts an unpadded 86-char base64url token decoding to 64 bytes", () => {
    const token = Buffer.alloc(SIGNATURE_BYTE_LENGTH, 7).toString("base64url");
    expect(token).toHaveLength(86);
    expect(parseSignatureToken(`  ${token}\n`)).toBe(token);
  });

  it("rejects wrong lengths, padding, non-base64url and empty", () => {
    expect(() => parseSignatureToken(Buffer.alloc(63).toString("base64url"))).toThrow(
      ClientApprovalError,
    );
    expect(() => parseSignatureToken(Buffer.alloc(65).toString("base64url"))).toThrow(
      ClientApprovalError,
    );
    expect(() => parseSignatureToken("abcd=")).toThrow(ClientApprovalError);
    expect(() => parseSignatureToken("not valid!!")).toThrow(ClientApprovalError);
    expect(() => parseSignatureToken("   ")).toThrow(ClientApprovalError);
  });
});
