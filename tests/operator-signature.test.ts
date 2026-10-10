/**
 * Operator-signed approval verification — canonical payload, pinned trust anchor,
 * Ed25519 verification only.
 *
 * These tests are offline: every key is generated in-memory for the test run. No
 * network, no host filesystem outside the test process, no Google call.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as operatorSignature from "../src/runtime/approvals/operator-signature.js";
import {
  OPERATOR_APPROVAL_DOMAIN,
  OPERATOR_APPROVAL_PROTOCOL_VERSION,
  PRODUCTION_OPERATOR_ANCHOR_PATH,
  OperatorApprovalError,
  assertOperatorApprovalPayload,
  createOperatorApprovalVerifier,
  createProductionOperatorVerifier,
  encodeOperatorApprovalPayload,
  readPinnedProductionAnchor,
  type OperatorApprovalPayload,
} from "../src/runtime/approvals/operator-signature.js";
import { FsTrustError, type FsTrustMetadata, type FsTrustPort } from "../src/shared/fs-trust.js";

const DIGEST = "a".repeat(64);

function fixturePayload(overrides: Partial<OperatorApprovalPayload> = {}): OperatorApprovalPayload {
  return {
    protocolVersion: OPERATOR_APPROVAL_PROTOCOL_VERSION,
    requestId: "req-1",
    nonce: "bm9uY2U",
    toolName: "releases.open_edit",
    permission: "destructive",
    packageName: "com.example.app",
    requestDigest: DIGEST,
    expiresAtUtc: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Exact expected canonical bytes: domain, version, then length-prefixed fields. */
const EXPECTED_CANONICAL =
  "PLAYOPS_OPERATOR_APPROVAL_V1\n" +
  "version=1\n" +
  "requestId=5:req-1\n" +
  "nonce=7:bm9uY2U\n" +
  "toolName=18:releases.open_edit\n" +
  "permission=11:destructive\n" +
  "packageName=15:com.example.app\n" +
  `requestDigest=64:${DIGEST}\n` +
  "expiresAtUtc=24:2026-01-01T00:00:00.000Z\n";

function ephemeralKeyPair(): { publicKey: KeyObject; sign: (bytes: Buffer) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    sign: (bytes: Buffer): string => sign(null, bytes, privateKey).toString("base64url"),
  };
}

describe("operator approval canonical payload", () => {
  it("encodes the exact expected bytes (byte-for-byte fixture)", () => {
    expect(encodeOperatorApprovalPayload(fixturePayload()).toString("utf8")).toBe(
      EXPECTED_CANONICAL,
    );
  });

  it("is deterministic for the same payload", () => {
    const first = encodeOperatorApprovalPayload(fixturePayload());
    const second = encodeOperatorApprovalPayload(fixturePayload());
    expect(first.equals(second)).toBe(true);
  });

  it("length-prefixes every field so values cannot shift a field boundary", () => {
    const encoded = encodeOperatorApprovalPayload(fixturePayload()).toString("utf8");
    expect(encoded).toContain("requestId=5:req-1\n");
    expect(encoded).toContain("packageName=15:com.example.app\n");
    expect(encoded.startsWith(`${OPERATOR_APPROVAL_DOMAIN}\nversion=1\n`)).toBe(true);
  });

  it("depends on every bound field", () => {
    const baseline = encodeOperatorApprovalPayload(fixturePayload()).toString("hex");
    const mutations: Partial<OperatorApprovalPayload>[] = [
      { requestId: "req-2" },
      { nonce: "bm9uY2Ux" },
      { toolName: "releases.commit_edit" },
      { permission: "publish" },
      { packageName: "com.example.other" },
      { requestDigest: "b".repeat(64) },
      { expiresAtUtc: "2026-01-01T00:00:01.000Z" },
    ];
    for (const mutation of mutations) {
      expect(encodeOperatorApprovalPayload(fixturePayload(mutation)).toString("hex")).not.toBe(
        baseline,
      );
    }
  });

  it("does not bind pending-execution state or the record schema version", () => {
    const encoded = encodeOperatorApprovalPayload(fixturePayload()).toString("utf8");
    // Regression fixture: the schema bump and the new recovery state must not
    // change the bytes an operator signs.
    expect(encoded).toBe(EXPECTED_CANONICAL);
    for (const notBound of [
      "schemaVersion",
      "RECOVERY_REQUIRED",
      "COMPLETED",
      "CLAIMED",
      "CONSUMED",
      "PENDING",
      "state",
    ]) {
      expect(encoded.includes(notBound)).toBe(false);
    }
  });

  it("rejects a payload whose protocol version is not the supported version", () => {
    expect(() => assertOperatorApprovalPayload(fixturePayload({ protocolVersion: 2 }))).toThrow(
      OperatorApprovalError,
    );
  });

  it("rejects a non-canonical instant, a malformed digest and control characters", () => {
    expect(() =>
      assertOperatorApprovalPayload(fixturePayload({ expiresAtUtc: "2026-01-01" })),
    ).toThrow(OperatorApprovalError);
    expect(() => assertOperatorApprovalPayload(fixturePayload({ requestDigest: "abc" }))).toThrow(
      OperatorApprovalError,
    );
    expect(() => assertOperatorApprovalPayload(fixturePayload({ requestId: "a\nb" }))).toThrow(
      OperatorApprovalError,
    );
  });

  it("rejects unsupported permissions and non-object payloads", () => {
    const bad = { ...fixturePayload(), permission: "admin" };
    expect(() => assertOperatorApprovalPayload(bad)).toThrow(OperatorApprovalError);
    expect(() => assertOperatorApprovalPayload(null)).toThrow(OperatorApprovalError);
    expect(() => assertOperatorApprovalPayload("payload")).toThrow(OperatorApprovalError);
  });
});

describe("operator approval verification", () => {
  it("accepts a genuine signature over the exact canonical bytes", () => {
    const pair = ephemeralKeyPair();
    const verifier = createOperatorApprovalVerifier(pair.publicKey, "test-anchor");
    const payload = fixturePayload();
    const signature = pair.sign(encodeOperatorApprovalPayload(payload));
    expect(verifier.algorithm).toBe("ed25519");
    expect(verifier.keySource).toBe("test-anchor");
    expect(verifier.verify(payload, signature)).toBe(true);
  });

  it("rejects a signature when any bound field changes after signing", () => {
    const pair = ephemeralKeyPair();
    const verifier = createOperatorApprovalVerifier(pair.publicKey, "test-anchor");
    const signature = pair.sign(encodeOperatorApprovalPayload(fixturePayload()));
    const tampered: Partial<OperatorApprovalPayload>[] = [
      { requestId: "req-2" },
      { nonce: "bm9uY2Ux" },
      { toolName: "releases.commit_edit" },
      { permission: "publish" },
      { packageName: "com.example.other" },
      { requestDigest: "b".repeat(64) },
      { expiresAtUtc: "2026-01-01T00:00:01.000Z" },
      { protocolVersion: 2 },
    ];
    for (const mutation of tampered) {
      expect(verifier.verify(fixturePayload(mutation), signature)).toBe(false);
    }
  });

  it("rejects a signature produced by a different key", () => {
    const signer = ephemeralKeyPair();
    const other = ephemeralKeyPair();
    const verifier = createOperatorApprovalVerifier(other.publicKey, "test-anchor");
    const payload = fixturePayload();
    expect(verifier.verify(payload, signer.sign(encodeOperatorApprovalPayload(payload)))).toBe(
      false,
    );
  });

  it("fails closed for malformed signatures instead of throwing", () => {
    const pair = ephemeralKeyPair();
    const verifier = createOperatorApprovalVerifier(pair.publicKey, "test-anchor");
    const payload = fixturePayload();
    const malformed = ["", "not base64!!", Buffer.alloc(63).toString("base64url"), "AAAA"];
    for (const signature of malformed) {
      expect(verifier.verify(payload, signature)).toBe(false);
    }
    const notAnObject = "not-a-payload" as unknown as OperatorApprovalPayload;
    expect(verifier.verify(notAnObject, pair.sign(encodeOperatorApprovalPayload(payload)))).toBe(
      false,
    );
  });

  it("refuses a non-Ed25519 verification key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => createOperatorApprovalVerifier(rsa.publicKey, "test-anchor")).toThrow(
      OperatorApprovalError,
    );
  });
});

describe("operator trust anchor has no override", () => {
  it("pins the production anchor path as a source-level constant", () => {
    expect(PRODUCTION_OPERATOR_ANCHOR_PATH).toBe("/etc/playops/operator-approval.pub");
  });

  it("exposes a production verifier entry point that accepts no arguments", () => {
    expect(createProductionOperatorVerifier.length).toBe(0);
  });

  it("exports no signing capability and no path-taking verifier factory", () => {
    expect(Object.keys(operatorSignature).sort()).toEqual(
      [
        "OPERATOR_APPROVAL_DOMAIN",
        "OPERATOR_APPROVAL_PROTOCOL_VERSION",
        "PRODUCTION_OPERATOR_ANCHOR_PATH",
        "OperatorApprovalError",
        "assertOperatorApprovalPayload",
        "createOperatorApprovalVerifier",
        "createProductionOperatorVerifier",
        "encodeOperatorApprovalPayload",
        "readPinnedProductionAnchor",
      ].sort(),
    );
  });
});

const ANCHOR_PATH = "/etc/playops/operator-approval.pub";
const ANCHOR_PARENT = "/etc/playops";

interface AnchorNode {
  readonly meta: FsTrustMetadata;
  readonly content: string;
}

function fileMeta(overrides: Partial<FsTrustMetadata> = {}): FsTrustMetadata {
  return {
    uid: 0,
    gid: 0,
    mode: 0o100644,
    size: 0,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
    ...overrides,
  };
}

function dirMeta(overrides: Partial<FsTrustMetadata> = {}): FsTrustMetadata {
  return {
    uid: 0,
    gid: 0,
    mode: 0o40755,
    size: 0,
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
    ...overrides,
  };
}

/** A fake filesystem anchored at the (immutable) production anchor path. */
function anchorPort(leaf: AnchorNode, parent: AnchorNode | undefined): FsTrustPort {
  const nodes = new Map<string, AnchorNode>([[ANCHOR_PATH, leaf]]);
  if (parent !== undefined) nodes.set(ANCHOR_PARENT, parent);
  const open = new Map<number, AnchorNode>();
  let nextFd = 7;
  const openNode = (path: string): number => {
    const node = nodes.get(path);
    if (node === undefined) throw new FsTrustError("TRUST_UNREADABLE", `fake: missing ${path}`);
    if (node.meta.isSymbolicLink) throw new FsTrustError("TRUST_PATH_UNSAFE", `fake: symlink`);
    const fd = nextFd;
    nextFd += 1;
    open.set(fd, node);
    return fd;
  };
  return {
    lstat: (path) => nodes.get(path)?.meta,
    openReadNoFollow: (path) => openNode(path),
    openDirectoryNoFollow: (path) => openNode(path),
    fstat: (fd) => {
      const node = open.get(fd);
      if (node === undefined) throw new FsTrustError("TRUST_UNREADABLE", "fake: bad fd");
      return node.meta;
    },
    readAll: (fd, limit) => Buffer.from(open.get(fd)?.content ?? "", "utf8").subarray(0, limit + 1),
    close: (fd) => {
      open.delete(fd);
    },
  };
}

function expectAnchorError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected an anchor rejection");
  } catch (cause) {
    expect(cause).toBeInstanceOf(OperatorApprovalError);
    expect((cause as OperatorApprovalError).code).toBe(code);
  }
}

describe("operator trust anchor hardening (Stage 4C.1)", () => {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

  function securePort(
    leafOverrides: Partial<FsTrustMetadata> = {},
    parentOverrides: Partial<FsTrustMetadata> = {},
    parent = true,
  ): FsTrustPort {
    return anchorPort(
      { meta: fileMeta({ size: Buffer.byteLength(pem), ...leafOverrides }), content: pem },
      parent ? { meta: dirMeta(parentOverrides), content: "" } : undefined,
    );
  }

  it("accepts a secure root-owned anchor fixture and verifies a genuine signature", () => {
    const key = readPinnedProductionAnchor({
      port: securePort(),
      policy: { trustedOwnerUid: 0 },
    });
    expect(key.asymmetricKeyType).toBe("ed25519");
    const verifier = createOperatorApprovalVerifier(key, "stage-4c1-seam");
    const payload = fixturePayload();
    const signature = sign(null, encodeOperatorApprovalPayload(payload), pair.privateKey).toString(
      "base64url",
    );
    expect(verifier.verify(payload, signature)).toBe(true);
  });

  it("refuses a symlinked, directory, wrong-owner or writable anchor leaf", () => {
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: anchorPort(
            { meta: fileMeta({ isSymbolicLink: true }), content: pem },
            { meta: dirMeta(), content: "" },
          ),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: anchorPort(
            { meta: fileMeta({ isFile: false, isDirectory: true }), content: pem },
            { meta: dirMeta(), content: "" },
          ),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: securePort({ uid: 1000 }),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: securePort({ mode: 0o100662 }),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: securePort({ mode: 0o100642 }),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
  });

  it("refuses an insecure anchor parent directory", () => {
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: securePort({}, { mode: 0o40777 }),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: securePort({}, { uid: 1000 }),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: anchorPort(
            { meta: fileMeta({ size: Buffer.byteLength(pem) }), content: pem },
            { meta: { ...dirMeta(), isDirectory: false, isSymbolicLink: true }, content: "" },
          ),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_UNREADABLE",
    );
  });

  it("still refuses a malformed or non-Ed25519 key with ANCHOR_INVALID", () => {
    // Replace the content with an RSA public key: the reader must reach the key
    // parse and fail with ANCHOR_INVALID.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: anchorPort(
            { meta: fileMeta({ size: Buffer.byteLength(rsa) }), content: rsa },
            { meta: dirMeta(), content: "" },
          ),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_INVALID",
    );
    expectAnchorError(
      () =>
        readPinnedProductionAnchor({
          port: anchorPort(
            { meta: fileMeta(), content: "not a key" },
            { meta: dirMeta(), content: "" },
          ),
          policy: { trustedOwnerUid: 0 },
        }),
      "ANCHOR_INVALID",
    );
  });
});
