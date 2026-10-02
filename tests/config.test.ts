/**
 * Phase 0.5 — config loader unit tests.
 *
 * All file access uses isolated temp directories; process.env is always
 * restored after each test; no test touches real Google credentials.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  ENV_VARS,
  loadConfig,
  parseConfigYaml,
} from "../src/config/index.js";

const VALID_YAML = `
google_play:
  package_name: "com.example.fromfile"
  service_account_json: "/secrets/sa.json"
agent:
  max_steps: 42
health:
  crash_rate_threshold: 0.5
audit:
  log_path: "./from-file.jsonl"
`;

/** Env map with every PLAYOPS_* var stripped — hermetic baseline. */
function cleanEnv(): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("PLAYOPS_")) result[key] = value;
  }
  return result;
}

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playops-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("loadConfig", () => {
  it("loads a valid YAML config file", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, VALID_YAML);

    const config = loadConfig({ configPath: path, env: cleanEnv() });

    expect(config.googlePlay.packageName).toBe("com.example.fromfile");
    expect(config.googlePlay.serviceAccountJson).toBe("/secrets/sa.json");
    expect(config.agent.maxSteps).toBe(42);
    // untouched sections keep defaults
    expect(config.agent.approvalTimeoutSeconds).toBe(DEFAULT_CONFIG.agent.approvalTimeoutSeconds);
    expect(config.health.crashRateThreshold).toBe(0.5);
    expect(config.health.anrRateThreshold).toBe(DEFAULT_CONFIG.health.anrRateThreshold);
    expect(config.audit.logPath).toBe("./from-file.jsonl");
  });

  it("applies defaults when the default config file is absent", () => {
    // A real operator may have an ignored local config in the repo.
    // Make the default path resolve inside this test's empty temp directory.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      expect(loadConfig({ env: cleanEnv() })).toEqual(DEFAULT_CONFIG);
    } finally {
      cwd.mockRestore();
    }
  });

  it("throws CONFIG_NOT_FOUND for an explicit path that does not exist", () => {
    const missing = join(dir, "does-not-exist.yaml");
    try {
      loadConfig({ configPath: missing, env: cleanEnv() });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG_NOT_FOUND");
      expect((error as ConfigError).message).toContain(missing);
    }
  });

  it("lets environment variables override the config file", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, VALID_YAML);
    const env = {
      ...cleanEnv(),
      [ENV_VARS.packageName]: "com.example.fromenv",
      [ENV_VARS.maxSteps]: "7",
    };

    const config = loadConfig({ configPath: path, env });

    expect(config.googlePlay.packageName).toBe("com.example.fromenv");
    expect(config.agent.maxSteps).toBe(7);
    // file value survives where env is silent
    expect(config.audit.logPath).toBe("./from-file.jsonl");
  });

  it("precedence chain: env beats file beats defaults on the same key", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, VALID_YAML); // max_steps: 42, default is 20

    const fromFile = loadConfig({ configPath: path, env: cleanEnv() });
    expect(fromFile.agent.maxSteps).toBe(42); // file > default(20)

    const fromEnv = loadConfig({
      configPath: path,
      env: { ...cleanEnv(), [ENV_VARS.maxSteps]: "99" },
    });
    expect(fromEnv.agent.maxSteps).toBe(99); // env > file
  });

  it("defaults apply where neither file nor env define a key", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, "google_play:\n  package_name: com.example.only\n");

    const config = loadConfig({ configPath: path, env: cleanEnv() });
    expect(config.googlePlay.packageName).toBe("com.example.only");
    expect(config.agent).toEqual(DEFAULT_CONFIG.agent);
    expect(config.health).toEqual(DEFAULT_CONFIG.health);
    expect(config.audit).toEqual(DEFAULT_CONFIG.audit);
  });

  it("throws CONFIG_MALFORMED_YAML on broken YAML", () => {
    const path = join(dir, "bad.yaml");
    writeFileSync(path, "google_play:\n  package_name: [unclosed\n  :::bad");

    try {
      loadConfig({ configPath: path, env: cleanEnv() });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG_MALFORMED_YAML");
    }
  });

  it("throws CONFIG_INVALID_TYPE on a wrong-typed value", () => {
    const path = join(dir, "wrong-type.yaml");
    writeFileSync(path, "agent:\n  max_steps: twenty\n");

    try {
      loadConfig({ configPath: path, env: cleanEnv() });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG_INVALID_TYPE");
      expect((error as ConfigError).message).toContain("agent.max_steps");
    }
  });

  it("throws CONFIG_INVALID_VALUE on an out-of-range value", () => {
    const path = join(dir, "range.yaml");
    writeFileSync(path, "health:\n  crash_rate_threshold: 1.5\n");

    try {
      loadConfig({ configPath: path, env: cleanEnv() });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG_INVALID_VALUE");
    }
  });

  it("throws CONFIG_INVALID_VALUE on non-integer max_steps", () => {
    const path = join(dir, "float.yaml");
    writeFileSync(path, "agent:\n  max_steps: 2.5\n");
    expect(() => loadConfig({ configPath: path, env: cleanEnv() })).toThrowError(ConfigError);
  });

  it("throws CONFIG_INVALID_VALUE on a non-numeric env override", () => {
    const env = { ...cleanEnv(), [ENV_VARS.maxSteps]: "lots" };
    try {
      loadConfig({ configPath: join(dir, "x.yaml"), env });
      expect.unreachable("should have thrown");
    } catch (error) {
      // explicit missing path would be CONFIG_NOT_FOUND, so write the file first
      expect((error as ConfigError).code).toBe("CONFIG_NOT_FOUND");
    }

    const path = join(dir, "ok.yaml");
    writeFileSync(path, "{}\n");
    try {
      loadConfig({ configPath: path, env });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG_INVALID_VALUE");
      expect((error as ConfigError).message).toContain(ENV_VARS.maxSteps);
    }
  });

  it("does not check credential-file existence (that is Phase 0.7)", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, VALID_YAML); // service_account_json points to /secrets/sa.json which does not exist

    // Must not throw: loader stores the reference without touching the file.
    const config = loadConfig({ configPath: path, env: cleanEnv() });
    expect(config.googlePlay.serviceAccountJson).toBe("/secrets/sa.json");
  });

  it("parseConfigYaml returns {} for an empty document", () => {
    expect(parseConfigYaml("")).toEqual({});
    expect(parseConfigYaml("# only a comment\n")).toEqual({});
  });

  it("rejects a non-mapping YAML root", () => {
    expect(() => parseConfigYaml("- just\n- a\n- list\n")).toThrowError(ConfigError);
  });
});
