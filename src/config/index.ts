/**
 * Public surface of the PlayOps config module (Phase 0.5 + Phase 3.5).
 * Keep this minimal: loadConfig + types + errors + defaults.
 */
export {
  loadConfig,
  parseConfigYaml,
  envOverrides,
  DEFAULT_CONFIG_PATH,
  ENV_VARS,
} from "./loader.js";
export type { LoadConfigOptions } from "./loader.js";
export { ConfigError } from "./errors.js";
export {
  loadServiceAccountCredentials,
  resolveCredentialPath,
  CredentialError,
  type CredentialErrorCode,
  type ServiceAccountCredentials,
} from "./credentials.js";
export {
  DEFAULT_CONFIG,
  type PlayOpsConfig,
  type GooglePlayConfig,
  type AgentConfig,
  type HealthConfig,
  type AuditConfig,
  type ReviewConfig,
  type ReleaseConfig,
  type NineRouterConfig,
  type LlmConfig,
} from "./types.js";
