import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendAuditEntry, readAuditEntries } from "../src/audit/log.js";

const tracked = vi.hoisted(() => ({ calls: [] as string[], fail: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      tracked.calls.push("append");
      return actual.appendFileSync(...args);
    },
    fsyncSync: (fd: number) => {
      tracked.calls.push("sync");
      if (tracked.fail) throw new Error("RAW-FSYNC-FAILURE");
      return actual.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      tracked.calls.push("close");
      return actual.closeSync(fd);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  tracked.calls.length = 0;
  tracked.fail = false;
});
function auditPath() {
  const dir = fs.mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-durable-audit-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
}
const entry = {
  type: "health.threshold.alert",
  actor: "system",
  action: "health.check_thresholds",
  status: "success" as const,
  metadata: { observedValue: "0.010000000000000000002" },
};

describe("durable alert append using existing audit writer", () => {
  it("flushes the alert before closing and returning, preserving older bytes", () => {
    const path = auditPath();
    appendAuditEntry(path, { ...entry, type: "previous.event" });
    const before = fs.readFileSync(path, "utf8");
    tracked.calls.length = 0;
    const written = appendAuditEntry(path, entry, { durable: true });
    expect(tracked.calls.slice(0, 3)).toEqual(["append", "sync", "close"]);
    expect(fs.readFileSync(path, "utf8").startsWith(before)).toBe(true);
    expect(readAuditEntries(path)[1]).toEqual(written);
  });

  it("sync failure is AUDIT_WRITE_FAILED, and the descriptor is still closed", () => {
    const path = auditPath();
    tracked.fail = true;
    expect(() => appendAuditEntry(path, entry, { durable: true })).toThrowError(
      expect.objectContaining({ code: "AUDIT_WRITE_FAILED" }),
    );
    expect(tracked.calls).toEqual(["append", "sync", "close"]);
  });

  it("ordinary audit calls preserve their existing no-extra-flush behavior", () => {
    appendAuditEntry(auditPath(), entry);
    expect(tracked.calls).toEqual(["append", "close"]);
  });

  it("durable append also synchronizes the parent directory before success", () => {
    appendAuditEntry(auditPath(), entry, { durable: true });
    expect(tracked.calls).toEqual(["append", "sync", "close", "sync", "close"]);
  });
});
