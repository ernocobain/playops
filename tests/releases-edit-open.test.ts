import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import {
  createAndroidPublisherClient,
  type AndroidPublisherClient,
} from "../src/googleplay/publisher/index.js";
import {
  createFileAgentLedger,
  runAgent,
  type AgentApprovalResolver,
  type AgentRunResult,
} from "../src/runtime/agent/index.js";
import {
  approveInteractively,
  createFileApprovalLedger,
  type ApprovalGrant,
} from "../src/runtime/approvals/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createAndroidPublisherReleaseGateway } from "../src/releases/androidpublisher.js";
import {
  createReleaseEditOpenDigest,
  createReleaseEditOpenSummary,
  createReleaseEditOpenTool,
  RELEASES_OPEN_EDIT_TOOL_NAME,
} from "../src/releases/open-tool.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import type { ReleaseEditGateway } from "../src/releases/gateway.js";
import type { GooglePlayEditSession, ReleaseEditSession } from "../src/releases/index.js";

interface RequestOptions {
  retry?: boolean;
  method?: string;
  url?: string;
}

const packageName = "com.example.release";
const otherPackageName = "com.example.other";
const fixedNow = 1_800_000_000_000;
const clock = (): Date => new Date(fixedNow);
const secretMarker = "FAKE-SERVICE-ACCOUNT-PRIVATE-KEY";
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeDir(): string {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-edit-open-"));
  return tempDir;
}

function trackedSession(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId: "edit-tracked",
    expiryTimeSeconds: "1900000000",
    createdAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function fakeGateway(
  options: {
    editId?: string;
    expiryTimeSeconds?: string;
    omitExpiry?: boolean;
    createError?: unknown;
  } = {},
) {
  const createEdit = vi.fn(async (): Promise<GooglePlayEditSession> => {
    if (options.createError) throw options.createError;
    return {
      packageName,
      editId: options.editId ?? "edit-created",
      ...(options.omitExpiry
        ? {}
        : { expiryTimeSeconds: options.expiryTimeSeconds ?? "1900000000" }),
    };
  });
  const getEdit = vi.fn(async () => ({
    id: options.editId ?? "edit-created",
    expiryTimeSeconds: options.expiryTimeSeconds ?? "1900000000",
  }));
  const listTracks = vi.fn(async () => []);
  const gateway: ReleaseEditGateway = { createEdit, getEdit, listTracks };
  return { gateway, createEdit, getEdit, listTracks };
}

function storeAt(dir: string, expected: string = packageName): ReleaseEditSessionStore {
  return createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: expected,
  });
}

function scriptedLlm(argumentsValue: unknown = {}): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase42-open",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "c1", name: RELEASES_OPEN_EDIT_TOOL_NAME, arguments: argumentsValue }],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Edit session opened.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

function resolverFor(
  mode: "approved" | "denied" | "mismatched",
  auditPath: string,
  seen: string[] = [],
): AgentApprovalResolver {
  return {
    resolve: async (request) => {
      seen.push(request.safeSummary);
      if (mode === "mismatched") {
        return {
          record: {
            toolName: request.toolName,
            permission: request.permission,
            decision: "approved",
          },
          requestId: request.requestId,
          requestDigest: "0".repeat(64),
          source: "interactive",
        } satisfies ApprovalGrant;
      }
      return approveInteractively(
        request,
        { ask: async () => (mode === "approved" ? "yes" : "no") },
        { ledger: createFileApprovalLedger(auditPath) },
      );
    },
  };
}

async function runOpen(options: {
  dir: string;
  gateway: ReleaseEditGateway;
  resolver?: AgentApprovalResolver;
  seed?: ReleaseEditSession;
  store?: ReleaseEditSessionStore;
}): Promise<{
  result: AgentRunResult;
  auditPath: string;
  store: ReleaseEditSessionStore;
  sessionPath: string;
}> {
  const auditPath = join(options.dir, "audit.jsonl");
  const store = options.store ?? storeAt(options.dir);
  if (options.seed) await store.save(options.seed);
  const built = createReleaseEditOpenTool({
    packageName,
    gateway: options.gateway,
    store,
    now: clock,
  });
  const registry = new ToolRegistry();
  registry.register(built.tool);
  const result = await runAgent({
    llm: scriptedLlm(),
    registry,
    bindings: [built.binding],
    messages: [{ role: "user", content: "Open an edit for the next release." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: createFileAgentLedger(auditPath),
    ...(options.resolver ? { approvalResolver: options.resolver } : {}),
    runId: () => "phase42-open-run",
  });
  return { result, auditPath, store, sessionPath: join(options.dir, "edit-session.json") };
}

describe("releases.open_edit tool contract", () => {
  it("registers as destructive with a real verifier and an empty model-facing input", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: storeAt(dir),
      now: clock,
    });
    const registry = new ToolRegistry();
    registry.register(built.tool);
    const registered = registry.get(RELEASES_OPEN_EDIT_TOOL_NAME);

    expect(registered.permission).toBe("destructive");
    expect(registered.verify).toBeTypeOf("function");
    expect(evaluateToolPermission(registered)).toMatchObject({
      allowed: false,
      code: "APPROVAL_REQUIRED",
      requiresApproval: true,
    });
    expect(registered.description).toContain("may invalidate another edit");
    expect(registered.description).toContain("does NOT publish");
    expect(gateway.createEdit).not.toHaveBeenCalled();
  });

  it("does not expose packageName, editId, session path, credentials, or retry controls to the model", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: storeAt(dir),
      now: clock,
    });

    expect(built.tool.inputSchema.parse({})).toEqual({});
    for (const invalid of [
      null,
      [],
      { packageName: otherPackageName },
      { editId: "attacker-choice" },
      { sessionPath: "/tmp/attacker.json" },
      { force: true },
      { anything: true },
    ]) {
      expect(() => built.tool.inputSchema.parse(invalid)).toThrow();
    }
    const schema = JSON.stringify(built.binding.llm.inputSchema);
    expect(schema).toBe('{"type":"object","properties":{},"additionalProperties":false}');
    expect(schema).not.toMatch(/packageName|editId|path|credential|retry|force|replace|overwrite/u);
  });

  it("states app identity, edit invalidation risk, and no commit in the safe summary", () => {
    const summary = createReleaseEditOpenSummary(packageName);
    expect(summary).toContain(packageName);
    expect(summary).toContain("WARNING");
    expect(summary).toContain("may invalidate another active edit owned by this API user");
    expect(summary).toContain("does NOT publish or commit a release");
    expect(summary).not.toMatch(/token|secret|credential|password/iu);
  });

  it("binds a deterministic package-scoped SHA-256 digest with no secret material", () => {
    const digest = createReleaseEditOpenDigest(packageName);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(createReleaseEditOpenDigest(packageName)).toBe(digest);
    expect(createReleaseEditOpenDigest(otherPackageName)).not.toBe(digest);
    expect(digest).not.toContain(secretMarker);
    expect(createReleaseEditOpenDigest(packageName)).not.toContain(packageName);
  });
});

describe("releases.open_edit approval enforcement through the real Phase 2 runtime", () => {
  it("25. refuses without any approval resolver and never creates an edit", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const { result, store } = await runOpen({ dir, gateway });

    expect(result).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(gateway.createEdit).not.toHaveBeenCalled();
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("26. refuses a denied approval and never creates an edit", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const { result, auditPath } = await runOpen({
      dir,
      gateway,
      resolver: resolverFor("denied", join(dir, "audit.jsonl")),
    });

    expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(gateway.createEdit).not.toHaveBeenCalled();
    expect(readAuditEntries(auditPath).some((entry) => entry.type === "approval.denied")).toBe(
      true,
    );
  });

  it("27. refuses an approval bound to a different request digest", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const { result } = await runOpen({
      dir,
      gateway,
      resolver: resolverFor("mismatched", join(dir, "audit.jsonl")),
    });

    expect(result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(gateway.createEdit).not.toHaveBeenCalled();
  });

  it("28/30-34. executes exactly one insert under exact approval, persists the session, and verifies it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network forbidden in test"))),
    );
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const seen: string[] = [];
    const { result, auditPath, sessionPath } = await runOpen({
      dir,
      gateway,
      resolver: resolverFor("approved", join(dir, "audit.jsonl"), seen),
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Edit session opened.");
    expect(gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(gateway.getEdit).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(readFileSync(sessionPath, "utf8")) as ReleaseEditSession;
    expect(persisted).toEqual({
      version: 1,
      packageName,
      editId: "edit-created",
      expiryTimeSeconds: "1900000000",
      createdAt: new Date(fixedNow).toISOString(),
    });

    const audit = readAuditEntries(auditPath);
    const types = audit.map((entry) => entry.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("approval.approved");
    expect(
      audit.some((entry) => entry.type === "verification.completed" && entry.status === "success"),
    ).toBe(true);
    const auditText = readFileSync(auditPath, "utf8");
    expect(auditText).toContain("VERIFIED");
    expect(auditText).not.toContain("edit-created");
    expect(auditText).not.toContain(secretMarker);
    expect(seen[0]).toContain("may invalidate another active edit");
  });

  it("29. refuses when an active local session exists, even with valid approval", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const { result, sessionPath } = await runOpen({
      dir,
      gateway,
      resolver: resolverFor("approved", join(dir, "audit.jsonl")),
      seed: trackedSession(),
    });

    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(gateway.createEdit).not.toHaveBeenCalled();
    expect(gateway.getEdit).not.toHaveBeenCalled();
    expect((JSON.parse(readFileSync(sessionPath, "utf8")) as ReleaseEditSession).editId).toBe(
      "edit-tracked",
    );
  });

  it("46. allows an expired tracked session to be replaced only by a new explicit approval", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway({ editId: "edit-refreshed", expiryTimeSeconds: "1900009999" });
    const { result, sessionPath } = await runOpen({
      dir,
      gateway,
      resolver: resolverFor("approved", join(dir, "audit.jsonl")),
      seed: trackedSession({ expiryTimeSeconds: "1700000000" }),
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(gateway.createEdit).toHaveBeenCalledTimes(1);
    expect((JSON.parse(readFileSync(sessionPath, "utf8")) as ReleaseEditSession).editId).toBe(
      "edit-refreshed",
    );
  });
});

describe("releases.open_edit insert semantics", () => {
  async function executeWith(gateway: ReleaseEditGateway, store?: ReleaseEditSessionStore) {
    const dir = makeDir();
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: store ?? storeAt(dir),
      now: clock,
    });
    return { execute: () => built.tool.execute({}, {}), dir };
  }

  it("35-38. makes exactly one insert attempt for 429, 500, and transport ambiguity", async () => {
    for (const failure of [
      Object.assign(new Error("FAKE-429"), { status: 429 }),
      Object.assign(new Error("FAKE-500"), { status: 500 }),
      new Error("FAKE-TRANSPORT-AMBIGUITY"),
    ]) {
      const insert = vi.fn(async () => {
        throw failure;
      });
      const client = {
        version: "v3",
        reviews: {},
        edits: { insert, get: vi.fn(), tracks: { list: vi.fn() } },
      } as unknown as AndroidPublisherClient;
      const gateway = createAndroidPublisherReleaseGateway(client, packageName);
      const { execute } = await executeWith(gateway);

      await expect(execute()).rejects.toMatchObject({ code: "EDIT_CREATE_FAILED" });
      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledWith({ packageName }, { retry: false });
    }
  });

  it("35. keeps a real generated Edits insert to a single POST attempt on 429", async () => {
    const requests: (RequestOptions | undefined)[] = [];
    const auth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TEST-TOKEN" }),
      request: (options: RequestOptions) => {
        requests.push({ retry: options.retry, method: options.method, url: options.url });
        return Promise.reject(Object.assign(new Error("transient"), { status: 429 }));
      },
    };
    const gateway = createAndroidPublisherReleaseGateway(
      createAndroidPublisherClient(auth),
      packageName,
    );

    await expect(gateway.createEdit()).rejects.toMatchObject({ code: "EDIT_CREATE_FAILED" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ retry: false, method: "POST" });
    expect(requests[0]?.url).toContain("/applications/com.example.release/edits");
  });

  it("39. fails safely on a malformed insert response without retrying or claiming success", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway({ omitExpiry: true });
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: storeAt(dir),
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({ code: "EDIT_INVALID" });
    expect(gateway.createEdit).toHaveBeenCalledTimes(1);
    await expect(storeAt(dir).load()).resolves.toBeUndefined();
  });

  it("40. reports a safe failure when the insert succeeded but the local save failed", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const real = storeAt(dir);
    const failingStore: ReleaseEditSessionStore = {
      load: () => real.load(),
      save: () => Promise.reject(new Error("FAKE-DISK-FULL")),
      clear: () => real.clear(),
    };
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: failingStore,
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_WRITE_FAILED",
    });
    expect(gateway.createEdit).toHaveBeenCalledTimes(1);
    await expect(real.load()).resolves.toBeUndefined();
  });

  it("fails safely on a corrupt tracked store instead of replacing it", async () => {
    const dir = makeDir();
    mkdirSync(join(dir, "nested"), { recursive: true });
    const path = join(dir, "nested", "edit-session.json");
    writeFileSync(path, "{ broken", "utf8");
    const { gateway } = fakeGateway();
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: createFileReleaseEditSessionStore(path, { expectedPackageName: packageName }),
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_STORE_INVALID",
    });
    expect(gateway.createEdit).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });

  it("fails verification when the local session is not tracked even though the remote edit exists", async () => {
    const dir = makeDir();
    const { gateway } = fakeGateway();
    const real = storeAt(dir);
    const amnesiacStore: ReleaseEditSessionStore = {
      load: () => Promise.resolve(undefined),
      save: (session) => real.save(session),
      clear: () => real.clear(),
    };
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: amnesiacStore,
      now: clock,
    });

    const verify = built.tool.verify;
    expect(verify).toBeTypeOf("function");
    if (!verify) throw new Error("open_edit must declare a verifier");
    const output = await built.tool.execute({}, {});
    await expect(verify({}, output, {})).resolves.toBe(false);
  });

  it("fails verification when the remote expiry disagrees with the persisted session", async () => {
    const dir = makeDir();
    const insertEdit = fakeGateway();
    const gateway: ReleaseEditGateway = {
      createEdit: insertEdit.createEdit,
      getEdit: vi.fn(async () => ({ id: "edit-created", expiryTimeSeconds: "1900000001" })),
      listTracks: insertEdit.listTracks,
    };
    const built = createReleaseEditOpenTool({
      packageName,
      gateway,
      store: storeAt(dir),
      now: clock,
    });

    const verify = built.tool.verify;
    expect(verify).toBeTypeOf("function");
    if (!verify) throw new Error("open_edit must declare a verifier");
    const output = await built.tool.execute({}, {});
    await expect(verify({}, output, {})).resolves.toBe(false);
  });
});
