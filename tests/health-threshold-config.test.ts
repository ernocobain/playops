/** Phase 5.4 — exact, operator-bound reported-scale config migration. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  ENV_VARS,
  envOverrides,
  loadConfig,
  parseConfigYaml,
} from "../src/config/index.js";
import { compareHealthDecimals, parseHealthDecimal } from "../src/health/decimal.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playops-threshold-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function load(yaml: string, env: Record<string, string | undefined> = {}) {
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, yaml);
  return loadConfig({ configPath, env });
}

const DISABLED = {
  crashRateReportedThreshold: null,
  anrRateReportedThreshold: null,
  excessiveWakeupRateReportedThreshold: null,
};

const FIELDS = [
  [
    "crashRateReportedThreshold",
    "crash_rate_reported_threshold",
    "PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD",
  ],
  [
    "anrRateReportedThreshold",
    "anr_rate_reported_threshold",
    "PLAYOPS_HEALTH_ANR_RATE_REPORTED_THRESHOLD",
  ],
  [
    "excessiveWakeupRateReportedThreshold",
    "excessive_wakeup_rate_reported_threshold",
    "PLAYOPS_HEALTH_EXCESSIVE_WAKEUP_RATE_REPORTED_THRESHOLD",
  ],
] as const;

function expectConfigError(action: () => unknown, code: string) {
  try {
    action();
    expect.unreachable("configuration must be rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    expect((error as ConfigError).message).not.toContain("RAW-CONFIG-MARKER");
  }
}

describe("reported-scale health threshold config", () => {
  it("malformed quoted threshold YAML never echoes the raw config value", () => {
    expectConfigError(
      () => parseConfigYaml('health:\n  crash_rate_reported_threshold: "RAW-CONFIG-MARKER\n'),
      "CONFIG_MALFORMED_YAML",
    );
  });

  it("omitted thresholds disable all three kinds with no legacy numeric defaults", () => {
    expect(load("{}\n").health).toEqual(DISABLED);
    expect(DEFAULT_CONFIG.health).toEqual(DISABLED);
  });

  it("empty health mapping disables all three kinds", () => {
    expect(load("health: {}\n").health).toEqual(DISABLED);
  });

  describe.each(FIELDS)("%s", (tsName, yamlName, envName) => {
    it("explicit null is disabled", () => {
      expect(load(`health:\n  ${yamlName}: null\n`).health).toEqual(DISABLED);
    });

    it.each([
      "0",
      "0.01",
      "0.005",
      "0.010000000000000000001",
      "9007199254740993.000000000000001",
      "123456789.0123456789",
      "1e-500",
      "+0.0100",
    ])("preserves quoted %s exactly with no invented upper bound", (value) => {
      expect(load(`health:\n  ${yamlName}: "${value}"\n`).health).toEqual({
        ...DISABLED,
        [tsName]: value,
      });
    });

    it.each(["0.01", "0", "1e-500", "9007199254740993", "true", "[]", "{}"])(
      "rejects non-string YAML %s",
      (value) => {
        expectConfigError(() => load(`health:\n  ${yamlName}: ${value}\n`), "CONFIG_INVALID_TYPE");
      },
    );

    it.each([
      "",
      "   ",
      " 0.01",
      "0.01 ",
      "-0.00000000000000000001",
      "-1e-500",
      "NaN",
      "nan",
      "Infinity",
      "-Infinity",
      ".nan",
      ".inf",
      "-inf",
      "1.2.3",
      "1%",
      "0x1",
      "RAW-CONFIG-MARKER",
      "1e-10001",
    ])("rejects invalid quoted decimal %s without echoing its value", (value) => {
      expectConfigError(() => load(`health:\n  ${yamlName}: "${value}"\n`), "CONFIG_INVALID_VALUE");
    });

    it("env name is explicitly reported-scale", () => {
      expect(ENV_VARS[tsName]).toBe(envName);
    });

    it.each([
      "0",
      "0.010000000000000000001",
      "1e-500",
      "9007199254740993.000000000000001",
      "1000.0000000001",
    ])("preserves env %s exactly and overrides file", (value) => {
      expect(load(`health:\n  ${yamlName}: "2"\n`, { [envName]: value }).health).toEqual({
        ...DISABLED,
        [tsName]: value,
      });
    });

    it.each([
      "",
      "   ",
      " 0.01",
      "-0.01",
      "NaN",
      "Infinity",
      "-Infinity",
      "malformed",
      "null",
      "RAW-CONFIG-MARKER",
    ])("rejects invalid env %s", (value) => {
      expectConfigError(() => envOverrides({ [envName]: value }), "CONFIG_INVALID_VALUE");
    });

    it("absent env does not override an active file field", () => {
      expect(
        load(`health:\n  ${yamlName}: "0.123456789012345678901"\n`, { [envName]: undefined })
          .health[tsName],
      ).toBe("0.123456789012345678901");
    });
  });

  it.each(["crash_rate_threshold", "anr_rate_threshold", "crashRateThreshold", "anrRateThreshold"])(
    "fails closed on retired health.%s even when null",
    (name) => {
      expectConfigError(
        () => parseConfigYaml(`health:\n  ${name}: null\n`),
        "CONFIG_MIGRATION_REQUIRED",
      );
      expectConfigError(
        () => parseConfigYaml(`health:\n  ${name}: 0.01\n`),
        "CONFIG_MIGRATION_REQUIRED",
      );
      expectConfigError(
        () => parseConfigYaml(`health:\n  ${name}: RAW-CONFIG-MARKER\n`),
        "CONFIG_MIGRATION_REQUIRED",
      );
      expect(() => parseConfigYaml(`health:\n  ${name}: null\n`)).toThrow(
        /retired.*reported_threshold/i,
      );
    },
  );

  it.each(["PLAYOPS_HEALTH_CRASH_RATE_THRESHOLD", "PLAYOPS_HEALTH_ANR_RATE_THRESHOLD"])(
    "rejects retired env %s even when blank or a new replacement also exists",
    (name) => {
      for (const value of ["", "0.01", "RAW-CONFIG-MARKER"]) {
        expectConfigError(
          () => envOverrides({ [name]: value, PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD: "2" }),
          "CONFIG_MIGRATION_REQUIRED",
        );
      }
    },
  );

  it.each([
    "crash_rate_reported_thresold",
    "excessive_wakeup_reported_threshold",
    "unknown_threshold",
    "enabled",
    "RAW-CONFIG-MARKER",
  ])("rejects unknown health key %s", (name) => {
    expectConfigError(() => parseConfigYaml(`health:\n  ${name}: null\n`), "CONFIG_INVALID_VALUE");
  });

  it("a valid env cannot mask retired or wrong-typed file settings", () => {
    expectConfigError(
      () =>
        load("health:\n  crash_rate_threshold: 0.01\n", {
          PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD: "2",
        }),
      "CONFIG_MIGRATION_REQUIRED",
    );
    expectConfigError(
      () =>
        load("health:\n  crash_rate_reported_threshold: 0.01\n", {
          PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD: "2",
        }),
      "CONFIG_INVALID_TYPE",
    );
  });

  it("does not mutate the env source, defaults or YAML input", () => {
    const value = "0.010000000000000000001";
    const yaml = `health:\n  anr_rate_reported_threshold: "${value}"\n`;
    const env = Object.freeze({ PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD: value });
    const defaults = structuredClone(DEFAULT_CONFIG);
    const config = load(yaml, env);
    config.health.crashRateReportedThreshold = "99";
    expect(DEFAULT_CONFIG).toEqual(defaults);
    expect(env).toEqual({ PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD: value });
    expect(yaml).toBe(`health:\n  anr_rate_reported_threshold: "${value}"\n`);
  });

  it("does not coerce the full accepted threshold through Number or collapse 1e-500", () => {
    const values = ["0.010000000000000000001", "1e-500", "9007199254740993.000000000000001"];
    const original = globalThis.Number;
    const coerced: unknown[] = [];
    globalThis.Number = new Proxy(original, {
      apply(target, self, args) {
        coerced.push(args[0]);
        return Reflect.apply(target, self, args);
      },
    });
    try {
      for (const value of values) {
        const fromFile = load(`health:\n  crash_rate_reported_threshold: "${value}"\n`).health
          .crashRateReportedThreshold;
        const fromEnv = load("{}\n", { PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD: value }).health
          .crashRateReportedThreshold;
        expect(fromFile).toBe(value);
        expect(fromEnv).toBe(value);
        expect(compareHealthDecimals(parseHealthDecimal(value), parseHealthDecimal("0"))).toBe(1);
      }
      for (const value of values) expect(coerced).not.toContain(value);
      // The reused parser may safely validate the bounded integer exponent -500;
      // it never converts the full Decimal value or coefficient to a Number.
    } finally {
      globalThis.Number = original;
    }
  });
});
