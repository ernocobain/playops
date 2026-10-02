/**
 * Phase 0.6 — audit log unit tests.
 *
 * All writes go to isolated temp directories; the operator's real audit log
 * is never touched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAuditEntry,
  AuditError,
  readAuditEntries,
  REDACTED,
  sanitizeAuditMetadata,
  type NewAuditEntry,
} from "../src/audit/index.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playops-audit-test-"));
  logPath = join(dir, "audit.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sample(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    type: "tool.invoke",
    actor: "agent",
    action: "reviews.list",
    status: "success",
    ...overrides,
  };
}

describe("appendAuditEntry", () => {
  it("appends one entry and returns it with id/timestamp filled", () => {
    const written = appendAuditEntry(logPath, sample());

    expect(written.id).toBeTruthy();
    expect(new Date(written.timestamp).toString()).not.toBe("Invalid Date");
    expect(written.type).toBe("tool.invoke");

    const raw = readFileSync(logPath, "utf8");
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(parsed.id).toBe(written.id);
    expect(parsed.action).toBe("reviews.list");
  });

  it("creates the parent directory and file when missing", () => {
    const nested = join(dir, "deep/nested/dir/audit.jsonl");
    appendAuditEntry(nested, sample());
    expect(readAuditEntries(nested)).toHaveLength(1);
  });

  it("preserves order across multiple appends", () => {
    appendAuditEntry(logPath, sample({ action: "a.first" }));
    appendAuditEntry(logPath, sample({ action: "b.second" }));
    appendAuditEntry(logPath, sample({ action: "c.third" }));

    const entries = readAuditEntries(logPath);
    expect(entries.map((e) => e.action)).toEqual(["a.first", "b.second", "c.third"]);
  });

  it("never truncates existing content", () => {
    appendAuditEntry(logPath, sample({ action: "kept" }));
    const before = readFileSync(logPath, "utf8");

    appendAuditEntry(logPath, sample({ action: "added" }));
    const after = readFileSync(logPath, "utf8");

    expect(after.startsWith(before)).toBe(true);
    expect(readAuditEntries(logPath)).toHaveLength(2);
  });

  it("produces valid JSONL: one complete JSON object per line, newline-terminated", () => {
    appendAuditEntry(logPath, sample({ action: "one" }));
    appendAuditEntry(logPath, sample({ action: "two" }));

    const raw = readFileSync(logPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.includes("\n\n")).toBe(false);

    const lines = raw.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("accepts a caller-pinned timestamp", () => {
    const written = appendAuditEntry(logPath, sample({ timestamp: "2026-01-01T00:00:00.000Z" }));
    expect(written.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("redacts sensitive metadata before writing, without mutating the input", () => {
    const metadata = {
      auth: { access_token: "abc", nested: { PASSWORD: "hunter2" } },
      note: "visible",
    };
    const frozen = structuredClone(metadata);

    const written = appendAuditEntry(logPath, sample({ metadata }));

    expect(metadata).toEqual(frozen); // input untouched
    const auth = (written.metadata as Record<string, unknown>).auth as Record<string, unknown>;
    expect(auth.access_token).toBe(REDACTED);
    expect((auth.nested as Record<string, unknown>).PASSWORD).toBe(REDACTED);

    const raw = readFileSync(logPath, "utf8");
    expect(raw).not.toContain("abc");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain(REDACTED);
  });
});

describe("readAuditEntries", () => {
  it("returns an empty list for a missing file", () => {
    expect(readAuditEntries(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("returns an empty list for an empty file", () => {
    writeFileSync(logPath, "");
    expect(readAuditEntries(logPath)).toEqual([]);
  });

  it("round-trips entries with metadata intact", () => {
    appendAuditEntry(
      logPath,
      sample({ metadata: { count: 3, flags: [true, false], nested: { ok: "yes" } } }),
    );
    const [entry] = readAuditEntries(logPath);
    expect(entry?.metadata).toEqual({
      count: 3,
      flags: [true, false],
      nested: { ok: "yes" },
    });
  });

  it("throws a typed error with the line number on malformed JSONL", () => {
    writeFileSync(logPath, '{"ok":true}\nnot-json\n{"ok":false}\n');

    try {
      readAuditEntries(logPath);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AuditError);
      const auditError = error as AuditError;
      expect(auditError.code).toBe("AUDIT_MALFORMED_LINE");
      expect(auditError.line).toBe(2);
      expect(auditError.message).toContain("line 2");
    }
  });

  it("tolerates blank lines while keeping true line numbering", () => {
    writeFileSync(logPath, '{"a":1}\n\n{"b":2}\n');
    const entries = readAuditEntries(logPath);
    expect(entries).toHaveLength(2);
  });
});

describe("sanitizeAuditMetadata", () => {
  it("redacts sensitive keys case- and separator-insensitively, recursively", () => {
    const input = {
      Authorization: "Bearer x",
      accessToken: "t1",
      "refresh-token": "t2",
      password: "p",
      Client_Secret: "cs",
      deep: { private_key: "pk", safe: "keep" },
    };
    const out = sanitizeAuditMetadata(input);

    expect(out.Authorization).toBe(REDACTED);
    expect(out.accessToken).toBe(REDACTED);
    expect(out["refresh-token"]).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.Client_Secret).toBe(REDACTED);
    const deep = out.deep as Record<string, unknown>;
    expect(deep.private_key).toBe(REDACTED);
    expect(deep.safe).toBe("keep");
  });

  it("redacts sensitive keys inside arrays of objects", () => {
    const input = {
      creds: [
        { token: "x", user: "u1" },
        { clientSecret: "y", user: "u2" },
      ],
    };
    const out = sanitizeAuditMetadata(input);
    const creds = out.creds as Record<string, unknown>[];
    expect(creds[0]?.token).toBe(REDACTED);
    expect(creds[0]?.user).toBe("u1");
    expect(creds[1]?.clientSecret).toBe(REDACTED);
  });

  it("leaves non-sensitive metadata unchanged", () => {
    const input = { action: "x", count: 2, nested: { list: [1, "two", null] } };
    expect(sanitizeAuditMetadata(input)).toEqual(input);
  });

  it("does not mutate the original metadata object", () => {
    const input = { token: "secret-value", nested: { password: "pw" } };
    const snapshot = structuredClone(input);
    sanitizeAuditMetadata(input);
    expect(input).toEqual(snapshot);
  });
});
