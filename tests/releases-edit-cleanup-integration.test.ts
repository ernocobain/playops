/**
 * Phase 4.15 / Blocker B4 — `releases.cleanup_known_edit` through the REAL Phase 2
 * runtime: real ToolRegistry, real runAgent, real permission engine, real approval
 * gate, real verification machinery, and a fake Publisher gateway.
 *
 * The whole chain is exercised: fake generated client -> production publisher
 * boundary (safe metadata) -> release gateway adapter -> cleanup tool -> narrow
 * contextual classifier. No Google call, no credential, no browser.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import {
  approveInteractively,
  type ApprovalGrant,
  type ApprovalRequest,
} from "../src/runtime/approvals/index.js";
import { runAgent } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import { RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME } from "../src/releases/cleanup-tool.js";
import type { ReleaseEditCleanupCandidate } from "../src/releases/cleanup-tool.js";
import type { ReleaseError, ReleaseEditSession } from "../src/releases/index.js";

const packageName = "com.dhikrama.driver";
const editId = "managed-edit-1";
const expiryTimeSeconds = "4102444800";
const fixedNow = new Date("2026-10-02T00:00:00.000Z");
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase415-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function configFor(dir: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName, serviceAccountJson: "[REDACTED]" },
    audit: { logPath: join(dir, "audit.jsonl") },
    release: {
      editSessionPath: join(dir, "edit-session.json"),
      editCleanupJournalPath: join(dir, "edit-cleanup-journal.json"),
    },
  };
}

/** Post-delete read behaviour of the fake generated client. */
type PostDeleteMode = "observed" | "ok" | "reset" | 400 | 403 | 404 | 429 | 500;

const GOOGLE_STATUS: Readonly<Record<number, readonly [string, string]>> = {
  400: ["FAILED_PRECONDITION", "failedPrecondition"],
  403: ["PERMISSION_DENIED", "forbidden"],
  404: ["NOT_FOUND", "notFound"],
  429: ["RESOURCE_EXHAUSTED", "rateLimitExceeded"],
  500: ["INTERNAL", "backendError"],
};

function fakePublisher(postDelete: PostDeleteMode = "observed") {
  const calls = { get: 0, del: 0, other: 0 };
  const events: string[] = [];
  let deleted = false;
  const client = {
    version: "v3",
    reviews: {},
    edits: {
      get: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        calls.get += 1;
        const id = (params as { editId: string }).editId;
        if (!deleted) {
          events.push("edits.get:pre");
          return { data: { id, expiryTimeSeconds } };
        }
        events.push("edits.get:post");
        if (postDelete === "ok") return { data: { id, expiryTimeSeconds } };
        if (postDelete === "reset") {
          throw Object.assign(new Error("PRIVATE-RESET"), { code: "ECONNRESET" });
        }
        const statusCode = postDelete === "observed" ? 400 : postDelete;
        const [status, reason] = GOOGLE_STATUS[statusCode] ?? [
          "FAILED_PRECONDITION",
          "failedPrecondition",
        ];
        throw {
          message: "PRIVATE-UPSTREAM-TEXT",
          status: statusCode,
          code: statusCode,
          response: {
            status: statusCode,
            data: {
              error: {
                code: statusCode,
                status,
                message: "PRIVATE-UPSTREAM-TEXT",
                errors: [{ reason, message: "PRIVATE-UPSTREAM-TEXT" }],
              },
            },
          },
        };
      },
      delete: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        expect((params as { packageName: string }).packageName).toBe(packageName);
        expect((params as { editId: string }).editId).toBeTruthy();
        calls.del += 1;
        deleted = true;
        events.push("edits.delete");
        return { data: {} };
      },
      insert: async () => {
        calls.other += 1;
        throw new Error("edits.insert must not be called");
      },
      commit: async () => {
        calls.other += 1;
        throw new Error("edits.commit must not be called");
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher: client, calls, events };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase415-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            { id: "phase415-call", name: RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME, arguments: {} },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Phase 4.15 finished.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

const managedSession: ReleaseEditSession = {
  version: 1,
  packageName,
  editId,
  expiryTimeSeconds,
  createdAt: fixedNow.toISOString(),
};

const managedCandidate: ReleaseEditCleanupCandidate = {
  recordSource: "managed_session",
  editId,
  expiryTimeSeconds,
};

async function runCleanup(
  options: {
    readonly postDelete?: PostDeleteMode;
    readonly candidate?: ReleaseEditCleanupCandidate;
    readonly session?: ReleaseEditSession;
    readonly journalRecord?: {
      readonly editId: string;
      readonly expiryTimeSeconds: string;
      readonly source:
        "exact_release_verification" | "rollout_verification" | "status_control_verification";
      readonly createdAt: string;
    };
    readonly resolver?: (
      request: ApprovalRequest,
      composition: ReleaseComposition,
    ) => Promise<ApprovalGrant>;
  } = {},
) {
  const dir = makeDir();
  const fake = fakePublisher(options.postDelete ?? "observed");
  const candidate = options.candidate ?? managedCandidate;
  const composition = createReleaseComposition(
    configFor(dir),
    { publisher: fake.publisher, now: () => new Date(fixedNow) },
    { cleanupKnownEdit: { candidate } },
  );
  if (options.session) await composition.store.save(options.session);
  if (options.journalRecord) await composition.cleanupJournal?.record(options.journalRecord);
  const binding = composition.cleanupKnownEditBinding;
  if (!binding) throw new Error("cleanup binding unavailable");
  const resolver = options.resolver
    ? {
        resolve: async (request: ApprovalRequest) => {
          const grant = await options.resolver?.(request, composition);
          if (!grant) throw new Error("resolver returned no grant");
          return grant;
        },
      }
    : undefined;
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "Abandon the exact known Play edit record." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    approvalLedger: composition.ledger,
    ...(resolver ? { approvalResolver: resolver } : {}),
    now: () => fixedNow,
    runId: () => "phase415-runtime-run",
  });
  return { result, composition, fake, dir };
}

function approveAll() {
  return async (request: ApprovalRequest, composition: ReleaseComposition) =>
    approveInteractively(
      request,
      { ask: async () => "yes" },
      {
        ledger: composition.ledger,
        now: () => fixedNow,
      },
    );
}

function denyAll() {
  return async (request: ApprovalRequest, composition: ReleaseComposition) =>
    approveInteractively(
      request,
      { ask: async () => "no" },
      {
        ledger: composition.ledger,
        now: () => fixedNow,
      },
    );
}

describe("Phase 4.15 cleanup through the real Phase 2 runtime", () => {
  it("registers exactly one destructive cleanup tool with empty model input and a real verifier", async () => {
    const run = await runCleanup({ session: managedSession });
    expect(run.composition.registry.has(RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME)).toBe(true);
    expect(run.composition.cleanupKnownEditTool?.permission).toBe("destructive");
    expect(run.composition.cleanupKnownEditTool?.verify).toBeTypeOf("function");
    expect(run.composition.cleanupKnownEditBinding?.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    // No approval resolver: the run stops at the approval gate.
    expect(run.result.code).toBe("APPROVAL_REQUIRED");
    expect(run.fake.calls.get).toBe(0);
    expect(run.fake.calls.del).toBe(0);
  });

  it("denial performs zero reads and zero deletes and retains the record", async () => {
    const run = await runCleanup({ session: managedSession, resolver: denyAll() });
    expect(run.result).toMatchObject({
      ok: false,
      code: "APPROVAL_DENIED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls.get).toBe(0);
    expect(run.fake.calls.del).toBe(0);
    expect(await run.composition.store.load()).toBeDefined();
  });

  it("verifies the exact observed tuple: one delete, exact order, record removed", async () => {
    const run = await runCleanup({ session: managedSession, resolver: approveAll() });
    expect(run.result).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(run.fake.calls.del).toBe(1);
    expect(run.fake.calls.get).toBe(2);
    expect(run.fake.calls.other).toBe(0);
    expect(run.fake.events).toEqual(["edits.get:pre", "edits.delete", "edits.get:post"]);
    expect(await run.composition.store.load()).toBeUndefined();
    const audit = readFileSync(join(run.dir, "audit.jsonl"), "utf8");
    expect(audit).toContain(RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME);
    expect(audit).not.toContain(editId);
    expect(audit).not.toContain("PRIVATE");
  });

  it("does the same for a journalled verification-edit record", async () => {
    const candidate: ReleaseEditCleanupCandidate = {
      recordSource: "cleanup_journal",
      editId: "temporary-edit-1",
      expiryTimeSeconds,
    };
    const run = await runCleanup({
      candidate,
      journalRecord: {
        editId: "temporary-edit-1",
        expiryTimeSeconds,
        source: "exact_release_verification",
        createdAt: fixedNow.toISOString(),
      },
      resolver: approveAll(),
    });
    expect(run.result).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(run.fake.calls.del).toBe(1);
    expect(await run.composition.cleanupJournal?.list()).toEqual([]);
  });

  it("fails closed and retains the record for every unverified post-delete outcome", async () => {
    const modes: readonly PostDeleteMode[] = ["ok", 404, 403, 429, 500, "reset"];
    for (const postDelete of modes) {
      const run = await runCleanup({ session: managedSession, postDelete, resolver: approveAll() });
      expect(run.result.ok).toBe(false);
      expect(run.result.code).toBe("EXECUTION_FAILED");
      expect((run.result.cause as ReleaseError).code).toBe(
        "EDIT_CLEANUP_REMOTE_INACTIVE_UNVERIFIED",
      );
      expect(run.result.externalStateUncertain).toBe(true);
      // Exactly one delete attempt, never retried, and the record is retained.
      expect(run.fake.calls.del).toBe(1);
      expect(run.fake.events.filter((event) => event === "edits.delete")).toHaveLength(1);
      expect(await run.composition.store.load()).toBeDefined();
    }
  });

  it("never issues a delete when the bound record is missing", async () => {
    const run = await runCleanup({ resolver: approveAll() });
    expect(run.result.ok).toBe(false);
    expect(run.result.code).toBe("EXECUTION_FAILED");
    expect((run.result.cause as ReleaseError).code).toBe("EDIT_CLEANUP_RECORD_NOT_FOUND");
    expect(run.fake.calls.get).toBe(0);
    expect(run.fake.calls.del).toBe(0);
  });

  it("never leaks the raw upstream message into the runtime result", async () => {
    const run = await runCleanup({
      session: managedSession,
      postDelete: 403,
      resolver: approveAll(),
    });
    expect(run.result.ok).toBe(false);
    expect(run.result.code).toBe("EXECUTION_FAILED");
    const serialized = JSON.stringify({
      code: run.result.code,
      message: (run.result.cause as Error | undefined)?.message ?? "",
    });
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).toContain("post-delete inactivity was not verified");
  });
});
