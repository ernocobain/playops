import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as agentModule from "../src/runtime/agent/index.js";
import * as approvalsModule from "../src/runtime/approvals/index.js";
import * as permissionsModule from "../src/runtime/permissions/index.js";
import * as verificationModule from "../src/runtime/verification/index.js";
import { ToolRegistry, TOOL_PERMISSION_LEVELS } from "../src/runtime/tools/index.js";
import {
  BROWSER_FALLBACK_REASON_CODES,
  BrowserFallbackError,
  createBrowserCapabilitySet,
  evaluateBrowserFallbackEligibility,
  executeBrowserFallback,
  type BrowserCapability,
  type BrowserFallbackAdapter,
  type BrowserFallbackReason,
  type BrowserFallbackRequest,
  type BrowserFallbackResult,
} from "../src/runtime/browser/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const READ_CAP: BrowserCapability = {
  name: "page.read",
  description: "Read a logical page",
  permission: "read",
};
const WRITE_CAP: BrowserCapability = {
  name: "form.fill",
  description: "Fill a logical form",
  permission: "write",
};
const DESTRUCTIVE_CAP: BrowserCapability = {
  name: "record.delete",
  description: "Delete a logical record",
  permission: "destructive",
};
const PUBLISH_CAP: BrowserCapability = {
  name: "button.click",
  description: "Click a logical publish button",
  permission: "publish",
};

const GAP_REASON: BrowserFallbackReason = {
  code: "API_CAPABILITY_GAP",
  description: "Official API does not expose the state.",
  apiGap: "Documented gap: androidpublisher lacks endpoint X for state Y.",
};

const READ_REQUEST: BrowserFallbackRequest = {
  capability: "page.read",
  reason: GAP_REASON,
  target: "console.review.detail",
  permission: "read",
};

function fakeAdapter(
  capabilities: readonly BrowserCapability[],
  execute?: BrowserFallbackAdapter["execute"],
): BrowserFallbackAdapter & { readonly calls: BrowserFallbackRequest[] } {
  const calls: BrowserFallbackRequest[] = [];
  return {
    provider: "fake-browser",
    calls,
    capabilities: () => capabilities,
    execute:
      execute ??
      (async (request) => {
        calls.push(request);
        return { status: "completed", verified: false };
      }),
  };
}

describe("browser fallback — capability declaration", () => {
  it.each([
    ["read", READ_CAP],
    ["write", WRITE_CAP],
    ["destructive", DESTRUCTIVE_CAP],
    ["publish", PUBLISH_CAP],
  ] as const)("adapter may declare %s capability", (level, cap) => {
    const set = createBrowserCapabilitySet([cap]);
    expect(set.get(cap.name)?.permission).toBe(level);
    expect(TOOL_PERMISSION_LEVELS).toContain(level);
  });

  it("unsupported/invalid permission fails closed", () => {
    expect(() =>
      createBrowserCapabilitySet([{ ...READ_CAP, permission: "admin" as never }]),
    ).toThrow(BrowserFallbackError);
    try {
      createBrowserCapabilitySet([{ ...READ_CAP, permission: "" as never }]);
    } catch (error) {
      expect((error as BrowserFallbackError).code).toBe("INVALID_REQUEST");
    }
  });

  it.each([
    ["blank name", { ...READ_CAP, name: " " }],
    ["invalid name grammar", { ...READ_CAP, name: "Page-Read" }],
    ["blank description", { ...READ_CAP, description: "" }],
    ["non-object", null as never],
  ])("rejects capability with %s", (_label, cap) => {
    expect(() => createBrowserCapabilitySet([cap])).toThrow(BrowserFallbackError);
  });

  it("duplicate capability names rejected", () => {
    expect(() =>
      createBrowserCapabilitySet([READ_CAP, { ...READ_CAP, permission: "write" }]),
    ).toThrow(/duplicate/i);
  });

  it("does not create a second permission enum — reuses ToolPermissionLevel values only", () => {
    const source = readFileSync(join(ROOT, "src/runtime/browser/index.ts"), "utf8");
    expect(source).toMatch(/from "\.\.\/tools\/index\.js"/);
    expect(source).not.toMatch(/BROWSER_PERMISSION/);
  });
});

describe("browser fallback — reason policy", () => {
  it("exposes exactly the two API-gap reason codes", () => {
    expect([...BROWSER_FALLBACK_REASON_CODES]).toEqual(["API_UNAVAILABLE", "API_CAPABILITY_GAP"]);
    expect(Object.isFrozen(BROWSER_FALLBACK_REASON_CODES)).toBe(true);
  });

  it.each(["API_UNAVAILABLE", "API_CAPABILITY_GAP"] as const)(
    "%s with explicit apiGap may be eligible",
    (code) => {
      const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), {
        ...READ_REQUEST,
        reason: { ...GAP_REASON, code },
      });
      expect(decision).toEqual({
        eligible: true,
        code: "ELIGIBLE",
        provider: "fake-browser",
        capability: "page.read",
        permission: "read",
        reasonCode: code,
      });
      expect(Object.isFrozen(decision)).toBe(true);
    },
  );

  it.each(["", "   ", "\n"])("blank apiGap %j rejected", (apiGap) => {
    const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), {
      ...READ_REQUEST,
      reason: { ...GAP_REASON, apiGap },
    });
    expect(decision.eligible).toBe(false);
    expect(decision.code).toBe("API_GAP_UNDOCUMENTED");
  });

  it.each([
    ["unsupported reason code", "SOMETHING_ELSE"],
    ["'browser is easier'", "BROWSER_EASIER"],
    ["'API inconvenient'", "API_INCONVENIENT"],
    ["LLM/model request alone", "MODEL_REQUESTED_BROWSER"],
    ["lowercase api_unavailable", "api_unavailable"],
    ["empty code", ""],
  ])("%s cannot authorize fallback", (_label, code) => {
    const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), {
      ...READ_REQUEST,
      reason: { ...GAP_REASON, code: code as never },
    });
    expect(decision.eligible).toBe(false);
    expect(decision.code).toBe("REASON_NOT_RECOGNIZED");
  });

  it("a valid code with a description claiming convenience still requires a nonblank apiGap", () => {
    const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), {
      ...READ_REQUEST,
      reason: { code: "API_UNAVAILABLE", description: "browser is easier", apiGap: "" },
    });
    expect(decision.eligible).toBe(false);
  });
});

describe("browser fallback — capability matching", () => {
  it("requested capability must exist (unknown capability denied)", () => {
    const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), {
      ...READ_REQUEST,
      capability: "page.screenshot",
    });
    expect(decision).toMatchObject({ eligible: false, code: "CAPABILITY_UNSUPPORTED" });
  });

  it("capability permission must exactly match request (mismatch denied)", () => {
    const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), {
      ...READ_REQUEST,
      permission: "write",
    });
    expect(decision).toMatchObject({ eligible: false, code: "PERMISSION_MISMATCH" });
  });

  it("a read request cannot borrow a higher-permission capability and vice versa", () => {
    const adapter = fakeAdapter([WRITE_CAP]);
    expect(
      evaluateBrowserFallbackEligibility(adapter, {
        ...READ_REQUEST,
        capability: "form.fill",
        permission: "read",
      }).code,
    ).toBe("PERMISSION_MISMATCH");
    expect(
      evaluateBrowserFallbackEligibility(adapter, {
        ...READ_REQUEST,
        capability: "form.fill",
        permission: "publish",
      }).code,
    ).toBe("PERMISSION_MISMATCH");
  });

  it("matching write/destructive/publish requests are eligible at the policy level (execution gating is future work)", () => {
    const adapter = fakeAdapter([WRITE_CAP, DESTRUCTIVE_CAP, PUBLISH_CAP]);
    for (const cap of [WRITE_CAP, DESTRUCTIVE_CAP, PUBLISH_CAP]) {
      const decision = evaluateBrowserFallbackEligibility(adapter, {
        ...READ_REQUEST,
        capability: cap.name,
        permission: cap.permission,
      });
      expect(decision.eligible).toBe(true);
    }
  });

  it("adapter declaring invalid capabilities is ineligible (fail closed, no throw)", () => {
    const decision = evaluateBrowserFallbackEligibility(
      fakeAdapter([READ_CAP, { ...READ_CAP, permission: "write" }]),
      READ_REQUEST,
    );
    expect(decision).toMatchObject({ eligible: false, code: "ADAPTER_INVALID" });
  });

  it("malformed request is ineligible (fail closed, no throw)", () => {
    for (const request of [
      { ...READ_REQUEST, capability: "" },
      { ...READ_REQUEST, target: "  " },
      { ...READ_REQUEST, permission: "root" as never },
      { ...READ_REQUEST, reason: null as never },
      null as never,
    ]) {
      const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), request);
      expect(decision).toMatchObject({ eligible: false, code: "INVALID_REQUEST" });
    }
  });
});

describe("browser fallback — API failures never qualify", () => {
  it.each([
    ["HTTP 429", "HTTP_429"],
    ["HTTP 500", "HTTP_500"],
    ["timeout", "TIMEOUT"],
    ["Play Console 403 / setup failure", "HTTP_403_PERMISSION_DENIED"],
    ["API_ERROR", "API_ERROR"],
    ["TRANSIENT_FAILURE", "TRANSIENT_FAILURE"],
  ])("%s reason cannot qualify as a capability gap", (label, code) => {
    const decision = evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), {
      ...READ_REQUEST,
      reason: {
        code: code as never,
        description: `${label} while calling the official API`,
        apiGap: `${label} occurred`,
      },
    });
    expect(decision.eligible).toBe(false);
    expect(decision.code).toBe("REASON_NOT_RECOGNIZED");
  });

  it("an operational failure described under a valid code is still only as strong as its documented apiGap (policy note: reviewers must reject)", () => {
    // The policy function cannot read intent; it enforces structure. This test documents that
    // the recognized code list itself excludes every operational-failure code.
    for (const code of BROWSER_FALLBACK_REASON_CODES) {
      expect(code).not.toMatch(/HTTP|TIMEOUT|429|500|403|ERROR|FAIL/);
    }
  });
});

describe("browser fallback — adapter execution boundary", () => {
  it("fake eligible read request may execute through the adapter contract", async () => {
    const adapter = fakeAdapter([READ_CAP]);
    const result = await executeBrowserFallback(adapter, READ_REQUEST);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toEqual(READ_REQUEST);
    expect(result).toEqual({
      status: "completed",
      provider: "fake-browser",
      capability: "page.read",
      permission: "read",
      verified: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fake adapter completion is normalized — provider/capability come from PlayOps, not the adapter", async () => {
    const adapter = fakeAdapter([READ_CAP], async () => ({
      status: "completed",
      verified: true,
      provider: "spoofed",
      capability: "other.cap",
      html: "<html>secret</html>",
    }));
    const result = await executeBrowserFallback(adapter, READ_REQUEST);
    expect(result).toEqual({
      status: "completed",
      provider: "fake-browser",
      capability: "page.read",
      permission: "read",
      verified: true,
    });
    expect(Object.keys(result)).not.toContain("html");
  });

  it("fake unsupported result normalized", async () => {
    const adapter = fakeAdapter([READ_CAP], async () => ({
      status: "unsupported",
      verified: false,
    }));
    const result = await executeBrowserFallback(adapter, READ_REQUEST);
    expect(result.status).toBe("unsupported");
    expect(result.verified).toBe(false);
  });

  it("adapter reporting completed with verified=true for a mutation is preserved as metadata only (no verification performed)", async () => {
    const adapter = fakeAdapter([WRITE_CAP], async () => ({ status: "completed", verified: true }));
    const result = await executeBrowserFallback(adapter, {
      ...READ_REQUEST,
      capability: "form.fill",
      permission: "write",
    });
    expect(result.verified).toBe(true);
  });

  it("fake adapter failure becomes safe typed failure; raw thrown message not exposed", async () => {
    const SECRET = "SESSION_COOKIE=abc123-should-never-appear";
    const adapter = fakeAdapter([READ_CAP], async () => {
      throw new Error(SECRET);
    });
    let caught: unknown;
    try {
      await executeBrowserFallback(adapter, READ_REQUEST);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserFallbackError);
    const err = caught as BrowserFallbackError;
    expect(err.code).toBe("ADAPTER_FAILURE");
    expect(err.message).not.toContain(SECRET);
    expect(String(err)).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it.each([
    ["non-object", "done"],
    ["unknown status", { status: "partial", verified: false }],
    ["non-boolean verified", { status: "completed", verified: "yes" }],
    ["missing verified", { status: "completed" }],
    ["null", null],
  ])("malformed adapter result (%s) becomes ADAPTER_FAILURE", async (_label, value) => {
    const adapter = fakeAdapter([READ_CAP], async () => value as never);
    await expect(executeBrowserFallback(adapter, READ_REQUEST)).rejects.toMatchObject({
      code: "ADAPTER_FAILURE",
    });
  });

  it("failed status from adapter is a normal result, not an exception", async () => {
    const adapter = fakeAdapter([READ_CAP], async () => ({ status: "failed", verified: false }));
    const result = await executeBrowserFallback(adapter, READ_REQUEST);
    expect(result.status).toBe("failed");
  });

  it("ineligible request throws FALLBACK_NOT_ELIGIBLE and never calls the adapter", async () => {
    const adapter = fakeAdapter([READ_CAP]);
    await expect(
      executeBrowserFallback(adapter, { ...READ_REQUEST, capability: "nope.cap" }),
    ).rejects.toMatchObject({
      code: "FALLBACK_NOT_ELIGIBLE",
      decisionCode: "CAPABILITY_UNSUPPORTED",
    });
    await expect(
      executeBrowserFallback(adapter, {
        ...READ_REQUEST,
        reason: { code: "HTTP_500" as never, description: "x", apiGap: "y" },
      }),
    ).rejects.toMatchObject({ code: "FALLBACK_NOT_ELIGIBLE" });
    expect(adapter.calls).toHaveLength(0);
  });

  it("capabilities() is consulted per execution and adapter cannot be executed with a stale list", async () => {
    let caps: readonly BrowserCapability[] = [READ_CAP];
    const adapter = fakeAdapter([], async () => ({ status: "completed", verified: false }));
    const dynamic: BrowserFallbackAdapter = { ...adapter, capabilities: () => caps };
    await expect(executeBrowserFallback(dynamic, READ_REQUEST)).resolves.toMatchObject({
      status: "completed",
    });
    caps = [];
    await expect(executeBrowserFallback(dynamic, READ_REQUEST)).rejects.toMatchObject({
      code: "FALLBACK_NOT_ELIGIBLE",
    });
  });
});

describe("browser fallback — separation from other runtime modules", () => {
  it("no ToolRegistry registration occurs", async () => {
    const registerSpy = vi.spyOn(ToolRegistry.prototype, "register");
    const adapter = fakeAdapter([READ_CAP]);
    evaluateBrowserFallbackEligibility(adapter, READ_REQUEST);
    await executeBrowserFallback(adapter, READ_REQUEST);
    expect(registerSpy).not.toHaveBeenCalled();
    registerSpy.mockRestore();
  });

  it("permission engine, approvals, verification, and agent loop are not invoked", async () => {
    const spies = [
      vi.spyOn(permissionsModule, "evaluateToolPermission"),
      vi.spyOn(approvalsModule, "createApprovalRequest"),
      vi.spyOn(approvalsModule, "resolveApprovalToken"),
      vi.spyOn(approvalsModule, "approveInteractively"),
      vi.spyOn(verificationModule, "verifyToolOutcome"),
      vi.spyOn(agentModule, "runAgent"),
    ];
    const adapter = fakeAdapter([WRITE_CAP]);
    await executeBrowserFallback(adapter, {
      ...READ_REQUEST,
      capability: "form.fill",
      permission: "write",
    });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("module imports only the tools contract — no permissions/approvals/verification/agent/audit/googleplay/llm", () => {
    const source = readFileSync(join(ROOT, "src/runtime/browser/index.ts"), "utf8");
    const imports = [...source.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../tools/index.js"]);
  });

  it("agent loop source does not reference the browser module (no automatic API→browser fallback)", () => {
    const agentSource = readFileSync(join(ROOT, "src/runtime/agent/index.ts"), "utf8");
    expect(agentSource).not.toMatch(/browser/i);
  });
});

describe("browser fallback — security posture", () => {
  it("result exposes only the allowlisted generic fields", async () => {
    const adapter = fakeAdapter([READ_CAP], async () => ({
      status: "completed",
      verified: false,
      cookies: "a=b",
      headers: { authorization: "Bearer x" },
      screenshot: "base64...",
      dom: "<div/>",
      requestLog: [],
      content: "page text",
    }));
    const result = await executeBrowserFallback(adapter, READ_REQUEST);
    expect(Object.keys(result).sort()).toEqual(
      ["capability", "permission", "provider", "status", "verified"].sort(),
    );
  });

  it("no credential/session/URL/selector/cookie concept exists in the public types or source", () => {
    const source = readFileSync(join(ROOT, "src/runtime/browser/index.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    );
    for (const forbidden of [
      /password/i,
      /username/i,
      /cookie/i,
      /session/i,
      /oauth/i,
      /token/i,
      /credential/i,
      /profile/i,
      /selector/i,
      /\burl\b/i,
      /\bhtml\b/i,
      /screenshot/i,
      /\bdom\b/i,
      /cdp/i,
      /devtools/i,
      /playwright/i,
      /puppeteer/i,
      /selenium/i,
      /chromium/i,
      /fetch\(/,
      /http/i,
      /node:/,
      /googleplay/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it("generic request requires only capability, reason, target, permission", () => {
    const request: BrowserFallbackRequest = {
      capability: "page.read",
      reason: GAP_REASON,
      target: "logical.id",
      permission: "read",
    };
    expect(evaluateBrowserFallbackEligibility(fakeAdapter([READ_CAP]), request).eligible).toBe(
      true,
    );
  });

  it("no browser dependency exists in package.json or lockfile", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lock = readFileSync(join(ROOT, "package-lock.json"), "utf8");
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const bad of [
      "playwright",
      "puppeteer",
      "selenium-webdriver",
      "chromium",
      "browser-use",
      "jev",
    ]) {
      expect(names).not.toContain(bad);
      expect(lock).not.toMatch(new RegExp(`"node_modules/${bad}`));
    }
  });

  it("no network call occurs during evaluation or fake execution", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network forbidden in Phase 2.7 tests");
    });
    const adapter = fakeAdapter([READ_CAP]);
    evaluateBrowserFallbackEligibility(adapter, READ_REQUEST);
    await executeBrowserFallback(adapter, READ_REQUEST);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("browser fallback — immutability & determinism", () => {
  it("capability input not mutated", () => {
    const caps = [{ ...READ_CAP }, { ...WRITE_CAP }];
    const snapshot = JSON.stringify(caps);
    const set = createBrowserCapabilitySet(caps);
    expect(JSON.stringify(caps)).toBe(snapshot);
    expect(Object.isFrozen(set.get("page.read"))).toBe(true);
    expect(set.get("page.read")).not.toBe(caps[0]);
  });

  it("request and reason not mutated", async () => {
    const reason = { ...GAP_REASON };
    const request = { ...READ_REQUEST, reason };
    const snapshot = JSON.stringify(request);
    const adapter = fakeAdapter([READ_CAP]);
    evaluateBrowserFallbackEligibility(adapter, request);
    await executeBrowserFallback(adapter, request);
    expect(JSON.stringify(request)).toBe(snapshot);
    expect(request.reason).toBe(reason);
  });

  it("eligibility result deterministic across repeated calls", () => {
    const adapter = fakeAdapter([READ_CAP]);
    const a = evaluateBrowserFallbackEligibility(adapter, READ_REQUEST);
    const b = evaluateBrowserFallbackEligibility(adapter, READ_REQUEST);
    expect(a).toEqual(b);
    const c = evaluateBrowserFallbackEligibility(adapter, { ...READ_REQUEST, capability: "x.y" });
    const d = evaluateBrowserFallbackEligibility(adapter, { ...READ_REQUEST, capability: "x.y" });
    expect(c).toEqual(d);
  });

  it("adapter capability list cannot mutate internal state", () => {
    const set = createBrowserCapabilitySet([READ_CAP]);
    const list = set.list();
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => {
      (list as BrowserCapability[]).push(WRITE_CAP);
    }).toThrow();
    expect(set.list()).toHaveLength(1);
    expect(set.get("form.fill")).toBeUndefined();
  });

  it("adapter metadata (provider) is read, never written", async () => {
    const adapter = fakeAdapter([READ_CAP]);
    const before = adapter.provider;
    await executeBrowserFallback(adapter, READ_REQUEST);
    expect(adapter.provider).toBe(before);
  });

  it("blank provider is rejected as ADAPTER_INVALID", () => {
    const adapter = { ...fakeAdapter([READ_CAP]), provider: " " };
    expect(evaluateBrowserFallbackEligibility(adapter, READ_REQUEST)).toMatchObject({
      eligible: false,
      code: "ADAPTER_INVALID",
    });
  });
});

describe("browser fallback — typed error", () => {
  it("has a small closed code set", () => {
    const err = new BrowserFallbackError("INVALID_REQUEST", "x");
    expect(err.name).toBe("BrowserFallbackError");
    expect(err).toBeInstanceOf(Error);
    const codes: BrowserFallbackError["code"][] = [
      "INVALID_REQUEST",
      "CAPABILITY_UNSUPPORTED",
      "FALLBACK_NOT_ELIGIBLE",
      "ADAPTER_FAILURE",
    ];
    expect(codes).toHaveLength(4);
  });

  it("result type shape is fixed", () => {
    const r: BrowserFallbackResult = {
      status: "completed",
      provider: "p",
      capability: "c",
      permission: "read",
      verified: false,
    };
    expect(r.status).toBe("completed");
  });
});
