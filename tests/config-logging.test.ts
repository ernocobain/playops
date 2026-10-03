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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playops-logging-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function load(yaml: string, env: Record<string, string | undefined> = {}) {
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, yaml);
  return loadConfig({ configPath, env });
}
function fails(action: () => unknown, code: string) {
  try {
    action();
    expect.unreachable("logging configuration must fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    expect((error as ConfigError).message).not.toContain("FAKE-SECRET");
  }
}

describe("minimal structured logging configuration", () => {
  it("defaults to info without needing Google, credentials or an LLM", () => {
    expect(load("{}").logging).toEqual({ level: "info" });
    expect(DEFAULT_CONFIG.logging).toEqual({ level: "info" });
    expect(parseConfigYaml("{}")).toEqual({});
  });

  it.each(["debug", "info", "warn", "error"])(
    "accepts exactly %s from YAML and environment",
    (level) => {
      expect(load(`logging:\n  level: ${level}\n`).logging).toEqual({ level });
      expect(load("{}", { PLAYOPS_LOGGING_LEVEL: level }).logging).toEqual({ level });
    },
  );

  it("follows defaults < YAML < PLAYOPS_LOGGING_LEVEL without changing other settings", () => {
    expect(ENV_VARS.loggingLevel).toBe("PLAYOPS_LOGGING_LEVEL");
    const yaml = "logging:\n  level: warn\naudit:\n  log_path: ./separate-audit.jsonl\n";
    expect(load(yaml).logging).toEqual({ level: "warn" });
    const config = load(yaml, { PLAYOPS_LOGGING_LEVEL: "error" });
    expect(config.logging).toEqual({ level: "error" });
    expect(config.audit.logPath).toBe("./separate-audit.jsonl");
    expect(envOverrides({ PLAYOPS_LOGGING_LEVEL: "debug" })).toEqual({
      logging: { level: "debug" },
    });
  });

  it.each(["trace", "fatal", "INFO", " info", "info ", "", "FAKE-SECRET"])(
    "rejects invalid level without echo: %j",
    (level) => {
      fails(() => load(`logging:\n  level: ${JSON.stringify(level)}\n`), "CONFIG_INVALID_VALUE");
      fails(() => load("{}", { PLAYOPS_LOGGING_LEVEL: level }), "CONFIG_INVALID_VALUE");
    },
  );

  it.each(["null", "123", "true", "[]", "{}"])("rejects wrong-typed YAML level: %s", (value) => {
    fails(() => load(`logging:\n  level: ${value}\n`), "CONFIG_INVALID_TYPE");
  });

  it("uses info for omitted level and rejects non-mapping logging", () => {
    expect(load("logging: {}\n").logging).toEqual({ level: "info" });
    fails(() => load("logging: []\n"), "CONFIG_INVALID_TYPE");
  });

  it("does not let an env override silently repair invalid YAML", () => {
    fails(
      () => load("logging:\n  level: FAKE-SECRET\n", { PLAYOPS_LOGGING_LEVEL: "info" }),
      "CONFIG_INVALID_VALUE",
    );
  });

  it("does not mutate caller env or shared defaults", () => {
    const env = Object.freeze({ PLAYOPS_LOGGING_LEVEL: "debug" });
    const before = structuredClone(DEFAULT_CONFIG);
    const config = load("logging:\n  level: warn\n", env);
    config.logging.level = "error";
    expect(env).toEqual({ PLAYOPS_LOGGING_LEVEL: "debug" });
    expect(DEFAULT_CONFIG).toEqual(before);
    expect(load("{}").logging).toEqual({ level: "info" });
  });
});
