import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logging/index.js";
import { sanitizeAuditMetadata, REDACTED } from "../src/audit/index.js";

const TIMESTAMP = "2026-10-03T15:00:00.000Z";
const SECRET = "FAKE-LOG-SECRET-MUST-NOT-EMIT";
function record(context: unknown) {
  const lines: string[] = [];
  createLogger({
    now: () => new Date(TIMESTAMP),
    sink: (line) => {
      lines.push(line);
    },
  }).info("Static safe message.", context);
  expect(lines).toHaveLength(1);
  const line = lines[0] ?? "";
  expect(line.split("\n")).toHaveLength(2);
  return { line, context: (JSON.parse(line) as { context: unknown }).context };
}

const KEYS = [
  "authorization",
  "token",
  "accessToken",
  "refresh_token",
  "password",
  "secret",
  "private_key",
  "client-secret",
  "apiKey",
  "api_key",
  "AuThOrIzAtIoN",
  "ACCESS-TOKEN",
  "Refresh_Token",
  "PaSsWoRd",
  "Client_Secret",
  "PRIVATE-KEY",
  "API.KEY",
  "api key",
  "providerApiKey",
  "approvalToken",
] as const;

describe("hostile diagnostic context", () => {
  it("omits absent context and preserves null and exact bigint text", () => {
    expect(record(undefined).context).toBeUndefined();
    expect(record(null).context).toBeNull();
    expect(
      record({
        count: 123456789012345678901234567890n,
        missing: undefined,
        values: [undefined, null, NaN, Infinity],
      }).context,
    ).toEqual({
      count: "123456789012345678901234567890",
      missing: null,
      values: [null, null, null, null],
    });
  });

  it("normalizes accidentally supplied functions and symbols without calling or describing them", () => {
    const fn = vi.fn(() => SECRET);
    expect(record({ fn, symbol: Symbol(SECRET), values: [fn, Symbol(SECRET)] }).context).toEqual({
      fn: "[UNSUPPORTED]",
      symbol: "[UNSUPPORTED]",
      values: ["[UNSUPPORTED]", "[UNSUPPORTED]"],
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses accessor evaluation, including secret getters and array accessors", () => {
    const getter = vi.fn(() => {
      throw new Error(SECRET);
    });
    const array = ["x"];
    Object.defineProperty(array, "0", { enumerable: true, get: getter });
    const input = Object.defineProperties(
      {},
      {
        safe: { enumerable: true, get: getter },
        authorization: { enumerable: true, get: getter },
        array: { enumerable: true, value: array },
      },
    );
    const logged = record(input);
    expect(logged.context).toEqual({
      safe: "[UNSUPPORTED]",
      authorization: REDACTED,
      array: ["[UNSUPPORTED]"],
    });
    expect(logged.line).not.toContain(SECRET);
    expect(getter).not.toHaveBeenCalled();
  });

  it("marks cycles but does not mistake a shared non-circular reference for a cycle", () => {
    const input: Record<string, unknown> = { safe: "kept", token: SECRET };
    input.self = input;
    const logged = record(input);
    expect(logged.context).toEqual({ safe: "kept", token: REDACTED, self: "[CIRCULAR]" });
    expect(input.self).toBe(input);
    const shared = { api_key: SECRET };
    expect(record({ a: shared, b: shared }).context).toEqual({
      a: { api_key: REDACTED },
      b: { api_key: REDACTED },
    });
  });

  it("never calls toJSON or coerces a class instance", () => {
    const toJSON = vi.fn(() => SECRET);
    const toString = vi.fn(() => SECRET);
    expect(record({ toJSON, safe: "kept" }).context).toEqual({
      toJSON: "[UNSUPPORTED]",
      safe: "kept",
    });
    class Hostile {
      toJSON = toJSON;
      toString = toString;
      raw = SECRET;
    }
    expect(record(new Hostile()).context).toBe("[UNSUPPORTED]");
    expect(toJSON).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it("discards raw Error fields, using only fixed name, numeric HTTP status and uncertainty", () => {
    const error = Object.assign(new Error(SECRET, { cause: { raw: SECRET } }), {
      name: SECRET,
      code: SECRET,
      status: 503,
      externalStateUncertain: true,
      headers: { authorization: SECRET },
      config: { apiKey: SECRET },
      response: { raw: SECRET },
    });
    const logged = record({ error });
    expect(logged.context).toEqual({
      error: { name: "Error", status: 503, externalStateUncertain: true },
    });
    expect(logged.line).not.toContain(SECRET);
    expect(logged.line).not.toMatch(/stack|cause|headers|config|response|code/);
  });

  it("ignores hostile Error getters and invalid safe-field types", () => {
    const getter = vi.fn(() => {
      throw new Error(SECRET);
    });
    const error = new Error(SECRET);
    for (const key of ["message", "stack", "name", "code", "status", "externalStateUncertain"])
      Object.defineProperty(error, key, { get: getter });
    expect(record(error).context).toEqual({ name: "Error" });
    const invalid = Object.assign(new Error(SECRET), {
      status: SECRET,
      externalStateUncertain: SECRET,
    });
    expect(record(invalid).context).toEqual({ name: "Error" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects proxy and revoked-proxy metadata before calling any trap", () => {
    const trap = vi.fn(() => {
      throw new Error(SECRET);
    });
    const proxy = new Proxy(
      {},
      { ownKeys: trap, get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(record({ proxy, revoked: revoked.proxy }).context).toEqual({
      proxy: "[UNSUPPORTED]",
      revoked: "[UNSUPPORTED]",
    });
    expect(trap).not.toHaveBeenCalled();
  });

  it("bounds deep, wide and long metadata with a fixed marker instead of overflowing or leaking a prefix", () => {
    let deep: unknown = { apiKey: SECRET };
    for (let i = 0; i < 12000; i += 1) deep = { nested: deep };
    const deepLog = record(deep);
    expect(deepLog.line).toContain("[TRUNCATED]");
    expect(deepLog.line).not.toContain(SECRET);
    expect(record(new Array(101).fill(null)).context).toBe("[TRUNCATED]");
    expect(record("s".repeat(2049)).context).toBe("[TRUNCATED]");
    expect(record(10n ** 3000n).context).toBe("[TRUNCATED]");
  });

  it("handles null-prototype and special property names without changing prototypes", () => {
    const input: unknown = JSON.parse(
      '{"__proto__":{"api_key":"' +
        SECRET +
        '"},"constructor":{"token":"' +
        SECRET +
        '"},"prototype":null}',
    );
    const logged = record(input);
    expect(logged.context).toEqual(
      JSON.parse(
        '{"__proto__":{"api_key":"[REDACTED]"},"constructor":{"token":"[REDACTED]"},"prototype":null}',
      ),
    );
    expect(logged.line).not.toContain(SECRET);
    const plain = Object.create(null) as Record<string, unknown>;
    plain.api_key = SECRET;
    expect(record(plain).context).toEqual({ api_key: REDACTED });
  });
});

describe("structured log redaction", () => {
  it.each(KEYS)("redacts %s recursively and never changes the input", (key) => {
    const input = {
      [key]: SECRET,
      nested: { safe: "kept", [key]: SECRET, deeper: { [key]: SECRET } },
      items: [{ [key]: SECRET }, [{ deeply: { [key]: SECRET } }]],
    };
    const original = structuredClone(input);
    const logged = record(input);
    expect(logged.line).not.toContain(SECRET);
    expect(logged.context).toEqual({
      [key]: REDACTED,
      nested: { safe: "kept", [key]: REDACTED, deeper: { [key]: REDACTED } },
      items: [{ [key]: REDACTED }, [{ deeply: { [key]: REDACTED } }]],
    });
    expect(input).toEqual(original);
  });

  it("preserves every existing audit secret-key rule including separator/case/suffix matching", () => {
    const input = {
      rawToken: SECRET,
      "Provider-Client_Secret": SECRET,
      nested: { privateKey: SECRET },
      proofDigest: "kept",
    };
    expect(record(input).context).toEqual(sanitizeAuditMetadata(input));
  });

  it("reuses audit redaction without changing the audit API-key semantics in this phase", () => {
    const original = { api_key: SECRET, authorization: SECRET, proofDigest: "kept" };
    expect(sanitizeAuditMetadata(original)).toEqual({
      api_key: SECRET,
      authorization: REDACTED,
      proofDigest: "kept",
    });
    expect(record(original).context).toEqual({
      api_key: REDACTED,
      authorization: REDACTED,
      proofDigest: "kept",
    });
  });

  it("orders object keys deterministically at every nesting level", () => {
    const one = record({ z: { z: 1, a: 2 }, b: [true], a: null });
    const two = record({ a: null, b: [true], z: { a: 2, z: 1 } });
    expect(one.line).toBe(two.line);
    expect(one.line).toBe(
      '{"timestamp":"2026-10-03T15:00:00.000Z","level":"info","message":"Static safe message.","context":{"a":null,"b":[true],"z":{"a":2,"z":1}}}\n',
    );
  });

  it("does not mutate frozen inputs and keeps message newlines inside a single record", () => {
    const input = Object.freeze({ z: Object.freeze([{ apiKey: SECRET, count: 1 }]) });
    const lines: string[] = [];
    createLogger({
      now: () => new Date(TIMESTAMP),
      sink: (line) => {
        lines.push(line);
      },
    }).warn("Static message.\nContinued.", input);
    const raw = lines.join("");
    expect(raw.split("\n")).toHaveLength(2);
    expect(raw).not.toContain(SECRET);
    expect(input.z[0]?.apiKey).toBe(SECRET);
  });
});
