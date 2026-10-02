/**
 * Phase 4.15 / Blocker B4 — the narrow CONTEXTUAL post-delete inactivity classifier.
 *
 * These tests exist to prove the opposite of a global rule: the exact observed
 * live tuple (HTTP 400 / FAILED_PRECONDITION / failedPrecondition) must NEVER be
 * sufficient on its own.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POST_DELETE_EDIT_OBSERVED_FAILURE,
  POST_DELETE_EDIT_VERDICT_REASONS,
  classifyPostDeleteEditRead,
} from "../src/releases/post-delete-verification.js";

const packageName = "com.dhikrama.driver";
const editId = "managed-edit-1";

/** The exact structured tuple observed live on com.dhikrama.driver (2026-10-02). */
const observedFailure = {
  code: POST_DELETE_EDIT_OBSERVED_FAILURE.code,
  status: POST_DELETE_EDIT_OBSERVED_FAILURE.status,
  googleStatus: POST_DELETE_EDIT_OBSERVED_FAILURE.googleStatus,
  googleReasons: [POST_DELETE_EDIT_OBSERVED_FAILURE.googleReason],
};

/** A COMPLETE confirmed-delete context: same identity, acknowledged single retry-disabled delete. */
function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    preDeleteRead: { packageName, editId, succeeded: true },
    delete: { packageName, editId, acknowledged: true, attempts: 1, retryDisabled: true },
    postDeleteRead: { packageName, editId, failed: true, ...observedFailure },
    ...overrides,
  };
}

function verdictOf(value: unknown): string {
  return classifyPostDeleteEditRead(value).verdict;
}

describe("Phase 4.15 contextual post-delete classifier", () => {
  it("returns REMOTE_INACTIVE only for the complete confirmed-delete context", () => {
    const result = classifyPostDeleteEditRead(context());
    expect(result).toEqual({
      verdict: "REMOTE_INACTIVE",
      reason: "verified_post_delete_inactivity",
    });
    expect(POST_DELETE_EDIT_VERDICT_REASONS).toContain(result.reason);
  });

  it("declares the observed live tuple as required evidence, never as a rule", () => {
    expect(POST_DELETE_EDIT_OBSERVED_FAILURE).toEqual({
      code: "API_REQUEST_FAILED",
      status: 400,
      googleStatus: "FAILED_PRECONDITION",
      googleReason: "failedPrecondition",
    });
    expect(POST_DELETE_EDIT_VERDICT_REASONS).toContain("verified_post_delete_inactivity");
  });
});

describe("Phase 4.15 the observed tuple alone is NEVER inactivity", () => {
  const bareTupLeCases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["no context at all", {}],
    [
      "only a post-delete failure",
      { postDeleteRead: { packageName, editId, failed: true, ...observedFailure } },
    ],
    [
      "post-delete failure with no acknowledged delete",
      {
        preDeleteRead: { packageName, editId, succeeded: true },
        postDeleteRead: { packageName, editId, failed: true, ...observedFailure },
      },
    ],
    [
      "post-delete failure with an unacknowledged delete",
      {
        preDeleteRead: { packageName, editId, succeeded: true },
        delete: { packageName, editId, acknowledged: false, attempts: 1, retryDisabled: true },
        postDeleteRead: { packageName, editId, failed: true, ...observedFailure },
      },
    ],
    [
      "post-delete failure with no successful pre-delete read",
      {
        preDeleteRead: { packageName, editId, succeeded: false },
        delete: { packageName, editId, acknowledged: true, attempts: 1, retryDisabled: true },
        postDeleteRead: { packageName, editId, failed: true, ...observedFailure },
      },
    ],
    [
      "post-delete failure without a pre-delete read at all",
      {
        delete: { packageName, editId, acknowledged: true, attempts: 1, retryDisabled: true },
        postDeleteRead: { packageName, editId, failed: true, ...observedFailure },
      },
    ],
  ];

  for (const [label, value] of bareTupLeCases) {
    it(`400 + FAILED_PRECONDITION + failedPrecondition alone (${label}) => UNKNOWN`, () => {
      expect(verdictOf(value)).toBe("UNKNOWN");
    });
  }

  it("each individual token alone is insufficient", () => {
    // status alone
    expect(
      verdictOf(context({ postDeleteRead: { packageName, editId, failed: true, status: 400 } })),
    ).toBe("UNKNOWN");
    // googleStatus alone
    expect(
      verdictOf(
        context({
          postDeleteRead: {
            packageName,
            editId,
            failed: true,
            googleStatus: "FAILED_PRECONDITION",
          },
        }),
      ),
    ).toBe("UNKNOWN");
    // reason alone
    expect(
      verdictOf(
        context({
          postDeleteRead: {
            packageName,
            editId,
            failed: true,
            googleReasons: ["failedPrecondition"],
          },
        }),
      ),
    ).toBe("UNKNOWN");
    // code alone
    expect(
      verdictOf(
        context({
          postDeleteRead: { packageName, editId, failed: true, code: "API_REQUEST_FAILED" },
        }),
      ),
    ).toBe("UNKNOWN");
  });

  it("never classifies transient or auth failures as inactivity", () => {
    const failures: readonly Record<string, unknown>[] = [
      { code: "API_REQUEST_FAILED", status: 401 },
      { code: "API_REQUEST_FAILED", status: 403 },
      { code: "API_REQUEST_FAILED", status: 429 },
      { code: "API_REQUEST_FAILED", status: 500 },
      { code: "API_REQUEST_FAILED", status: 503 },
      { code: "ETIMEDOUT" },
      { code: "ECONNRESET" },
      { code: "API_REQUEST_FAILED" },
    ];
    for (const failure of failures) {
      expect(
        verdictOf(context({ postDeleteRead: { packageName, editId, failed: true, ...failure } })),
      ).toBe("UNKNOWN");
    }
  });

  it("never classifies a wrong status, googleStatus, or reason as inactivity", () => {
    expect(
      verdictOf(
        context({
          postDeleteRead: { packageName, editId, failed: true, ...observedFailure, status: 404 },
        }),
      ),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          postDeleteRead: {
            packageName,
            editId,
            failed: true,
            ...observedFailure,
            googleStatus: "NOT_FOUND",
          },
        }),
      ),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          postDeleteRead: {
            packageName,
            editId,
            failed: true,
            ...observedFailure,
            googleReasons: ["forbidden"],
          },
        }),
      ),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          postDeleteRead: {
            packageName,
            editId,
            failed: true,
            ...observedFailure,
            googleReasons: [],
          },
        }),
      ),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          postDeleteRead: {
            packageName,
            editId,
            failed: true,
            ...observedFailure,
            googleReasons: "failedPrecondition",
          },
        }),
      ),
    ).toBe("UNKNOWN");
  });

  it("never classifies a successful post-delete read as inactivity", () => {
    expect(verdictOf(context({ postDeleteRead: { packageName, editId, failed: false } }))).toBe(
      "UNKNOWN",
    );
  });
});

describe("Phase 4.15 context binding is required in full", () => {
  it("rejects a different package on any leg", () => {
    expect(
      verdictOf(
        context({ preDeleteRead: { packageName: "com.other.app", editId, succeeded: true } }),
      ),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          delete: {
            packageName: "com.other.app",
            editId,
            acknowledged: true,
            attempts: 1,
            retryDisabled: true,
          },
        }),
      ),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          postDeleteRead: {
            packageName: "com.other.app",
            editId,
            failed: true,
            ...observedFailure,
          },
        }),
      ),
    ).toBe("UNKNOWN");
  });

  it("rejects a different edit identity on any leg", () => {
    expect(
      verdictOf(context({ preDeleteRead: { packageName, editId: "other-edit", succeeded: true } })),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          delete: {
            packageName,
            editId: "other-edit",
            acknowledged: true,
            attempts: 1,
            retryDisabled: true,
          },
        }),
      ),
    ).toBe("UNKNOWN");
    expect(
      verdictOf(
        context({
          postDeleteRead: { packageName, editId: "other-edit", failed: true, ...observedFailure },
        }),
      ),
    ).toBe("UNKNOWN");
  });

  it("rejects a delete attempt count that is not exactly one", () => {
    for (const attempts of [0, 2, 3, -1, 1.5, "1", null]) {
      expect(
        verdictOf(
          context({
            delete: { packageName, editId, acknowledged: true, attempts, retryDisabled: true },
          }),
        ),
      ).toBe("UNKNOWN");
    }
  });

  it("rejects a delete whose retry policy was not disabled", () => {
    for (const retryDisabled of [false, undefined, "true", 0, null]) {
      expect(
        verdictOf(
          context({
            delete: { packageName, editId, acknowledged: true, attempts: 1, retryDisabled },
          }),
        ),
      ).toBe("UNKNOWN");
    }
  });

  it("rejects malformed, hostile, and primitive input without throwing", () => {
    const hostile = {
      get preDeleteRead(): never {
        throw new Error("hostile getter");
      },
    };
    const inputs: readonly unknown[] = [
      null,
      undefined,
      0,
      42,
      "a string",
      true,
      [],
      {},
      { preDeleteRead: null, delete: null, postDeleteRead: null },
      { preDeleteRead: [], delete: [], postDeleteRead: [] },
      { preDeleteRead: { packageName, editId }, delete: {}, postDeleteRead: {} },
      { preDeleteRead: { packageName: "not a package", editId, succeeded: true } },
      { preDeleteRead: { packageName, editId: "bad id", succeeded: true } },
      hostile,
    ];
    for (const input of inputs) {
      const result = classifyPostDeleteEditRead(input);
      expect(POST_DELETE_EDIT_VERDICT_REASONS).toContain(result.reason);
      expect(result.verdict).toBe("UNKNOWN");
    }
  });

  it("is deterministic", () => {
    expect(classifyPostDeleteEditRead(context())).toEqual(classifyPostDeleteEditRead(context()));
  });
});

describe("Phase 4.15 classifier isolation", () => {
  it("holds no Google SDK type, no raw response navigation, and no I/O", () => {
    const text = readFileSync(
      new URL("../src/releases/post-delete-verification.ts", import.meta.url),
      "utf8",
    );
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
    for (const forbidden of [
      "gaxios",
      "Gaxios",
      "PublisherError",
      "response",
      "cause.cause",
      "authorization",
      "Authorization",
      "token",
      "node:fs",
      "node:http",
      "fetch(",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
