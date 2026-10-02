import { describe, expect, it } from "vitest";
import { executeWithRetry } from "../src/googleplay/retry/index.js";

describe("executeWithRetry", () => {
  it("returns a first-attempt read result without sleeping", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await executeWithRetry(
      () => {
        calls++;
        return Promise.resolve("ok");
      },
      {
        safety: "read",
        sleep: (delay) => {
          delays.push(delay);
          return Promise.resolve();
        },
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries a read after HTTP 429 and succeeds with a fake sleeper", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await executeWithRetry(
      () => {
        calls++;
        return calls === 1
          ? Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }))
          : Promise.resolve("ok");
      },
      {
        safety: "read",
        sleep: (delay) => {
          delays.push(delay);
          return Promise.resolve();
        },
        random: () => 1,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(delays).toEqual([250]);
  });

  it.each([500, 502, 503, 504])("retries a read after HTTP %i", async (status) => {
    let calls = 0;
    const delays: number[] = [];
    const result = await executeWithRetry(
      () => {
        calls++;
        return calls === 1
          ? Promise.reject({ response: { status } })
          : Promise.resolve("recovered");
      },
      {
        safety: "read",
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: () => 1,
      },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    expect(delays).toEqual([250]);
  });

  it.each([400, 401, 403, 404])("does not retry HTTP %i", async (status) => {
    const failure = Object.assign(new Error("not retryable"), { code: status });
    let calls = 0;
    const delays: number[] = [];
    await expect(
      executeWithRetry(
        () => {
          calls++;
          return Promise.reject(failure);
        },
        {
          safety: "read",
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("never retries a mutation by default, even for HTTP 429", async () => {
    const failure = Object.assign(new Error("throttled"), { status: 429 });
    let calls = 0;
    const sleep = () => {
      throw new Error("unexpected sleep");
    };
    await expect(
      executeWithRetry(
        () => {
          calls++;
          return Promise.reject(failure);
        },
        { safety: "mutation", sleep },
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("respects maxAttempts and rethrows the identical last error", async () => {
    const errors = [
      Object.assign(new Error("first"), { code: 503 }),
      Object.assign(new Error("second"), { code: 503 }),
      Object.assign(new Error("last"), { code: 503 }),
    ];
    let calls = 0;
    const delays: number[] = [];
    await expect(
      executeWithRetry(() => Promise.reject(errors[calls++]), {
        safety: "read",
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: () => 1,
      }),
    ).rejects.toBe(errors[2]);
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("caps exponential backoff with configurable policy", async () => {
    let calls = 0;
    const delays: number[] = [];
    await expect(
      executeWithRetry(
        () => {
          calls++;
          return Promise.reject({ status: 503 });
        },
        {
          safety: "read",
          policy: { maxAttempts: 4, baseDelayMs: 600, maxDelayMs: 750 },
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          random: () => 1,
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(4);
    expect(delays).toEqual([600, 750, 750]);
  });

  it("injects deterministic half-to-full jitter without real sleeps", async () => {
    let calls = 0;
    const delays: number[] = [];
    await expect(
      executeWithRetry(
        () => {
          calls++;
          return Promise.reject({ code: 500 });
        },
        {
          safety: "read",
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          random: () => 0,
        },
      ),
    ).rejects.toMatchObject({ code: 500 });
    expect(calls).toBe(3);
    expect(delays).toEqual([125, 250]);
  });

  it("uses Retry-After seconds instead of jittered backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await executeWithRetry(
      () =>
        ++calls === 1
          ? Promise.reject({
              response: { status: 429, headers: new Headers({ "Retry-After": "1" }) },
            })
          : Promise.resolve("ok"),
      {
        safety: "read",
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: () => 0,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(delays).toEqual([1_000]);
  });

  it("accepts an HTTP-date Retry-After with an injected clock", async () => {
    let calls = 0;
    const delays: number[] = [];
    await executeWithRetry(
      () =>
        ++calls === 1
          ? Promise.reject({
              response: {
                status: 503,
                headers: { "retry-after": "Sat, 26 Sep 2026 00:00:02 GMT" },
              },
            })
          : Promise.resolve("ok"),
      {
        safety: "read",
        now: () => Date.parse("2026-09-26T00:00:00Z"),
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(delays).toEqual([2_000]);
  });

  it("caps a valid Retry-After at the policy maximum", async () => {
    let calls = 0;
    const delays: number[] = [];
    await executeWithRetry(
      () =>
        ++calls === 1
          ? Promise.reject({
              status: 429,
              response: { headers: { "Retry-After": "999999999999" } },
            })
          : Promise.resolve("ok"),
      {
        safety: "read",
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(delays).toEqual([2_000]);
  });

  it.each(["garbage", "-5", "1.5", "yesterday"])(
    "ignores malformed Retry-After %s and uses backoff",
    async (header) => {
      let calls = 0;
      const delays: number[] = [];
      await executeWithRetry(
        () =>
          ++calls === 1
            ? Promise.reject({ status: 429, response: { headers: { "Retry-After": header } } })
            : Promise.resolve("ok"),
        {
          safety: "read",
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          random: () => 1,
        },
      );
      expect(delays).toEqual([250]);
    },
  );

  it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"])(
    "retries the structured transient network code %s",
    async (code) => {
      let calls = 0;
      await executeWithRetry(
        () => (++calls === 1 ? Promise.reject({ code }) : Promise.resolve("ok")),
        { safety: "read", sleep: () => Promise.resolve() },
      );
      expect(calls).toBe(2);
    },
  );

  it("does not retry a 403 even when an inner network code exists", async () => {
    const failure = { response: { status: 403 }, code: "ECONNRESET" };
    let calls = 0;
    await expect(
      executeWithRetry(
        () => {
          calls++;
          return Promise.reject(failure);
        },
        { safety: "read", sleep: () => Promise.resolve() },
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("allows an explicitly documented idempotent mutation only", async () => {
    let calls = 0;
    const result = await executeWithRetry(
      () => (++calls === 1 ? Promise.reject({ status: 503 }) : Promise.resolve("ok")),
      {
        safety: "mutation",
        mutationRetry: { idempotencyReason: "documented repeatable operation" },
        sleep: () => Promise.resolve(),
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("rejects an empty mutation idempotency rationale before any call", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        () => {
          calls++;
          return Promise.resolve("ok");
        },
        { safety: "mutation", mutationRetry: { idempotencyReason: " " } },
      ),
    ).rejects.toThrow("idempotencyReason");
    expect(calls).toBe(0);
  });

  it("rejects unbounded or invalid policies before any call", async () => {
    let calls = 0;
    for (const policy of [
      { maxAttempts: 0, baseDelayMs: 250, maxDelayMs: 2_000 },
      { maxAttempts: 11, baseDelayMs: 250, maxDelayMs: 2_000 },
      { maxAttempts: 1.5, baseDelayMs: 250, maxDelayMs: 2_000 },
      { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 100 },
      { maxAttempts: 3, baseDelayMs: Number.NaN, maxDelayMs: 2_000 },
    ]) {
      await expect(
        executeWithRetry(
          () => {
            calls++;
            return Promise.resolve("ok");
          },
          { safety: "read", policy },
        ),
      ).rejects.toThrow("Invalid retry policy");
    }
    expect(calls).toBe(0);
  });
});
