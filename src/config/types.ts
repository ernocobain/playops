/**
 * PlayOps configuration types (through Phase 6.2 diagnostic logging).
 *
 * Only settings required by the current roadmap phases are defined here.
 * Do not add speculative settings without a concrete phase needing them.
 */
import { DEFAULT_LOG_LEVEL, type LogLevel } from "../logging/levels.js";

export interface GooglePlayConfig {
  /** Android package name, e.g. "com.example.app". */
  packageName: string;
  /** Path to the Google service-account JSON. Existence is validated in Phase 0.7, not here. */
  serviceAccountJson: string;
}

export interface AgentConfig {
  /** Agent loop step guard (Phase 2). */
  maxSteps: number;
  /** CLI approval prompt timeout in seconds (Phase 2). */
  approvalTimeoutSeconds: number;
}

export interface HealthConfig {
  /** Exact Reporting decimal scale; no percent conversion. Null disables the rule. */
  crashRateReportedThreshold: string | null;
  /** Exact Reporting decimal scale; no percent conversion. Null disables the rule. */
  anrRateReportedThreshold: string | null;
  /** Exact Reporting decimal scale; no percent conversion. Null disables the rule. */
  excessiveWakeupRateReportedThreshold: string | null;
}

export interface AuditConfig {
  /** Path of the append-only JSONL audit log (Phase 0.6). */
  logPath: string;
}

/** Non-authoritative diagnostics; unrelated to audit storage/durability. */
export interface LoggingConfig {
  level: LogLevel;
}

/** Phase 3.5: review checkpoint for ingestion state persistence. */
export interface ReviewConfig {
  /** Path to the review ingestion checkpoint JSON file. */
  checkpointPath: string;
}

/** Phase 4.2: locally tracked Google Play edit session. */
export interface ReleaseConfig {
  /** Path to the managed Play edit session JSON file. */
  editSessionPath: string;
  /**
   * Path to the durable edit cleanup journal (Phase 4.15). The journal persists
   * the exact edit id of every temporary verification edit PlayOps creates, so a
   * failed cleanup can never lose that identity. Empty means the journal-backed
   * hygiene/cleanup capabilities and the temporary-edit flows are not configured;
   * release composition requires a non-empty path for those capabilities.
   */
  editCleanupJournalPath: string;
}

/** 9Router provider config subset (Phase 3.5). */
export interface NineRouterConfig {
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  /** Opaque model identifier forwarded unchanged. */
  model: string;
  /** Bearer credential; undefined when absent (local 9Router without auth). */
  apiKey?: string;
}

/** Phase 3.5: LLM provider configuration. */
export interface LlmConfig {
  nineRouter: NineRouterConfig;
}

export interface PlayOpsConfig {
  googlePlay: GooglePlayConfig;
  agent: AgentConfig;
  health: HealthConfig;
  audit: AuditConfig;
  logging: LoggingConfig;
  review: ReviewConfig;
  release: ReleaseConfig;
  llm: LlmConfig;
}

/** Deep-partial shape used while layering defaults < file < env. */
export interface PartialPlayOpsConfig {
  googlePlay?: Partial<GooglePlayConfig>;
  agent?: Partial<AgentConfig>;
  health?: Partial<HealthConfig>;
  audit?: Partial<AuditConfig>;
  logging?: Partial<LoggingConfig>;
  review?: Partial<ReviewConfig>;
  release?: Partial<ReleaseConfig>;
  llm?: { nineRouter?: Partial<NineRouterConfig> };
}

/** Defaults applied when the config file omits a value or the file is absent. */
export const DEFAULT_CONFIG: PlayOpsConfig = {
  googlePlay: {
    packageName: "",
    serviceAccountJson: "",
  },
  agent: {
    maxSteps: 20,
    approvalTimeoutSeconds: 300,
  },
  health: {
    crashRateReportedThreshold: null,
    anrRateReportedThreshold: null,
    excessiveWakeupRateReportedThreshold: null,
  },
  audit: {
    logPath: "./logs/playops.audit.jsonl",
  },
  logging: {
    level: DEFAULT_LOG_LEVEL,
  },
  review: {
    checkpointPath: "",
  },
  release: {
    editSessionPath: "",
    editCleanupJournalPath: "",
  },
  llm: {
    nineRouter: {
      baseUrl: "",
      model: "",
    },
  },
};
