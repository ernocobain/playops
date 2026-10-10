import { createHash } from "node:crypto";
import { decodeApprovalPayload } from "../src/approvals/challenge.js";
import { validateSerializedApproval } from "./approval-statement-reference.js";
import { preflightApprovalResponse } from "../src/daemon/pending-view.js";
import { MAX_RESPONSE_BYTES } from "../src/daemon/protocol.js";
import { describe, expect, it } from "vitest";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  parseDaemonRequest,
  parseDaemonResponse,
  serializeDaemonResponse,
} from "../src/daemon/protocol.js";
import { createReleaseEditOpenStatement } from "../src/releases/open-tool.js";
import {
  createReleaseCommitIntent,
  createReleaseCommitStatement,
} from "../src/releases/commit-approval.js";
import { encodeOperatorApprovalPayload } from "../src/runtime/approvals/operator-signature.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function response(commit = false, noteText = "é\n東京", expiry = "2026-10-10T00:10:00.000Z") {
  const statement = commit
    ? createReleaseCommitStatement(
        createReleaseCommitIntent({
          packageName: "com.example.app",
          editId: "PRIVATE-EDIT",
          targetTrack: "internal",
          versionCode: "42",
          targetTrackState: {
            track: "internal",
            releases: [
              {
                name: "Candidate",
                status: "completed",
                versionCodes: ["42"],
                releaseNotes: [{ language: "en-US", text: noteText }],
              },
            ],
          },
          validatedEdit: { valid: true, expiryTimeSeconds: "1900000000" },
        }),
      )
    : createReleaseEditOpenStatement("com.example.app");
  const payload = {
    protocolVersion: 1,
    requestId: "11111111-2222-4333-8444-555555555555",
    nonce: "n".repeat(43),
    toolName: commit ? "releases.commit_edit" : "releases.open_edit",
    permission: commit ? ("publish" as const) : ("destructive" as const),
    packageName: "com.example.app",
    requestDigest: createHash("sha256").update(statement, "utf8").digest("hex"),
    expiresAtUtc: expiry,
  };
  return {
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: "statement-protocol",
    outcome: "approval_required" as const,
    summary: "Untrusted convenience only",
    approval: {
      requestId: payload.requestId,
      toolName: payload.toolName,
      permission: payload.permission,
      packageName: payload.packageName,
      requestDigest: payload.requestDigest,
      expiresAtUtc: payload.expiresAtUtc,
      canonicalPayload: encodeOperatorApprovalPayload(payload).toString("utf8"),
      approvalStatementVersion: 1 as const,
      approvalStatementCanonical: statement,
    },
  };
}
function tampered(change: (a: Record<string, unknown>) => void, commit = false): unknown {
  const r = response(commit);
  const a = JSON.parse(JSON.stringify(r.approval)) as Record<string, unknown>;
  change(a);
  return { ...r, approval: a };
}
function changeStatement(
  a: Record<string, unknown>,
  mutate: (s: Record<string, unknown>) => void,
): void {
  const s = JSON.parse(String(a.approvalStatementCanonical)) as Record<string, unknown>;
  mutate(s);
  a.approvalStatementCanonical = canonical(s);
}

describe("Stage4B.1 statement protocol trust boundary", () => {
  it("parses length-prefixed fields by UTF8 bytes, not UTF16 characters", () => {
    const r = response();
    const nonce = "é東京";
    const canonicalPayload = encodeOperatorApprovalPayload({
      protocolVersion: 1,
      ...r.approval,
      nonce,
    }).toString("utf8");
    expect(canonicalPayload).toContain(`nonce=${Buffer.byteLength(nonce, "utf8")}:${nonce}`);
    const a = { ...r.approval, canonicalPayload };
    expect(decodeApprovalPayload(canonicalPayload).nonce).toBe(nonce);
    expect(validateSerializedApproval(JSON.stringify(a)).nonce).toBe(nonce);
    expect(() => parseDaemonResponse({ ...r, approval: a })).not.toThrow();
    expect(() =>
      parseDaemonResponse({
        ...r,
        approval: {
          ...a,
          canonicalPayload: canonicalPayload.replace(
            `nonce=${Buffer.byteLength(nonce, "utf8")}:`,
            `nonce=${nonce.length}:`,
          ),
        },
      }),
    ).toThrow();
  });
  it.each([-1, 0, 1])("enforces exact whole-envelope response boundary (delta=%s)", (delta) => {
    const base = response(true, "");
    const r = response(
      true,
      "a".repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(base), "utf8") + delta),
    );
    expect(Buffer.byteLength(JSON.stringify(r), "utf8")).toBe(MAX_RESPONSE_BYTES + delta);
    if (delta > 0) {
      expect(() => serializeDaemonResponse(r)).toThrow();
      expect(() => parseDaemonResponse(r)).toThrow();
    } else expect(serializeDaemonResponse(r).length).toBe(MAX_RESPONSE_BYTES + delta);
  });
  it.each([-1, 0, 1])("preflights the longest ISO expiry envelope boundary (delta=%s)", (delta) => {
    const expiry = "+100000-01-01T00:00:00.000Z";
    const base = response(true, "", expiry);
    const r = response(
      true,
      "a".repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(base), "utf8") + delta),
      expiry,
    );
    expect(Buffer.byteLength(JSON.stringify(r), "utf8")).toBe(MAX_RESPONSE_BYTES + delta);
    const refused = preflightApprovalResponse(
      r.correlationId,
      r.summary,
      r.approval.approvalStatementCanonical,
      r.approval,
    );
    if (delta > 0) expect(refused?.error?.code).toBe("APPROVAL_CHALLENGE_UNDELIVERABLE");
    else expect(refused).toBeUndefined();
  });
  it("uses wire v5 and refuses former v4 requests and responses", () => {
    expect(PLAYOPS_DAEMON_PROTOCOL_VERSION).toBe(5);
    expect(() =>
      parseDaemonRequest({ protocolVersion: 4, correlationId: "old", request: { kind: "status" } }),
    ).toThrow();
    expect(() => parseDaemonResponse({ ...response(), protocolVersion: 4 })).toThrow();
  });
  it("rejects a note-byte tamper instead of trusting the unchanged opaque digest", () => {
    expect(() =>
      parseDaemonResponse(
        tampered(
          (a) =>
            changeStatement(a, (s) => {
              const facts = s.facts as Record<string, unknown>;
              const track = facts.targetTrackCandidate as {
                releases: { releaseNotes: { text: string }[] }[];
              };
              const note = track.releases[0]?.releaseNotes[0];
              if (!note) throw new Error("fixture note missing");
              note.text += "!";
            }),
          true,
        ),
      ),
    ).toThrow();
  });
  it.each(["approvalStatementCanonical", "approvalStatementVersion", "canonicalPayload"])(
    "rejects missing %s",
    (field) => {
      expect(() =>
        parseDaemonResponse(
          tampered((a) => {
            Reflect.deleteProperty(a, field);
          }),
        ),
      ).toThrow();
    },
  );
  it.each([
    [
      "unknown challenge key",
      (a: Record<string, unknown>) => {
        a.extra = true;
      },
    ],
    [
      "unsupported version",
      (a: Record<string, unknown>) => {
        a.approvalStatementVersion = 2;
      },
    ],
    [
      "wrong statement type",
      (a: Record<string, unknown>) => {
        a.approvalStatementCanonical = {};
      },
    ],
    [
      "noncanonical JSON",
      (a: Record<string, unknown>) => {
        a.approvalStatementCanonical = `${String(a.approvalStatementCanonical)} `;
      },
    ],
    [
      "digest",
      (a: Record<string, unknown>) => {
        a.requestDigest = "a".repeat(64);
      },
    ],
    [
      "payload byte length",
      (a: Record<string, unknown>) => {
        a.canonicalPayload = String(a.canonicalPayload).replace("nonce=43:", "nonce=42:");
      },
    ],
    [
      "payload domain",
      (a: Record<string, unknown>) => {
        a.canonicalPayload = String(a.canonicalPayload).replace("APPROVAL_V1", "APPROVAL_V2");
      },
    ],
    [
      "payload nonce truncation",
      (a: Record<string, unknown>) => {
        a.canonicalPayload = `${String(a.canonicalPayload)}garbage`;
      },
    ],
    [
      "visible package",
      (a: Record<string, unknown>) => {
        a.packageName = "com.example.other";
      },
    ],
    [
      "visible permission",
      (a: Record<string, unknown>) => {
        a.permission = "publish";
      },
    ],
    [
      "visible tool",
      (a: Record<string, unknown>) => {
        a.toolName = "releases.commit_edit";
      },
    ],
    [
      "visible expiry",
      (a: Record<string, unknown>) => {
        a.expiresAtUtc = "2026-10-10T00:20:00.000Z";
      },
    ],
    [
      "statement unknown field",
      (a: Record<string, unknown>) =>
        changeStatement(a, (s) => {
          s.extra = true;
        }),
    ],
    [
      "facts unknown field",
      (a: Record<string, unknown>) =>
        changeStatement(a, (s) => {
          (s.facts as Record<string, unknown>).hidden = true;
        }),
    ],
  ])("fails closed for %s", (_label, change) => {
    expect(() => parseDaemonResponse(tampered(change))).toThrow();
  });
  it("refuses a stub approval-required response with no semantic challenge", () => {
    const r = response();
    expect(() =>
      parseDaemonResponse({
        protocolVersion: r.protocolVersion,
        correlationId: r.correlationId,
        outcome: r.outcome,
      }),
    ).toThrow();
  });
  it("preserves existing remote-domain empty code sets, absent staged fraction and country case", () => {
    const intent = createReleaseCommitIntent({
      packageName: "_com.example.app",
      editId: "domain-edit",
      targetTrack: "internal",
      versionCode: "42",
      targetTrackState: {
        track: "internal",
        releases: [
          { status: "draft", versionCodes: [] },
          {
            name: "Candidate",
            status: "inProgress",
            versionCodes: ["42"],
            countryTargeting: { countries: ["us", "ID"], includeRestOfWorld: false },
          },
        ],
      },
      validatedEdit: { valid: true, expiryTimeSeconds: "1900000000" },
    });
    const canonicalText = createReleaseCommitStatement(intent);
    const payload = {
      protocolVersion: 1,
      requestId: response().approval.requestId,
      nonce: "n".repeat(43),
      toolName: "releases.commit_edit",
      permission: "publish" as const,
      packageName: intent.packageName,
      requestDigest: intent.requestDigest,
      expiresAtUtc: response().approval.expiresAtUtc,
    };
    const r = {
      ...response(true),
      approval: {
        ...response(true).approval,
        packageName: intent.packageName,
        requestDigest: intent.requestDigest,
        approvalStatementCanonical: canonicalText,
        canonicalPayload: encodeOperatorApprovalPayload(payload).toString("utf8"),
      },
    };
    expect(() => parseDaemonResponse(r)).not.toThrow();
  });
  it("roundtrips complete canonical commit text without relaxing raw releaseNotes guards", () => {
    const r = response(true);
    expect(parseDaemonResponse(JSON.parse(serializeDaemonResponse(r).toString("utf8")))).toEqual(r);
    expect(() =>
      serializeDaemonResponse({ ...r, releaseNotes: [{ text: "raw" }] } as never),
    ).toThrow();
  });
});
