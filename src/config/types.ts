/**
 * PlayOps configuration types (Phase 0.5 + Phase 3.5).
 *
 * Only settings required by the current roadmap phases are defined here.
 * Do not add speculative settings without a concrete phase needing them.
 */

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
  /** Crash-rate alert threshold, fraction of sessions (Phase 5). */
  crashRateThreshold: number;
  /** ANR-rate alert threshold, fraction of sessions (Phase 5). */
  anrRateThreshold: number;
}

export interface AuditConfig {
  /** Path of the append-only JSONL audit log (Phase 0.6). */
  logPath: string;
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
    crashRateThreshold: 0.01,
    anrRateThreshold: 0.005,
  },
  audit: {
    logPath: "./logs/playops.audit.jsonl",
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
