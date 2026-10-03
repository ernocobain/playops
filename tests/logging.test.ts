import { describe, expect, it, vi } from "vitest";
import { createLogger, LOG_LEVELS, type LogLevel } from "../src/logging/index.js";

const TIMESTAMP = "2026-10-03T15:00:00.000Z";
const LEVELS = ["debug", "info", "warn", "error"] as const;

describe("log levels", () => {
  it("uses exactly debug < info < warn < error", () => {
    expect(LOG_LEVELS).toEqual(LEVELS);
    expect(Object.isFrozen(LOG_LEVELS)).toBe(true);
  });

  it.each(LEVELS)("filters at minimum %s with deterministic ordering", (level) => {
    const lines: string[] = [];
    const now = vi.fn(() => new Date(TIMESTAMP));
    const logger = createLogger({
      level,
      now,
      sink: (line) => {
        lines.push(line);
      },
    });
    for (const severity of LEVELS) logger[severity]("Static message.");
    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual(
      LEVELS.slice(LEVELS.indexOf(level)),
    );
    expect(now).toHaveBeenCalledTimes(lines.length);
  });

  it("defaults to info and suppresses debug without inspecting metadata or clock", () => {
    const sink = vi.fn();
    const now = vi.fn(() => new Date(TIMESTAMP));
    const logger = createLogger({ sink, now });
    logger.debug("Not emitted.");
    expect(sink).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    logger.info("Emitted.");
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it.each(["trace", "fatal", "INFO", "", "FAKE-INVALID-SECRET", null, 0, false])(
    "rejects invalid minimum level without echoing it: %s",
    (level) => {
      const sink = vi.fn();
      expect(() => createLogger({ level: level as LogLevel, sink })).toThrow(
        "Invalid logging level.",
      );
      expect(sink).not.toHaveBeenCalled();
    },
  );
});

describe("best-effort diagnostic boundary", () => {
  it("never changes command state when a synchronous sink throws", () => {
    const sink = vi.fn(() => {
      throw new Error("FAKE-SINK-SECRET");
    });
    const logger = createLogger({ sink, now: () => new Date(TIMESTAMP) });
    expect(() => logger.info("Safe operation completed.", { count: 1 })).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("handles rejected asynchronous sinks without unhandled rejections or retries", async () => {
    const sink = vi.fn(() => Promise.reject(new Error("FAKE-SINK-SECRET")));
    const logger = createLogger({ sink, now: () => new Date(TIMESTAMP) });
    logger.info("Safe operation completed.");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => new Date("invalid"),
    () => {
      throw new Error("FAKE-CLOCK-SECRET");
    },
  ])(
    "drops a record on clock failure without reading another clock or logging raw errors",
    (clock) => {
      const sink = vi.fn();
      const now = vi.fn(clock);
      expect(() => createLogger({ sink, now }).error("Static failure.")).not.toThrow();
      expect(sink).not.toHaveBeenCalled();
      expect(now).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects invalid message types without coercion and never evaluates suppressed metadata", () => {
    const sink = vi.fn();
    const now = vi.fn(() => new Date(TIMESTAMP));
    const logger = createLogger({ sink, now });
    const toString = vi.fn(() => "FAKE-SECRET");
    logger.info({ toString } as unknown as string);
    const metadata = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("Must not inspect suppressed context");
        },
      },
    );
    logger.debug("Suppressed.", metadata);
    expect(sink).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });

  it("reads the clock once for each emitted entry and never mutates options", () => {
    const sink = vi.fn();
    const now = vi.fn(() => new Date(TIMESTAMP));
    const options = Object.freeze({ level: "debug" as const, sink, now });
    const logger = createLogger(options);
    for (const level of LEVELS) logger[level]("Static event.");
    expect(now).toHaveBeenCalledTimes(4);
    expect(sink).toHaveBeenCalledTimes(4);
    expect(options).toEqual({ level: "debug", sink, now });
  });
});

describe("structured diagnostic logger", () => {
  it("emits one compact JSONL record with one injected UTC clock read", () => {
    const lines: string[] = [];
    const now = vi.fn(() => new Date(TIMESTAMP));
    const logger = createLogger({
      sink: (line) => {
        lines.push(line);
      },
      now,
    });
    logger.info("Operation completed.");
    expect(lines).toEqual([
      '{"timestamp":"2026-10-03T15:00:00.000Z","level":"info","message":"Operation completed."}\n',
    ]);
    expect(now).toHaveBeenCalledTimes(1);
  });
});
