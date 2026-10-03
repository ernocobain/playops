import { describe, expect, it } from "vitest";
import {
  ERROR_CATEGORIES,
  formatOperatorError,
  presentAgentFailure,
  presentOperatorError,
  toOperatorError,
  type ErrorCategory,
  type OperatorError,
} from "../src/errors/index.js";
import { ConfigError } from "../src/config/errors.js";
import { CredentialError } from "../src/config/credentials.js";
import { AuthError } from "../src/googleplay/auth/index.js";
import { PublisherError } from "../src/googleplay/publisher/index.js";
import { ReportingError } from "../src/googleplay/reporting/index.js";
import { AuditError } from "../src/audit/errors.js";
import { ToolRegistryError } from "../src/runtime/tools/index.js";
import { ApprovalGateError } from "../src/runtime/approvals/index.js";
import { VerificationError } from "../src/runtime/verification/index.js";
import { LlmError } from "../src/runtime/llm/index.js";
import { BrowserFallbackError } from "../src/runtime/browser/index.js";
import { AgentRunError } from "../src/runtime/agent/index.js";
import { HealthError } from "../src/health/errors.js";
import { HealthReportError } from "../src/health/report.js";
import { HealthCompositionError } from "../src/health/composition.js";
import { HealthCliError } from "../src/cli/health.js";
import { ReleaseError } from "../src/releases/index.js";
import { ReleaseCompositionError } from "../src/releases/composition.js";
import { ReviewIngestionError } from "../src/reviews/common.js";
import { ReviewClassificationError } from "../src/reviews/classification/index.js";
import { ReviewReplyDraftError } from "../src/reviews/drafting/index.js";
import { ReviewReplyPublishError } from "../src/reviews/publishing/index.js";
import { ReviewCompositionError } from "../src/reviews/composition.js";
import { ReviewCliError } from "../src/cli/reviews.js";

/** Every secret-shaped marker the boundary must never emit. */
const SECRET_MARKERS = [
  "FAKE-SECRET-MESSAGE",
  "FAKE-LEAK",
  "private_key",
  "client_secret",
  "Authorization",
  "Bearer",
  "SECRET-RESPONSE-BODY",
  "at Object.",
  "\n    at ",
];

function assertSafe(presented: OperatorError): void {
  const serialized = JSON.stringify(presented);
  for (const marker of SECRET_MARKERS) expect(serialized).not.toContain(marker);
  expect(Object.keys(presented).sort()).toEqual(
    Object.keys(presented)
      .filter((key) =>
        ["category", "code", "message", "guidance", "externalStateUncertain"].includes(key),
      )
      .sort(),
  );
  expect(presented).not.toHaveProperty("cause");
  expect(presented).not.toHaveProperty("stack");
  expect(ERROR_CATEGORIES).toContain(presented.category);
  expect(presented.message.trim().length).toBeGreaterThan(0);
  expect(presented.code).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/u);
}

const SAMPLES: {
  readonly label: string;
  readonly error: unknown;
  readonly category: ErrorCategory;
  readonly code: string;
}[] = [
  {
    label: "config invalid value",
    error: new ConfigError("bad", "CONFIG_INVALID_VALUE"),
    category: "configuration",
    code: "CONFIG_INVALID_VALUE",
  },
  {
    label: "config migration",
    error: new ConfigError("bad", "CONFIG_MIGRATION_REQUIRED"),
    category: "configuration",
    code: "CONFIG_MIGRATION_REQUIRED",
  },
  {
    label: "credential missing file",
    error: new CredentialError("missing", "CREDENTIAL_FILE_NOT_FOUND"),
    category: "credentials",
    code: "CREDENTIAL_FILE_NOT_FOUND",
  },
  {
    label: "auth token failure",
    error: new AuthError("failed", "ACCESS_TOKEN_FAILED"),
    category: "credentials",
    code: "ACCESS_TOKEN_FAILED",
  },
  {
    label: "publisher api failure",
    error: new PublisherError("failed", "API_REQUEST_FAILED"),
    category: "external-api",
    code: "API_REQUEST_FAILED",
  },
  {
    label: "publisher local validation",
    error: new PublisherError("invalid", "INVALID_ARGUMENT"),
    category: "validation",
    code: "INVALID_ARGUMENT",
  },
  {
    label: "reporting invalid response",
    error: new ReportingError("bad", "INVALID_RESPONSE"),
    category: "external-api",
    code: "INVALID_RESPONSE",
  },
  {
    label: "audit write failure",
    error: new AuditError("failed", "AUDIT_WRITE_FAILED"),
    category: "persistence",
    code: "AUDIT_WRITE_FAILED",
  },
  {
    label: "tool not found",
    error: new ToolRegistryError("TOOL_NOT_FOUND", "missing"),
    category: "runtime",
    code: "TOOL_NOT_FOUND",
  },
  {
    label: "approval expired",
    error: new ApprovalGateError("TOKEN_EXPIRED", "expired"),
    category: "permissions",
    code: "TOKEN_EXPIRED",
  },
  {
    label: "approval request mismatch",
    error: new ApprovalGateError("TOKEN_REQUEST_MISMATCH", "mismatch"),
    category: "permissions",
    code: "TOKEN_REQUEST_MISMATCH",
  },
  {
    label: "verification audit failure",
    error: new VerificationError("AUDIT_FAILURE", "failed"),
    category: "persistence",
    code: "AUDIT_FAILURE",
  },
  {
    label: "llm timeout",
    error: new LlmError("TIMEOUT", "timeout", "9router", "complete"),
    category: "external-api",
    code: "TIMEOUT",
  },
  {
    label: "browser fallback not eligible",
    error: new BrowserFallbackError("FALLBACK_NOT_ELIGIBLE", "no"),
    category: "permissions",
    code: "FALLBACK_NOT_ELIGIBLE",
  },
  {
    label: "agent invalid config",
    error: new AgentRunError("INVALID_CONFIG", "bad limits"),
    category: "configuration",
    code: "INVALID_CONFIG",
  },
  {
    label: "health duplicate identity",
    error: new HealthError("duplicate", "DUPLICATE_IDENTITY"),
    category: "conflict",
    code: "DUPLICATE_IDENTITY",
  },
  {
    label: "health source failed",
    error: new HealthError("source", "SOURCE_FAILED"),
    category: "external-api",
    code: "SOURCE_FAILED",
  },
  {
    label: "health report exists",
    error: new HealthReportError("REPORT_EXISTS", "exists"),
    category: "conflict",
    code: "REPORT_EXISTS",
  },
  {
    label: "health configuration",
    error: new HealthCompositionError("bad config"),
    category: "configuration",
    code: "CONFIG_INVALID",
  },
  {
    label: "health cli argument",
    error: new HealthCliError(),
    category: "validation",
    code: "CLI_ARGUMENT_INVALID",
  },
  {
    label: "release version code gate",
    error: new ReleaseError("VERSION_CODE_NOT_GREATER", "not greater"),
    category: "conflict",
    code: "VERSION_CODE_NOT_GREATER",
  },
  {
    label: "release edit session required",
    error: new ReleaseError("EDIT_SESSION_REQUIRED", "required"),
    category: "conflict",
    code: "EDIT_SESSION_REQUIRED",
  },
  {
    label: "release commit state changed",
    error: new ReleaseError("COMMIT_STATE_CHANGED", "changed"),
    category: "conflict",
    code: "COMMIT_STATE_CHANGED",
  },
  {
    label: "release changes already in review",
    error: new ReleaseError("CHANGES_ALREADY_IN_REVIEW", "in review"),
    category: "conflict",
    code: "CHANGES_ALREADY_IN_REVIEW",
  },
  {
    label: "release session store malformed",
    error: new ReleaseError("EDIT_SESSION_STORE_INVALID", "malformed"),
    category: "persistence",
    code: "EDIT_SESSION_STORE_INVALID",
  },
  {
    label: "release status audit failure",
    error: new ReleaseError("STATUS_CONTROL_AUDIT_FAILED", "audit"),
    category: "persistence",
    code: "STATUS_CONTROL_AUDIT_FAILED",
  },
  {
    label: "release upload failure",
    error: new ReleaseError("UPLOAD_FAILED", "upload"),
    category: "external-api",
    code: "UPLOAD_FAILED",
  },
  {
    label: "release composition",
    error: new ReleaseCompositionError("bad config"),
    category: "configuration",
    code: "CONFIG_INVALID",
  },
  {
    label: "review checkpoint malformed",
    error: new ReviewIngestionError("CHECKPOINT_INVALID", "malformed"),
    category: "persistence",
    code: "CHECKPOINT_INVALID",
  },
  {
    label: "review source failed",
    error: new ReviewIngestionError("SOURCE_FAILED", "source"),
    category: "external-api",
    code: "SOURCE_FAILED",
  },
  {
    label: "review classify llm failed",
    error: new ReviewClassificationError("LLM_FAILED", "llm"),
    category: "external-api",
    code: "LLM_FAILED",
  },
  {
    label: "review draft invalid response",
    error: new ReviewReplyDraftError("INVALID_RESPONSE", "bad"),
    category: "external-api",
    code: "INVALID_RESPONSE",
  },
  {
    label: "review reply changed",
    error: new ReviewReplyPublishError("REVIEW_CHANGED", "changed"),
    category: "conflict",
    code: "REVIEW_CHANGED",
  },
  {
    label: "review composition",
    error: new ReviewCompositionError("bad config"),
    category: "configuration",
    code: "CONFIG_INVALID",
  },
  {
    label: "review cli argument",
    error: new ReviewCliError(),
    category: "validation",
    code: "CLI_ARGUMENT_INVALID",
  },
];

describe("Phase 6.3 error taxonomy", () => {
  it("exposes a small stable top-level taxonomy", () => {
    expect([...ERROR_CATEGORIES]).toEqual([
      "configuration",
      "credentials",
      "permissions",
      "validation",
      "external-api",
      "persistence",
      "verification",
      "conflict",
      "runtime",
    ]);
  });

  it.each(SAMPLES)("maps typed $label by explicit code", ({ error, category, code }) => {
    const presented = toOperatorError(error);
    expect(presented.category).toBe(category);
    expect(presented.code).toBe(code);
    expect(typeof presented.guidance).toBe("string");
    assertSafe(presented);
  });

  it("can produce every top-level taxonomy category", () => {
    const seen = new Set<ErrorCategory>();
    for (const sample of SAMPLES) seen.add(toOperatorError(sample.error).category);
    for (const code of [
      "APPROVAL_REQUIRED",
      "APPROVAL_DENIED",
      "VERIFICATION_FAILED",
      "LLM_FAILED",
      "AUDIT_FAILURE",
    ]) {
      seen.add(presentAgentFailure(code).category);
    }
    expect([...seen].sort()).toEqual([...ERROR_CATEGORIES].sort());
  });

  it("classifies an unknown Error as a generic internal failure", () => {
    const presented = toOperatorError(new Error("FAKE-SECRET-MESSAGE"));
    expect(presented.category).toBe("runtime");
    expect(presented.code).toBe("INTERNAL_ERROR");
    expect(presented.message).toBe("An unexpected internal PlayOps failure occurred.");
    expect(typeof presented.guidance).toBe("string");
    assertSafe(presented);
  });

  it.each([
    ["string", "FAKE-SECRET-MESSAGE"],
    ["number", 42],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["symbol", Symbol("FAKE-SECRET-MESSAGE")],
    ["function", () => "FAKE-LEAK"],
    ["plain object", { message: "FAKE-SECRET-MESSAGE" }],
  ])("fails safely for a non-Error thrown %s", (_label, thrown) => {
    const presented = toOperatorError(thrown);
    expect(presented.category).toBe("runtime");
    expect(presented.code).toBe("INTERNAL_ERROR");
    assertSafe(presented);
  });

  it("never echoes a secret-looking typed error message", () => {
    const presented = toOperatorError(
      new PublisherError("FAKE-SECRET-MESSAGE token=FAKE-LEAK", "API_REQUEST_FAILED"),
    );
    expect(presented.message).not.toContain("FAKE-SECRET-MESSAGE");
    expect(presented.message).not.toContain("FAKE-LEAK");
    expect(presented.code).toBe("API_REQUEST_FAILED");
    assertSafe(presented);
  });

  it("never reads or serializes a nested cause chain", () => {
    const nested = new Error("FAKE-LEAK private_key");
    const cause = { secret: "FAKE-LEAK" };
    const error = new ReleaseError("UPLOAD_FAILED", "safe message", { cause });
    Object.defineProperty(error, "nestedCause", { value: nested, enumerable: true });
    const presented = toOperatorError(error);
    expect(JSON.stringify(presented)).not.toContain("FAKE-LEAK");
    expect(presented).not.toHaveProperty("cause");
    assertSafe(presented);
  });

  it("never reads a stack that carries credential material", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at x (client_secret=FAKE-LEAK)";
    const presented = toOperatorError(error);
    expect(JSON.stringify(presented)).not.toContain("FAKE-LEAK");
    expect(presented).not.toHaveProperty("stack");
    assertSafe(presented);
  });

  it("projects a Google-shaped error without reading the response body", () => {
    const googleShaped = {
      name: "GaxiosError",
      code: 403,
      response: {
        status: 403,
        data: { error: { message: "SECRET-RESPONSE-BODY", status: "PERMISSION_DENIED" } },
        headers: { authorization: "Bearer FAKE-LEAK" },
      },
    };
    const presented = toOperatorError(googleShaped);
    expect(presented.category).toBe("external-api");
    expect(presented.code).toBe("GOOGLE_API_ERROR");
    expect(presented.message).toContain("403");
    assertSafe(presented);

    const stringStatus = { name: "GaxiosError", code: "500" };
    expect(toOperatorError(stringStatus).message).toContain("500");
  });

  it("classifies filesystem and transport system codes safely", () => {
    const fsError = Object.assign(new Error("ENOENT: no such file, open 'FAKE-LEAK'"), {
      code: "ENOENT",
      path: "/tmp/FAKE-LEAK",
    });
    const fsPresented = toOperatorError(fsError);
    expect(fsPresented.category).toBe("persistence");
    expect(fsPresented.code).toBe("ENOENT");
    assertSafe(fsPresented);

    const transport = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const transportPresented = toOperatorError(transport);
    expect(transportPresented.category).toBe("external-api");
    expect(transportPresented.code).toBe("ECONNRESET");
    assertSafe(transportPresented);
  });

  it("classifies a read-only source failure as external-api", () => {
    const presented = toOperatorError(new PublisherError("read failed", "API_REQUEST_FAILED"));
    expect(presented.category).toBe("external-api");
    expect(presented.guidance ?? "").not.toMatch(/retry/iu);
  });

  it("preserves externalStateUncertain and never suggests a blind retry", () => {
    const uncertain = new ReleaseError("UPLOAD_FAILED", "upload", {
      externalStateUncertain: true,
    });
    const presented = toOperatorError(uncertain);
    expect(presented.externalStateUncertain).toBe(true);
    expect(presented.guidance).toContain("Do not retry automatically");
    expect(presented.guidance ?? "").not.toMatch(/\bplease retry\b/iu);

    const certain = new ReleaseError("VERSION_CODE_NOT_GREATER", "gate", {
      externalStateUncertain: false,
    });
    const certainPresented = toOperatorError(certain);
    expect(certainPresented.externalStateUncertain).toBe(false);
    expect(certainPresented.guidance).not.toContain("Do not retry automatically");
  });

  it("preserves the uncertainty flag for an otherwise unknown failure", () => {
    const presented = toOperatorError({
      name: "MysteryError",
      code: "SOMETHING",
      externalStateUncertain: true,
    });
    expect(presented.code).toBe("INTERNAL_ERROR");
    expect(presented.externalStateUncertain).toBe(true);
    expect(presented.guidance).toContain("Do not retry automatically");
  });

  it("maps agent-loop failure codes onto the same model", () => {
    expect(presentAgentFailure("APPROVAL_REQUIRED")).toMatchObject({
      category: "permissions",
      code: "APPROVAL_REQUIRED",
    });
    expect(presentAgentFailure("APPROVAL_DENIED")).toMatchObject({ category: "permissions" });
    expect(presentAgentFailure("VERIFICATION_FAILED")).toMatchObject({
      category: "verification",
      code: "VERIFICATION_FAILED",
    });
    expect(presentAgentFailure("AUDIT_FAILURE")).toMatchObject({ category: "persistence" });
    expect(presentAgentFailure("NOT_A_REAL_CODE")).toMatchObject({ code: "INTERNAL_ERROR" });
    assertSafe(presentAgentFailure("VERIFICATION_FAILED"));
  });

  it("renders deterministic, stack-free operator text", () => {
    const error = new ReleaseError("COMMIT_STATE_CHANGED", "changed");
    const first = presentOperatorError(error);
    const second = presentOperatorError(error);
    expect(first).toBe(second);
    expect(first).toContain("conflict");
    expect(first).toContain("COMMIT_STATE_CHANGED");
    expect(first).not.toContain("    at ");
    expect(formatOperatorError(toOperatorError(error))).toBe(first);
  });

  it("does not mutate the input object", () => {
    const error = new ReleaseError("UPLOAD_FAILED", "upload", { externalStateUncertain: true });
    const before = Object.getOwnPropertyNames(error)
      .map((key) => [key, String(Reflect.get(error, key))])
      .sort();
    toOperatorError(error);
    const after = Object.getOwnPropertyNames(error)
      .map((key) => [key, String(Reflect.get(error, key))])
      .sort();
    expect(after).toEqual(before);
    expect(Object.isFrozen(error)).toBe(false);
  });

  it("fails safely on hostile thrown objects", () => {
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, "name", {
      get() {
        throw new Error("FAKE-LEAK");
      },
    });
    const throwingResponse = { name: "GaxiosError", code: "403" };
    Object.defineProperty(throwingResponse, "response", {
      get() {
        throw new Error("FAKE-LEAK");
      },
    });
    const throwingCode = {};
    Object.defineProperty(throwingCode, "name", { value: "PublisherError" });
    Object.defineProperty(throwingCode, "code", {
      get() {
        throw new Error("FAKE-LEAK");
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("FAKE-LEAK");
        },
        getOwnPropertyDescriptor() {
          throw new Error("FAKE-LEAK");
        },
      },
    );
    const circular: Record<string, unknown> = {
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
    };
    circular.cause = circular;
    circular.self = circular;
    const symbolFields = {
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
      [Symbol("x")]: "FAKE-LEAK",
      fn: () => "FAKE-LEAK",
    };
    let deep: unknown = { leaf: "FAKE-LEAK" };
    for (let index = 0; index < 20_000; index += 1) deep = { next: deep };

    const hostile = [
      throwingGetter,
      throwingResponse,
      throwingCode,
      throwingProxy,
      circular,
      symbolFields,
      { name: "PublisherError", code: "API_REQUEST_FAILED", deep },
      Object.create({ name: "PublisherError" }),
    ];
    for (const value of hostile) {
      const presented = toOperatorError(value);
      assertSafe(presented);
      expect(presented.message).not.toContain("FAKE-LEAK");
    }
    // The real, well-formed values still classify correctly.
    expect(toOperatorError(circular).category).toBe("external-api");
    expect(toOperatorError(symbolFields).code).toBe("API_REQUEST_FAILED");
  });

  it("keeps the boundary itself total under repeated hostile input", () => {
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    expect(() => presentOperatorError(throwingProxy)).not.toThrow();
    expect(presentOperatorError(throwingProxy)).toContain("INTERNAL_ERROR");
  });
});
