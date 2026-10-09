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
  type OperatorApprovalPayload,
} from "../src/runtime/approvals/operator-signature.js";

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
      ].sort(),
    );
  });
});
