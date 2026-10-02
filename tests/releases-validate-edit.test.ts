import { describe, expect, it, vi } from "vitest";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import type { ReleaseEditReadback, ReleaseEditValidationGateway } from "../src/releases/gateway.js";
import {
  createReleaseEditValidationTool,
  RELEASES_VALIDATE_EDIT_TOOL_NAME,
  type EditValidationToolOptions,
} from "../src/releases/validate-edit-tool.js";
import type { ReleaseEditSession } from "../src/releases/index.js";

const packageName = "com.example.release";
const editId = "edit-phase48";
const expiryTimeSeconds = "1900000000";
const now = () => new Date("2026-09-29T04:00:00.000Z");

function session(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function storeWith(value: ReleaseEditSession | undefined): ReleaseEditSessionStore & {
  readonly saves: number;
} {
  let saves = 0;
  return {
    get saves() {
      return saves;
    },
    load: vi.fn(async () => value),
    save: vi.fn(async () => {
      saves += 1;
    }),
    clear: vi.fn(async () => undefined),
  };
}

function makeGateway(
  options: {
    readonly remoteEdit?: ReleaseEditReadback;
    readonly validationResult?: ReleaseEditReadback;
    readonly getEditError?: unknown;
    readonly validateEditError?: unknown;
  } = {},
): {
  readonly gateway: ReleaseEditValidationGateway;
  readonly counts: { getEdit: number; validateEdit: number };
} {
  const counts = { getEdit: 0, validateEdit: 0 };
  const gateway: ReleaseEditValidationGateway = {
    getEdit: vi.fn(async () => {
      counts.getEdit += 1;
      if (options.getEditError !== undefined) throw options.getEditError;
      return options.remoteEdit ?? { id: editId, expiryTimeSeconds };
    }),
    validateEdit: vi.fn(async () => {
      counts.validateEdit += 1;
      if (options.validateEditError !== undefined) throw options.validateEditError;
      return options.validationResult ?? { id: editId, expiryTimeSeconds };
    }),
  };
  return { gateway, counts };
}

function makeOptions(
  overrides: Partial<EditValidationToolOptions> = {},
): EditValidationToolOptions {
  const built = makeGateway();
  return {
    packageName,
    sessionStore: storeWith(session()),
    gateway: built.gateway,
    now,
    ...overrides,
  };
}

describe("Phase 4.8 validate-edit tool contract", () => {
  it("uses releases.validate_edit, permission read, no verifier, no approval, and empty input", () => {
    const composed = createReleaseEditValidationTool(makeOptions());
    expect(composed.tool.name).toBe(RELEASES_VALIDATE_EDIT_TOOL_NAME);
    expect(composed.tool.permission).toBe("read");
    expect(composed.tool.verify).toBeUndefined();
    expect(composed.binding.approval).toBeUndefined();
    expect(composed.binding.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(composed.tool.inputSchema.parse({})).toEqual({});
    expect(() => composed.tool.inputSchema.parse({ packageName })).toThrow();
  });

  it("returns a normalized success result and does not write the session", async () => {
    const store = storeWith(session());
    const built = makeGateway();
    const composed = createReleaseEditValidationTool(
      makeOptions({ sessionStore: store, gateway: built.gateway }),
    );
    const output = await composed.tool.execute({}, Object.freeze({}));

    expect(output).toEqual({ valid: true, expiryTimeSeconds });
    expect(store.saves).toBe(0);
    expect(built.counts).toEqual({ getEdit: 1, validateEdit: 1 });
  });

  it("serializes only safe normalized validation state after read verification is skipped", async () => {
    const composed = createReleaseEditValidationTool(makeOptions());
    const output = await composed.tool.execute({}, Object.freeze({}));
    const serialized = composed.binding.serializeResult(output, {
      toolName: RELEASES_VALIDATE_EDIT_TOOL_NAME,
      permission: "read",
      required: false,
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      verified: false,
    });

    expect(JSON.parse(serialized)).toEqual({ valid: true, expiryTimeSeconds });
    expect(serialized).not.toContain(editId);
    expect(serialized).not.toContain("raw");
    expect(() =>
      composed.tool.outputSchema.parse({ valid: true, expiryTimeSeconds, raw: "x" }),
    ).toThrow();
  });
});

describe("Phase 4.8 managed-session preflight", () => {
  it.each([
    { label: "missing session", sessionValue: undefined, code: "EDIT_SESSION_REQUIRED" },
    {
      label: "expired session",
      sessionValue: session({ expiryTimeSeconds: "1" }),
      code: "EDIT_SESSION_EXPIRED",
    },
    {
      label: "package mismatch",
      sessionValue: session({ packageName: "com.example.other" }),
      code: "EDIT_SESSION_PACKAGE_MISMATCH",
    },
  ])("blocks $label without validation", async ({ sessionValue, code }) => {
    const built = makeGateway();
    const composed = createReleaseEditValidationTool(
      makeOptions({ sessionStore: storeWith(sessionValue), gateway: built.gateway }),
    );

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({ code });
    expect(built.counts.validateEdit).toBe(0);
  });

  it("blocks a remote edit id/expiry mismatch before validation", async () => {
    const built = makeGateway({ remoteEdit: { id: "other-edit", expiryTimeSeconds } });
    const composed = createReleaseEditValidationTool(makeOptions({ gateway: built.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
    });
    expect(built.counts.validateEdit).toBe(0);
  });

  it("blocks an expired remote edit before validation", async () => {
    const built = makeGateway({ remoteEdit: { id: editId, expiryTimeSeconds: "1" } });
    const composed = createReleaseEditValidationTool(makeOptions({ gateway: built.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
    });
    expect(built.counts.validateEdit).toBe(0);
  });
});

describe("Phase 4.8 validation response and failure handling", () => {
  it("rejects a mismatched validation response id", async () => {
    const built = makeGateway({
      validationResult: { id: "edit-other", expiryTimeSeconds },
    });
    const composed = createReleaseEditValidationTool(makeOptions({ gateway: built.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "VALIDATION_RESPONSE_MISMATCH",
      externalStateUncertain: false,
    });
    expect(built.counts.validateEdit).toBe(1);
  });

  it.each([
    { label: "missing expiry", result: { id: editId } },
    { label: "malformed expiry", result: { id: editId, expiryTimeSeconds: "bad" } },
    { label: "expired expiry", result: { id: editId, expiryTimeSeconds: "1" } },
  ])("rejects $label validation response", async ({ result }) => {
    const built = makeGateway({ validationResult: result });
    const composed = createReleaseEditValidationTool(makeOptions({ gateway: built.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code:
        result.expiryTimeSeconds === "1"
          ? "EDIT_VALIDATION_EXPIRED"
          : "VALIDATION_RESPONSE_INVALID",
      externalStateUncertain: false,
    });
  });

  it("surfaces an explicit Google validation rejection and blocks continuation", async () => {
    const built = makeGateway({
      validateEditError: new Error("PRIVATE-GOOGLE-DIAGNOSTIC"),
    });
    const composed = createReleaseEditValidationTool(makeOptions({ gateway: built.gateway }));

    await expect(composed.tool.execute({}, Object.freeze({}))).rejects.toMatchObject({
      code: "EDIT_VALIDATION_FAILED",
      externalStateUncertain: false,
    });
    expect(built.counts.validateEdit).toBe(1);
  });

  it("does not call any edit/track/bundle mutation through the narrow gateway", async () => {
    const built = makeGateway();
    const composed = createReleaseEditValidationTool(makeOptions({ gateway: built.gateway }));
    await composed.tool.execute({}, Object.freeze({}));

    expect(built.gateway).not.toHaveProperty("updateTrack");
    expect(built.gateway).not.toHaveProperty("uploadBundle");
    expect(built.gateway).not.toHaveProperty("createEdit");
  });
});
