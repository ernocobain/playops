/**
 * Phase 3.5 config additions: review checkpoint path and 9Router LLM settings.
 *
 * Precedence: env > file > defaults.
 * Secrets never appear in error messages.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, ENV_VARS, loadConfig, parseConfigYaml } from "../src/config/index.js";

const FULL_YAML = `
google_play:
  package_name: "com.example.test"
  service_account_json: "/secrets/sa.json"
agent:
  max_steps: 4
  approval_timeout_seconds: 120
audit:
  log_path: "./test-audit.jsonl"
review:
  checkpoint_path: "./data/reviews/checkpoint.json"
llm:
  nine_router:
    base_url: "http://127.0.0.1:20128/v1"
    model: "gpt-4o-mini"
    api_key: "s3cr3t-k3y-v4lu3"
`;

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
  dir = mkdtempSync(join(tmpdir(), "playops-phase35-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("Phase 3.5 config: review checkpoint and 9Router LLM", () => {
  it("loads review.checkpoint_path and llm.nine_router.* from YAML", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, FULL_YAML);
    const config = loadConfig({ configPath: path, env: cleanEnv() });
    expect(config.review.checkpointPath).toBe("./data/reviews/checkpoint.json");
    expect(config.llm.nineRouter.baseUrl).toBe("http://127.0.0.1:20128/v1");
    expect(config.llm.nineRouter.model).toBe("gpt-4o-mini");
    expect(config.llm.nineRouter.apiKey).toBe("s3cr3t-k3y-v4lu3");
  });

  it("defaults review.checkpointPath and llm.nineRouter.* to empty strings (apiKey undefined)", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(
      path,
      "google_play:\n  package_name: com.example.minimal\n  service_account_json: /sa.json\n",
    );
    const config = loadConfig({ configPath: path, env: cleanEnv() });
    expect(config.review.checkpointPath).toBe("");
    expect(config.llm.nineRouter.baseUrl).toBe("");
    expect(config.llm.nineRouter.model).toBe("");
    expect(config.llm.nineRouter.apiKey).toBeUndefined();
  });

  it("env overrides for review and llm take precedence over file", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, FULL_YAML);
    const env = {
      ...cleanEnv(),
      [ENV_VARS.reviewCheckpointPath]: "./env-checkpoint.json",
      [ENV_VARS.llm9RouterBaseUrl]: "http://localhost:9999/v1",
      [ENV_VARS.llm9RouterModel]: "env-model",
      [ENV_VARS.llm9RouterApiKey]: "env-key",
    };
    const config = loadConfig({ configPath: path, env });
    expect(config.review.checkpointPath).toBe("./env-checkpoint.json");
    expect(config.llm.nineRouter.baseUrl).toBe("http://localhost:9999/v1");
    expect(config.llm.nineRouter.model).toBe("env-model");
    expect(config.llm.nineRouter.apiKey).toBe("env-key");
  });

  it("env-only (no file) sets the review/llm fields", () => {
    const path = join(dir, "empty.yaml");
    writeFileSync(path, "{}\n");
    const env = {
      ...cleanEnv(),
      [ENV_VARS.reviewCheckpointPath]: "./only-env.json",
      [ENV_VARS.llm9RouterBaseUrl]: "http://localhost:1111/v1",
      [ENV_VARS.llm9RouterModel]: "only-env-model",
    };
    const config = loadConfig({ configPath: path, env });
    expect(config.review.checkpointPath).toBe("./only-env.json");
    expect(config.llm.nineRouter.baseUrl).toBe("http://localhost:1111/v1");
    expect(config.llm.nineRouter.model).toBe("only-env-model");
    expect(config.llm.nineRouter.apiKey).toBeUndefined();
  });

  it("apiKey env override with empty string results in empty string, not undefined", () => {
    const path = join(dir, "playops.yaml");
    writeFileSync(path, FULL_YAML);
    const env = { ...cleanEnv(), [ENV_VARS.llm9RouterApiKey]: "" };
    const config = loadConfig({ configPath: path, env });
    expect(config.llm.nineRouter.apiKey).toBe("");
  });

  it("YAML secret value is not echoed in parse errors", () => {
    const secret = "SUPER_SECRET_KEY_LEAK_TEST";
    const badYaml = `llm:\n  nine_router:\n    base_url: ${secret}\n    model: [unclosed`;
    expect(() => parseConfigYaml(badYaml)).toThrowError(ConfigError);
    try {
      parseConfigYaml(badYaml);
    } catch (error) {
      expect((error as ConfigError).message).not.toContain(secret);
    }
  });

  it("YAML llm section with wrong type throws CONFIG_INVALID_TYPE", () => {
    const badYaml = `llm:\n  nine_router: "not-a-mapping"\n`;
    expect(() => parseConfigYaml(badYaml)).toThrowError(ConfigError);
    try {
      parseConfigYaml(badYaml);
    } catch (error) {
      expect((error as ConfigError).code).toBe("CONFIG_INVALID_TYPE");
      expect((error as ConfigError).message).toMatch(/llm|nine_router/);
    }
  });

  it("YAML review section with wrong type throws CONFIG_INVALID_TYPE", () => {
    const badYaml = `review: 42\n`;
    expect(() => parseConfigYaml(badYaml)).toThrowError(ConfigError);
    try {
      parseConfigYaml(badYaml);
    } catch (error) {
      expect((error as ConfigError).code).toBe("CONFIG_INVALID_TYPE");
      expect((error as ConfigError).message).toContain("review");
    }
  });
});
