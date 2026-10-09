/**
 * Phase 6.3 — PlayOps-owned error taxonomy and the single safe operator-facing
 * presentation boundary.
 *
 * Two jobs, deliberately separated from every domain module:
 *
 * 1. Classify an already-thrown value onto a small stable top-level taxonomy
 *    (`ErrorCategory`) while preserving the precise PlayOps domain code that
 *    the typed error already carries. Classification uses only the error's
 *    declared `name` (a typed discriminant, never the human message) plus the
 *    explicit `code`, or a filesystem/transport system code, or a Google-shaped
 *    numeric HTTP status. Human message text is NEVER parsed, matched, or echoed.
 *
 * 2. Produce a deterministic operator message with optional guidance. The model
 *    contains no stack, no raw `Error`, no `cause` chain, no response body, no
 *    header, and no credential material — because none of those are ever read.
 *
 * Safety properties of the boundary itself:
 * - Reads only a fixed set of OWN data properties through property descriptors,
 *   so getters/proxies/accessors are never invoked.
 * - Never traverses `cause`, `stack`, `message`, headers, config, or any nested
 *   container beyond the two fixed Google-shaped fields; there is no generic
 *   recursive serializer over arbitrary thrown objects.
 * - Total and non-throwing: any hostile input degrades to a generic safe result.
 * - Never mutates the input.
 */
import type { AgentRunCode } from "../runtime/agent/index.js";

/** Small, stable top-level taxonomy derived from the existing implementation. */
export const ERROR_CATEGORIES = [
  "configuration",
  "credentials",
  "permissions",
  "validation",
  "external-api",
  "persistence",
  "verification",
  "conflict",
  "runtime",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Narrow operator-facing model. No stack, no raw cause, no SDK/Gaxios object. */
export interface OperatorError {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly guidance?: string;
  /** Preserved exactly from the input; never converted into a retry suggestion. */
  readonly externalStateUncertain?: boolean;
}

/** Category-level fallback guidance, used when a code/family supplies none. */
const CATEGORY_GUIDANCE: Readonly<Record<ErrorCategory, string>> = Object.freeze({
  configuration:
    "Fix the PlayOps configuration (config/playops.yaml or PLAYOPS_* environment variables) and rerun.",
  credentials:
    "Check the service-account credential path, file permissions, and key validity. Credentials live outside the repository and are never passed on the command line.",
  permissions:
    "An explicit human approval for this exact action is required; approvals are single-use and bound to the exact request.",
  validation: "Correct the supplied input or arguments and rerun.",
  "external-api":
    "Check Google/API or network availability, the configured app, API enablement, and the caller's access. One failure does not prove the API is disabled.",
  persistence:
    "Inspect the local state directory and file permissions. Do not delete or rewrite state files before understanding the failure.",
  verification:
    "Do not assume the change took effect. Inspect the current external state before deciding on any follow-up action.",
  conflict:
    "Re-read the current state and prepare a fresh action; the recorded state no longer matches what is now present.",
  runtime: "This is an internal PlayOps failure. Check the diagnostic record and report the code.",
});

/**
 * Overrides the per-code guidance whenever the failure is known to be
 * externally uncertain. Blind retry of a possibly-mutating outcome is never
 * suggested.
 */
const UNCERTAIN_GUIDANCE =
  "External state may already have changed. Do not retry automatically; inspect the current state before acting.";

/** A per-code override: a message, or a message with a different category/guidance. */
type CodeOverride =
  | string
  | {
      readonly message?: string;
      readonly category?: ErrorCategory;
      readonly guidance?: string;
    };

interface FamilySpec {
  readonly category: ErrorCategory;
  /** Stable code used only when the thrown code is missing or not a safe token. */
  readonly code: string;
  /** Default message for codes this family does not describe individually. */
  readonly message: string;
  readonly guidance?: string;
  readonly codes?: Readonly<Record<string, CodeOverride>>;
}

const CONFIG_GUIDANCE =
  "Fix the PlayOps configuration (config/playops.yaml or PLAYOPS_* environment variables) and rerun.";
const CREDENTIAL_GUIDANCE =
  "Check the service-account credential path, file permissions, and key validity. Credentials live outside the repository and are never passed on the command line.";
const APPROVAL_GUIDANCE =
  "Obtain a fresh approval for the exact action; approvals are single-use and bound to the request they were issued for.";

/**
 * Explicit map from a PlayOps-owned error class to its category. Keys are the
 * classes' declared `name` discriminants (own data properties), so no domain
 * module has to be imported and no message text is ever inspected.
 */
const FAMILIES: Readonly<Record<string, FamilySpec>> = Object.freeze({
  ConfigError: {
    category: "configuration",
    code: "CONFIG_INVALID",
    message: "The PlayOps configuration is invalid.",
    guidance: CONFIG_GUIDANCE,
    codes: {
      CONFIG_NOT_FOUND: "The configured PlayOps configuration file was not found.",
      CONFIG_MALFORMED_YAML: "The PlayOps configuration file is not valid YAML.",
      CONFIG_INVALID_TYPE: "A PlayOps configuration value has the wrong type.",
      CONFIG_INVALID_VALUE: "A PlayOps configuration value is invalid.",
      CONFIG_MIGRATION_REQUIRED: {
        message: "The PlayOps configuration uses retired settings that must be migrated.",
        guidance:
          "Update the configuration to the current field names; retired settings are never converted or reinterpreted.",
      },
    },
  },
  CredentialError: {
    category: "credentials",
    code: "CREDENTIAL_INVALID",
    message: "The service-account credential could not be used.",
    guidance: CREDENTIAL_GUIDANCE,
    codes: {
      CREDENTIAL_PATH_NOT_CONFIGURED: {
        message: "No service-account credential path is configured.",
        guidance:
          "Set google_play.service_account_json (or PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) to an absolute path outside the repository.",
      },
      CREDENTIAL_FILE_NOT_FOUND: "The configured service-account credential file does not exist.",
      CREDENTIAL_NOT_A_FILE: "The configured credential path is not a regular file.",
      CREDENTIAL_NOT_READABLE: {
        message: "The service-account credential file is not readable.",
        guidance: "Check the file mode and ownership; the PlayOps process must be able to read it.",
      },
      CREDENTIAL_MALFORMED_JSON: "The service-account credential file is not valid JSON.",
      CREDENTIAL_ROOT_NOT_OBJECT:
        "The service-account credential file does not contain a JSON object.",
      CREDENTIAL_INVALID_SHAPE: {
        message:
          "The credential file is not a valid Google service-account JSON (type, client_email, private_key and token_uri are required).",
        guidance:
          "Download a fresh service-account key for the intended identity; PlayOps never echoes credential contents.",
      },
    },
  },
  AuthError: {
    category: "credentials",
    code: "AUTH_FAILED",
    message: "Google authentication failed.",
    guidance:
      "Check the service-account key validity, the requested scopes, and network access to Google.",
    codes: {
      INVALID_SCOPE: "The requested Google API scope set is invalid.",
      AUTH_CLIENT_CREATION_FAILED: "The Google authentication client could not be created.",
      ACCESS_TOKEN_FAILED: {
        message: "Google OAuth token acquisition failed.",
        guidance:
          "Check the service-account key validity and network access to Google. Token acquisition alone does not prove API authorization.",
      },
      ACCESS_TOKEN_MISSING: "Google returned no access token.",
    },
  },
  PublisherError: {
    category: "external-api",
    code: "PUBLISHER_ERROR",
    message: "The Google Play request failed.",
    guidance:
      "Check Google Play API enablement and the caller's access for the configured app; do not assume the API is disabled from one failure.",
    codes: {
      INVALID_ARGUMENT: {
        category: "validation",
        message: "The Google Play request was rejected as invalid before it was sent.",
      },
      API_REQUEST_FAILED: "The Google Play API request failed.",
      INVALID_RESPONSE:
        "Google Play returned a response PlayOps could not safely use. Nothing unsafe was applied.",
    },
  },
  ReportingError: {
    category: "external-api",
    code: "REPORTING_ERROR",
    message: "The Play Developer Reporting request failed.",
    guidance:
      "Check Play Developer Reporting API enablement and the caller's vitals access for the configured app.",
    codes: {
      INVALID_ARGUMENT: {
        category: "validation",
        message: "The Reporting request was rejected as invalid before it was sent.",
      },
      API_REQUEST_FAILED: "The Play Developer Reporting API request failed.",
      INVALID_RESPONSE: "The Reporting API returned a response PlayOps could not safely use.",
    },
  },
  AuditError: {
    category: "persistence",
    code: "AUDIT_FAILURE",
    message: "The audit log operation failed.",
    guidance:
      "Inspect the audit log path and permissions. Never rewrite or truncate the append-only log to work around a failure.",
    codes: {
      AUDIT_MALFORMED_LINE: {
        message: "The audit log contains a malformed line.",
        guidance:
          "Inspect the audit record; a malformed line must be repaired deliberately and is never rewritten automatically.",
      },
      AUDIT_WRITE_FAILED:
        "The audit entry could not be written durably. The operation was not recorded.",
      AUDIT_READ_FAILED: "The audit log could not be read.",
    },
  },
  ToolRegistryError: {
    category: "runtime",
    code: "TOOL_REGISTRY_ERROR",
    message: "A tool could not be registered or resolved.",
    guidance:
      "This is an internal wiring failure. Check the diagnostic record and report the code.",
    codes: {
      INVALID_DEFINITION: "A registered tool definition is invalid.",
      DUPLICATE_TOOL: "A tool name was registered more than once.",
      TOOL_NOT_FOUND: "The requested tool is not registered.",
    },
  },
  ApprovalGateError: {
    category: "permissions",
    code: "APPROVAL_FAILED",
    message: "The approval gate refused the action.",
    guidance: APPROVAL_GUIDANCE,
    codes: {
      INVALID_REQUEST: {
        category: "validation",
        message: "The approval request is invalid and no approval was created.",
      },
      TOKEN_INVALID: "The approval token is not valid; nothing was approved.",
      TOKEN_EXPIRED: {
        message: "The approval token has expired; nothing was approved.",
        guidance: "Request a fresh approval for the exact action.",
      },
      TOKEN_ALREADY_USED: {
        message: "The approval token was already used; nothing further was approved.",
        guidance: "Approval tokens are single-use. Request a fresh approval.",
      },
      TOKEN_REQUEST_MISMATCH: {
        message: "The approval does not match this exact request; nothing was approved.",
        guidance:
          "The approval was bound to different details. Request approval for the exact current request.",
      },
      CLI_ARGUMENT_INVALID: {
        category: "validation",
        message: "The approval command-line argument is invalid.",
      },
      AUDIT_FAILURE: {
        category: "persistence",
        message: "The approval could not be recorded in the audit log.",
      },
    },
  },
  VerificationError: {
    category: "persistence",
    code: "VERIFICATION_FAILED",
    message: "Verification evidence could not be recorded.",
    guidance:
      "A verification whose evidence cannot be recorded is not treated as verified. Inspect the audit log before continuing.",
    codes: { AUDIT_FAILURE: "The verification result could not be written to the audit log." },
  },
  LlmError: {
    category: "external-api",
    code: "LLM_FAILED",
    message: "The language-model request failed.",
    guidance:
      "Check the configured model provider, endpoint, and network access. Model calls are never retried automatically.",
    codes: {
      INVALID_REQUEST: {
        category: "validation",
        message: "The language-model request was rejected as invalid before it was sent.",
      },
      NETWORK_ERROR: "The language-model request failed at the network layer.",
      TIMEOUT: "The language-model request timed out.",
      HTTP_ERROR: "The language-model endpoint returned an error status.",
      INVALID_RESPONSE: "The language-model endpoint returned a response PlayOps could not use.",
    },
  },
  BrowserFallbackError: {
    category: "runtime",
    code: "BROWSER_FALLBACK_ERROR",
    message: "The browser-fallback boundary refused the request.",
    guidance:
      "Official APIs are used first; browser fallback is only eligible for a documented API gap.",
    codes: {
      INVALID_REQUEST: {
        category: "validation",
        message: "The browser-fallback request is malformed.",
      },
      CAPABILITY_UNSUPPORTED: {
        category: "validation",
        message: "The requested browser capability is not supported by the adapter.",
      },
      FALLBACK_NOT_ELIGIBLE: {
        category: "permissions",
        message: "Browser fallback is not eligible for this request.",
      },
      ADAPTER_FAILURE: {
        category: "external-api",
        message: "The browser-fallback adapter failed.",
      },
    },
  },
  AgentRunError: {
    category: "configuration",
    code: "AGENT_INVALID_CONFIG",
    message: "The agent run configuration is invalid.",
    guidance: CONFIG_GUIDANCE,
  },
  ReviewIngestionError: {
    category: "persistence",
    code: "REVIEW_INGESTION_ERROR",
    message: "Review ingestion failed and the checkpoint was left unchanged.",
    guidance:
      "Inspect the review checkpoint state before retrying; a failed ingestion never partially commits.",
    codes: {
      INVALID_ARGUMENT: {
        category: "validation",
        message: "The review ingestion input is invalid.",
      },
      REMOTE_DATA_INVALID: {
        category: "validation",
        message: "Google returned a review that PlayOps could not safely normalize.",
      },
      PAGINATION_LOOP: {
        category: "external-api",
        message: "The review listing repeated a page token; ingestion stopped.",
      },
      MAX_PAGES_EXCEEDED: {
        category: "external-api",
        message: "The review listing exceeded the configured page bound; ingestion stopped.",
      },
      CHECKPOINT_INVALID: {
        message: "The review checkpoint file is malformed or has an unsupported version.",
        guidance:
          "Inspect the checkpoint file. PlayOps never overwrites malformed state automatically.",
      },
      CHECKPOINT_PACKAGE_MISMATCH: {
        message: "The review checkpoint belongs to a different package.",
        guidance: "Point review.checkpoint_path at the checkpoint for the configured package.",
      },
      CHECKPOINT_READ_FAILED: "The review checkpoint could not be read.",
      CHECKPOINT_WRITE_FAILED: {
        message: "The review checkpoint could not be written; the run is not reported as complete.",
      },
      SOURCE_FAILED: {
        category: "external-api",
        message: "The review source request failed.",
      },
    },
  },
  ReviewClassificationError: {
    category: "external-api",
    code: "REVIEW_CLASSIFICATION_ERROR",
    message: "Review classification failed.",
    guidance: "No classification was produced; nothing was published.",
    codes: {
      INVALID_ARGUMENT: {
        category: "validation",
        message: "The review classification input is invalid.",
      },
      LLM_FAILED: "The classification model call failed.",
      INVALID_RESPONSE: "The classification model returned an unusable classification.",
    },
  },
  ReviewReplyDraftError: {
    category: "external-api",
    code: "REVIEW_DRAFT_ERROR",
    message: "Reply drafting failed.",
    guidance: "No draft was produced; nothing was published.",
    codes: {
      INVALID_ARGUMENT: { category: "validation", message: "The reply-drafting input is invalid." },
      LLM_FAILED: "The drafting model call failed.",
      INVALID_RESPONSE: "The drafting model returned an unusable reply.",
    },
  },
  ReviewReplyPublishError: {
    category: "external-api",
    code: "REVIEW_PUBLISH_ERROR",
    message: "Publishing the review reply failed.",
    guidance: "Inspect the current review state before deciding on any follow-up action.",
    codes: {
      INVALID_ARGUMENT: { category: "validation", message: "The publish request is invalid." },
      REMOTE_DATA_INVALID: {
        category: "validation",
        message: "The current review state could not be safely normalized.",
      },
      REVIEW_CHANGED: {
        category: "conflict",
        message: "The user review changed since the draft was prepared; nothing was published.",
        guidance: "Rerun the command to draft against the current review.",
      },
      DEVELOPER_REPLY_CHANGED: {
        category: "conflict",
        message:
          "The existing developer reply changed since the draft was prepared; nothing was published.",
        guidance: "Rerun the command to draft against the current review.",
      },
      READ_FAILED: "The current review could not be read.",
      PUBLISH_FAILED: "Google Play rejected or did not confirm the reply publish.",
      PUBLISH_RESPONSE_INVALID:
        "Google Play returned a reply response PlayOps could not safely confirm.",
    },
  },
  ReviewCliError: {
    category: "validation",
    code: "CLI_ARGUMENT_INVALID",
    message: 'Invalid reviews command or arguments. Run "playops reviews --help".',
  },
  HealthCliError: {
    category: "validation",
    code: "CLI_ARGUMENT_INVALID",
    message: 'Invalid health command or arguments. Run "playops health report --help".',
  },
  HealthReportError: {
    category: "persistence",
    code: "HEALTH_REPORT_ERROR",
    message: "The health report could not be produced or saved.",
    guidance: "Inspect the output directory; a failed report is never partially published.",
    codes: {
      OUTPUT_DIRECTORY_INVALID: {
        category: "validation",
        message: "--output-dir must name an existing directory.",
      },
      REPORT_RENDER_FAILED: {
        category: "runtime",
        message: "The health report could not be rendered.",
      },
      REPORT_EXISTS: {
        category: "conflict",
        message: "A report with this exact name already exists; nothing was overwritten.",
        guidance: "Move or rename the existing report, or wait for a new timestamp.",
      },
      REPORT_WRITE_FAILED: "The health report could not be saved to the output directory.",
    },
  },
  HealthError: {
    category: "external-api",
    code: "HEALTH_ERROR",
    message: "The App Health operation failed.",
    guidance: "No partial health data was used; nothing was fabricated.",
    codes: {
      INVALID_ARGUMENT: {
        category: "validation",
        message: "The App Health request input is invalid.",
      },
      REMOTE_DATA_INVALID: {
        category: "validation",
        message: "The Reporting API returned data PlayOps could not safely normalize.",
      },
      PAGINATION_LOOP: "The Reporting listing repeated a page token; the fetch stopped.",
      MAX_PAGES_EXCEEDED:
        "The Reporting listing exceeded the configured page bound; the fetch stopped.",
      SOURCE_FAILED: "The Reporting source request failed.",
      ALERT_AUDIT_FAILED: {
        category: "persistence",
        message: "A threshold alert could not be appended durably to the audit log.",
      },
      INCOMPATIBLE_WINDOWS: {
        category: "validation",
        message: "The current and baseline windows are not comparable.",
      },
      DUPLICATE_IDENTITY: {
        category: "conflict",
        message: "The health data contains duplicate point or rule identities.",
      },
      INVALID_DECIMAL: {
        category: "validation",
        message: "A health value is not a valid decimal.",
      },
    },
  },
  ReviewCompositionError: {
    category: "configuration",
    code: "CONFIG_INVALID",
    message: "The review command configuration is invalid.",
    guidance: CONFIG_GUIDANCE,
  },
  HealthCompositionError: {
    category: "configuration",
    code: "CONFIG_INVALID",
    message: "The health command configuration is invalid.",
    guidance: CONFIG_GUIDANCE,
  },
  ReleaseCompositionError: {
    category: "configuration",
    code: "CONFIG_INVALID",
    message: "The release command configuration is invalid.",
    guidance: CONFIG_GUIDANCE,
  },
  ReleaseError: {
    category: "external-api",
    code: "RELEASE_ERROR",
    message: "The Google Play release operation failed.",
    guidance:
      "Inspect the current Play Console/edit state before deciding on any follow-up action; release mutations are never retried automatically.",
    codes: {
      INVALID_ARGUMENT: {
        category: "validation",
        message: "A release operation argument is invalid.",
      },
      ARTIFACT_NOT_FOUND: {
        category: "validation",
        message: "The configured .aab artifact does not exist.",
      },
      ARTIFACT_INVALID: { category: "validation", message: "The .aab artifact is not usable." },
      ARTIFACT_READ_FAILED: {
        category: "persistence",
        message: "The .aab artifact could not be read.",
      },
      ARTIFACT_CHANGED: {
        category: "conflict",
        message: "The .aab artifact changed during the operation.",
      },
      UPLOAD_FAILED: "The bundle upload to Google Play failed or was not confirmed.",
      UPLOAD_RESPONSE_INVALID: "Google Play returned bundle metadata PlayOps could not safely use.",
      BUNDLE_LIST_FAILED: "The edit's bundle list could not be read from Google Play.",
      EDIT_CREATE_FAILED: {
        message: "A new Google Play edit could not be created.",
        guidance:
          "Creating an edit may invalidate another active edit for this app. Inspect Play Console before retrying.",
      },
      EDIT_INVALID: "Google Play returned an unusable edit identity or expiry.",
      EDIT_SESSION_REQUIRED: {
        category: "conflict",
        message: "No managed Play edit session is tracked; open one explicitly first.",
        guidance:
          "Run the explicit open-edit capability; PlayOps never creates an edit implicitly.",
      },
      EDIT_SESSION_EXPIRED: {
        category: "conflict",
        message: "The tracked Play edit session has expired.",
        guidance: "Open a new edit explicitly; the expired session is not replaced automatically.",
      },
      EDIT_SESSION_ALREADY_OPEN: {
        category: "conflict",
        message: "An unexpired managed Play edit session is already tracked.",
        guidance:
          "Approval does not mean replace. Inspect or clean up the existing session deliberately.",
      },
      EDIT_SESSION_INVALID: {
        category: "conflict",
        message: "The tracked Play edit session could not be validated with Google Play.",
      },
      EDIT_SESSION_PACKAGE_MISMATCH: {
        category: "conflict",
        message: "The tracked Play edit session belongs to a different package.",
      },
      EDIT_SESSION_STORE_INVALID: {
        category: "persistence",
        message: "The release edit-session store is malformed or has an unsupported version.",
        guidance:
          "Inspect the session file; PlayOps never overwrites malformed state automatically.",
      },
      EDIT_SESSION_WRITE_FAILED: {
        category: "persistence",
        message: "A remote edit may exist, but the managed session could not be persisted locally.",
        guidance:
          "External state is uncertain. Inspect Google Play before creating or deleting any edit.",
      },
      TRACK_LIST_FAILED: "The track list could not be read from Google Play.",
      TRACK_READ_FAILED: "The target track could not be read from Google Play.",
      TRACK_MISMATCH: {
        category: "conflict",
        message: "The returned track identity does not match the requested track.",
      },
      UPLOADED_BUNDLE_NOT_FOUND: {
        category: "conflict",
        message: "The uploaded bundle was not found on the managed edit.",
      },
      VERSION_CODE_NOT_GREATER: {
        category: "conflict",
        message: "The uploaded versionCode is not greater than the current target-track maximum.",
        guidance: "Build and upload a strictly higher versionCode before configuring the release.",
      },
      INVALID_RELEASE_CONFIGURATION: {
        category: "validation",
        message: "The configured release intent is invalid.",
      },
      STAGED_ROLLOUT_REQUIRES_EXISTING_RELEASE: {
        category: "conflict",
        message: "A first release on the target track cannot start as a staged rollout.",
      },
      OUTSTANDING_RELEASE_EXISTS: {
        category: "conflict",
        message: "The target track already has a draft, in-progress, or halted release.",
        guidance: "Resolve the outstanding release deliberately; PlayOps never overwrites it.",
      },
      INVALID_RELEASE_NOTES: {
        category: "validation",
        message: "The localized release notes are invalid.",
      },
      CONFIGURED_RELEASE_NOT_FOUND: {
        category: "conflict",
        message: "The configured release no longer exists on the target track.",
      },
      CONFIGURED_RELEASE_AMBIGUOUS: {
        category: "conflict",
        message: "More than one release matches the configured identity.",
      },
      CONFIGURED_RELEASE_CHANGED: {
        category: "conflict",
        message: "The configured release no longer matches the approved intent.",
      },
      TRACK_STATE_NOT_ROUNDTRIPPABLE: {
        category: "conflict",
        message:
          "The current track state cannot be safely round-tripped; no partial update was sent.",
      },
      EDIT_VALIDATION_FAILED: "Google Play rejected the edit during validation.",
      VALIDATION_RESPONSE_MISMATCH: {
        category: "conflict",
        message: "The validation response did not match the managed edit.",
      },
      VALIDATION_RESPONSE_INVALID: "The validation response was malformed or unusable.",
      EDIT_VALIDATION_EXPIRED: {
        category: "conflict",
        message: "The validation result expired before it could be used.",
      },
      INVALID_COMMIT_INTENT: {
        category: "validation",
        message: "The commit intent is invalid or incomplete.",
      },
      COMMIT_POLICY_UNSUPPORTED: {
        category: "validation",
        message:
          "The requested commit policy is not supported; only the fail-closed policy is used.",
      },
      COMMIT_STATE_CHANGED: {
        category: "conflict",
        message: "The approved release state changed before commit; the commit was blocked.",
      },
      COMMIT_REJECTED: "Google Play rejected the commit.",
      CHANGES_ALREADY_IN_REVIEW: {
        category: "conflict",
        message: "Google Play already has changes in review; the commit was blocked.",
        guidance:
          "Resolve the in-review change in Play Console; PlayOps never cancels an in-review submission.",
      },
      COMMIT_FAILED: "The commit attempt failed or was not confirmed.",
      COMMIT_RESPONSE_INVALID:
        "Google Play returned a commit response PlayOps could not safely confirm.",
      COMMIT_SESSION_CLEANUP_FAILED: {
        category: "persistence",
        message: "The commit may have applied, but the local session could not be closed.",
      },
      COMMIT_AUDIT_FAILED: {
        category: "persistence",
        message: "The commit may have applied, but it could not be recorded in the audit log.",
      },
      RELEASE_SUMMARY_READ_FAILED: "The direct release-summary endpoint could not be read.",
      RELEASE_SUMMARY_RESPONSE_INVALID: "The release-summary response was malformed or unusable.",
      COMMITTED_RELEASE_NOT_OBSERVED: {
        category: "conflict",
        message: "The committed release was not observed on the release-summary endpoint.",
      },
      COMMITTED_RELEASE_AMBIGUOUS: {
        category: "conflict",
        message: "More than one committed release matched the expected identity.",
      },
      MANAGED_EDIT_ALREADY_OPEN: {
        category: "conflict",
        message: "A managed Play edit is already open; approval does not override this guard.",
      },
      VERIFICATION_EDIT_CREATE_FAILED: "The temporary verification edit could not be created.",
      VERIFICATION_EDIT_RESPONSE_INVALID:
        "The temporary verification edit returned an unusable identity.",
      VERIFICATION_TRACK_READ_FAILED: "The verification track read failed.",
      VERIFICATION_EVIDENCE_PERSISTENCE_FAILED: {
        category: "persistence",
        message: "The verification lifecycle evidence could not be recorded locally.",
      },
      VERIFICATION_STATE_MISMATCH: {
        category: "conflict",
        message: "The verified track state did not match the expected state.",
      },
      VERIFICATION_EDIT_CLEANUP_FAILED: {
        category: "persistence",
        message: "The temporary verification edit could not be deleted; state is uncertain.",
      },
      VERIFICATION_AUDIT_FAILED: {
        category: "persistence",
        message: "The verification result could not be recorded in the audit log.",
      },
      INVALID_ROLLOUT_FRACTION: {
        category: "validation",
        message: "The requested rollout fraction is invalid.",
      },
      ROLLOUT_FRACTION_NOT_INCREASED: {
        category: "validation",
        message: "The requested rollout fraction is not a strict increase.",
      },
      TARGET_ROLLOUT_RELEASE_NOT_FOUND: {
        category: "conflict",
        message: "The target rollout release was not found.",
      },
      TARGET_ROLLOUT_RELEASE_AMBIGUOUS: {
        category: "conflict",
        message: "More than one release matched the target rollout identity.",
      },
      ROLLOUT_NOT_IN_PROGRESS: {
        category: "conflict",
        message: "The target release is not in progress; its rollout cannot be advanced.",
      },
      ROLLOUT_STATE_CHANGED: {
        category: "conflict",
        message: "The rollout state changed before the update; the change was blocked.",
      },
      ROLLOUT_UPDATE_FAILED: "The rollout update failed or was not confirmed.",
      ROLLOUT_UPDATE_RESPONSE_INVALID: "The rollout update response was malformed or unusable.",
      ROLLOUT_EDIT_VERIFICATION_FAILED: {
        category: "conflict",
        message: "The pre-commit rollout read-back did not match the update.",
      },
      ROLLOUT_EDIT_CREATE_FAILED: "The rollout edit could not be created.",
      ROLLOUT_EDIT_RESPONSE_INVALID: "The rollout edit returned an unusable identity.",
      ROLLOUT_OPERATIONAL_CLEANUP_FAILED: {
        category: "persistence",
        message: "The rollout edit could not be cleaned up; state is uncertain.",
      },
      ROLLOUT_COMMIT_FAILED: "The rollout commit failed or was not confirmed.",
      ROLLOUT_POST_COMMIT_NOT_OBSERVED: {
        category: "conflict",
        message: "The committed rollout was not observed after commit.",
      },
      ROLLOUT_POST_COMMIT_MISMATCH: {
        category: "conflict",
        message: "The committed rollout state did not match the expected state.",
      },
      ROLLOUT_VERIFICATION_BLOCKED_BY_ACTIVE_EDIT: {
        category: "conflict",
        message: "Post-commit verification was blocked by an active managed edit.",
      },
      ROLLOUT_VERIFICATION_CLEANUP_FAILED: {
        category: "persistence",
        message: "The rollout verification edit could not be deleted; state is uncertain.",
      },
      ROLLOUT_AUDIT_FAILED: {
        category: "persistence",
        message: "The rollout result could not be recorded in the audit log.",
      },
      ROLLOUT_STATE_NOT_ROUNDTRIPPABLE: {
        category: "conflict",
        message: "The rollout state cannot be safely round-tripped; no partial update was sent.",
      },
      HALTED_ROLLOUT_FRACTION_MISSING: {
        category: "validation",
        message: "The halted release has no usable rollout fraction.",
      },
      ROLLOUT_STATUS_NOT_ELIGIBLE: {
        category: "conflict",
        message: "The target release status is not eligible for this rollout transition.",
      },
      STATUS_CONTROL_EDIT_CREATE_FAILED: "The status-control edit could not be created.",
      STATUS_CONTROL_EDIT_RESPONSE_INVALID:
        "The status-control edit returned an unusable identity.",
      STATUS_CONTROL_UPDATE_FAILED: "The status-only track update failed or was not confirmed.",
      STATUS_CONTROL_UPDATE_RESPONSE_INVALID:
        "The status-only update response was malformed or unusable.",
      STATUS_CONTROL_EDIT_VERIFICATION_FAILED: {
        category: "conflict",
        message: "The pre-commit status read-back did not match the update.",
      },
      STATUS_CONTROL_COMMIT_FAILED: "The status-control commit failed or was not confirmed.",
      STATUS_CONTROL_POST_COMMIT_NOT_OBSERVED: {
        category: "conflict",
        message: "The committed status change was not observed after commit.",
      },
      STATUS_CONTROL_POST_COMMIT_MISMATCH: {
        category: "conflict",
        message: "The committed status state did not match the expected state.",
      },
      STATUS_CONTROL_VERIFICATION_BLOCKED_BY_ACTIVE_EDIT: {
        category: "conflict",
        message: "Post-commit status verification was blocked by an active managed edit.",
      },
      STATUS_CONTROL_VERIFICATION_CLEANUP_FAILED: {
        category: "persistence",
        message: "The status verification edit could not be deleted; state is uncertain.",
      },
      STATUS_CONTROL_AUDIT_FAILED: {
        category: "persistence",
        message: "The status-control result could not be recorded in the audit log.",
      },
      EDIT_CLEANUP_JOURNAL_INVALID: {
        category: "persistence",
        message: "The known-edit journal is malformed or has an unsupported version.",
      },
      EDIT_CLEANUP_JOURNAL_READ_FAILED: {
        category: "persistence",
        message: "The known-edit journal could not be read.",
      },
      EDIT_CLEANUP_JOURNAL_WRITE_FAILED: {
        category: "persistence",
        message: "The known-edit journal record could not be written.",
      },
      EDIT_CLEANUP_JOURNAL_PACKAGE_MISMATCH: {
        category: "conflict",
        message: "The known-edit journal entry belongs to a different package.",
      },
      EDIT_CLEANUP_JOURNAL_REMOVE_FAILED: {
        category: "persistence",
        message: "The known-edit journal record could not be removed.",
      },
      EDIT_CLEANUP_RECORD_NOT_FOUND: {
        category: "conflict",
        message: "The bound known-edit record no longer exists.",
      },
      EDIT_CLEANUP_RECORD_CHANGED: {
        category: "conflict",
        message: "The bound known-edit record changed; the cleanup was blocked.",
      },
      EDIT_CLEANUP_RECONCILE_FAILED: {
        category: "persistence",
        message: "The local known-edit record could not be reconciled.",
      },
      EDIT_CLEANUP_REMOTE_DELETE_UNVERIFIABLE: {
        category: "conflict",
        message: "The remote edit could not be confirmed deletable; no delete was attempted.",
      },
      EDIT_CLEANUP_REMOTE_DELETE_FAILED: {
        category: "conflict",
        message: "The remote edit delete failed or was not confirmed.",
      },
      EDIT_CLEANUP_REMOTE_INACTIVE_UNVERIFIED: {
        category: "conflict",
        message: "The remote edit could not be verified as inactive; no cleanup was recorded.",
      },
      EDIT_CLEANUP_STATE_UNKNOWN: {
        category: "conflict",
        message: "The remote edit state could not be determined; nothing was changed.",
      },
      EDIT_HYGIENE_STATE_INVALID: {
        category: "persistence",
        message: "The edit-hygiene state could not be read or normalized.",
      },
      VERIFICATION_JOURNAL_WRITE_FAILED: {
        category: "persistence",
        message: "The verification journal record could not be written.",
      },
      VERIFICATION_JOURNAL_REMOVE_FAILED: {
        category: "persistence",
        message: "The verification journal record could not be removed.",
      },
      ROLLOUT_JOURNAL_WRITE_FAILED: {
        category: "persistence",
        message: "The rollout journal record could not be written.",
      },
      ROLLOUT_JOURNAL_REMOVE_FAILED: {
        category: "persistence",
        message: "The rollout journal record could not be removed.",
      },
      STATUS_CONTROL_JOURNAL_WRITE_FAILED: {
        category: "persistence",
        message: "The status-control journal record could not be written.",
      },
      STATUS_CONTROL_JOURNAL_REMOVE_FAILED: {
        category: "persistence",
        message: "The status-control journal record could not be removed.",
      },
      TRACK_INVALID: { category: "validation", message: "The target track identifier is invalid." },
      REMOTE_DATA_INVALID: {
        category: "validation",
        message: "Google Play returned release data PlayOps could not safely normalize.",
      },
    },
  },
});

/** Stable fallback for a thrown value PlayOps cannot classify. */
const INTERNAL_ERROR: OperatorError = Object.freeze({
  category: "runtime",
  code: "INTERNAL_ERROR",
  message: "An unexpected internal PlayOps failure occurred.",
  guidance: CATEGORY_GUIDANCE.runtime,
});

const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SYSTEM_CODE = /^E[A-Z][A-Z0-9_]{0,32}$/u;

/** Read ONE own data property without ever invoking a getter or proxy trap. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    // A hostile proxy/getOwnPropertyDescriptor trap must not escape the boundary.
    return undefined;
  }
}

function ownString(value: unknown, key: string): string | undefined {
  const found = ownValue(value, key);
  return typeof found === "string" ? found : undefined;
}

function ownBoolean(value: unknown, key: string): boolean | undefined {
  const found = ownValue(value, key);
  return typeof found === "boolean" ? found : undefined;
}

function numericHttpStatus(raw: unknown): number | undefined {
  const value = typeof raw === "string" && /^\d{3}$/u.test(raw) ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

/** Google/Gaxios-shaped input: a numeric HTTP status on the error or its response. */
function googleHttpStatus(error: unknown): number | undefined {
  const response = ownValue(error, "response");
  return numericHttpStatus(
    ownValue(response, "status") ?? ownValue(error, "status") ?? ownValue(error, "code"),
  );
}

/** Node system code (filesystem or transport) declared as an own string property. */
function systemCode(error: unknown): string | undefined {
  const code = ownString(error, "code");
  return code !== undefined && SYSTEM_CODE.test(code) ? code : undefined;
}

function classifyFamily(name: string, rawCode: string | undefined): OperatorError | undefined {
  const family: FamilySpec | undefined = FAMILIES[name];
  if (family === undefined) return undefined;
  const override: CodeOverride | undefined =
    rawCode !== undefined ? family.codes?.[rawCode] : undefined;
  const spec = typeof override === "string" ? { message: override } : override;
  const category = spec?.category ?? family.category;
  const message = spec?.message ?? family.message;
  const guidance = spec?.guidance ?? family.guidance ?? CATEGORY_GUIDANCE[category];
  // Preserve the precise PlayOps code when it is a safe token; otherwise fall
  // back to a stable family code. Human text is never echoed.
  const code = rawCode !== undefined && SAFE_CODE.test(rawCode) ? rawCode : family.code;
  return Object.freeze({ category, code, message, guidance });
}

/**
 * Classify any thrown value into the operator-facing model. Total: it never
 * throws, never reads a message/stack/cause, and never mutates its input.
 */
export function toOperatorError(error: unknown): OperatorError {
  try {
    const name = ownString(error, "name");
    if (name !== undefined && name !== "Error") {
      const byFamily = classifyFamily(name, ownString(error, "code"));
      if (byFamily !== undefined) return withUncertainty(byFamily, error);
    }

    const transport = systemCode(error);
    if (transport !== undefined) {
      const category: ErrorCategory = NETWORK_CODES.has(transport) ? "external-api" : "persistence";
      return withUncertainty(
        Object.freeze({
          category,
          code: transport,
          message:
            category === "external-api"
              ? `A network transport operation failed (${transport}).`
              : `A local file operation failed (${transport}).`,
          guidance: CATEGORY_GUIDANCE[category],
        }),
        error,
      );
    }

    const status = googleHttpStatus(error);
    if (status !== undefined) {
      return withUncertainty(
        Object.freeze({
          category: "external-api",
          code: "GOOGLE_API_ERROR",
          message: `A Google API request failed (HTTP ${status}).`,
          guidance: CATEGORY_GUIDANCE["external-api"],
        }),
        error,
      );
    }

    return withUncertainty(INTERNAL_ERROR, error);
  } catch {
    // Even a broken getter/proxy inside classification stays safe.
    return INTERNAL_ERROR;
  }
}

/**
 * Apply the preserved `externalStateUncertain` flag. A true value always
 * replaces the guidance with the explicit do-not-retry instruction, so an
 * uncertain outcome can never be presented as a generic retry suggestion.
 */
function withUncertainty(presented: OperatorError, error: unknown): OperatorError {
  const uncertain = ownBoolean(error, "externalStateUncertain");
  if (uncertain === undefined) return presented;
  return Object.freeze({
    ...presented,
    externalStateUncertain: uncertain,
    guidance: uncertain ? UNCERTAIN_GUIDANCE : presented.guidance,
  });
}

/** Deterministic single-entry rendering for stderr. No stack, no cause chain. */
export function formatOperatorError(error: OperatorError): string {
  const head = `PlayOps ${error.category} failure (${error.code}): ${error.message}`;
  return error.guidance === undefined ? head : `${head}\n${error.guidance}`;
}

/** Last-resort boundary: never throws; returns the exact line(s) to print. */
export function presentOperatorError(error: unknown): string {
  try {
    return formatOperatorError(toOperatorError(error));
  } catch {
    return formatOperatorError(INTERNAL_ERROR);
  }
}

/** Operator-facing model for the agent loop's typed failure codes. */
const AGENT_FAILURE_PRESENTATION: Readonly<
  Record<Exclude<AgentRunCode, "COMPLETED">, OperatorError>
> = Object.freeze({
  EMPTY_RESPONSE: {
    category: "runtime",
    code: "EMPTY_RESPONSE",
    message: "The agent produced an empty response.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  INVALID_TOOL_CALL: {
    category: "validation",
    code: "INVALID_TOOL_CALL",
    message: "The model returned a malformed or duplicate tool call.",
    guidance: CATEGORY_GUIDANCE.validation,
  },
  UNKNOWN_TOOL: {
    category: "validation",
    code: "UNKNOWN_TOOL",
    message: "The model requested a tool that is not available for this operation.",
    guidance: CATEGORY_GUIDANCE.validation,
  },
  INPUT_INVALID: {
    category: "validation",
    code: "INPUT_INVALID",
    message: "A tool input failed validation; nothing was executed.",
    guidance: CATEGORY_GUIDANCE.validation,
  },
  OUTPUT_INVALID: {
    category: "validation",
    code: "OUTPUT_INVALID",
    message: "A tool produced output that failed validation; it was not used.",
    guidance: CATEGORY_GUIDANCE.verification,
  },
  VERIFIER_REQUIRED: {
    category: "verification",
    code: "VERIFIER_REQUIRED",
    message: "A mutating tool has no post-action verification and was refused.",
    guidance: CATEGORY_GUIDANCE.verification,
  },
  APPROVAL_REQUIRED: {
    category: "permissions",
    code: "APPROVAL_REQUIRED",
    message: "An explicit human approval is required and was not available.",
    guidance: CATEGORY_GUIDANCE.permissions,
  },
  APPROVAL_DENIED: {
    category: "permissions",
    code: "APPROVAL_DENIED",
    message: "The action was denied or the approval was cancelled.",
    guidance: CATEGORY_GUIDANCE.permissions,
  },
  PERMISSION_DENIED: {
    category: "permissions",
    code: "PERMISSION_DENIED",
    message: "The permission engine refused the action.",
    guidance: CATEGORY_GUIDANCE.permissions,
  },
  EXECUTION_FAILED: {
    category: "runtime",
    code: "EXECUTION_FAILED",
    message: "A tool execution failed.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  VERIFICATION_FAILED: {
    category: "verification",
    code: "VERIFICATION_FAILED",
    message: "The post-action verification did not confirm the change.",
    guidance: CATEGORY_GUIDANCE.verification,
  },
  SERIALIZATION_FAILED: {
    category: "runtime",
    code: "SERIALIZATION_FAILED",
    message: "A verified tool result could not be serialized safely.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  MAX_STEPS_REACHED: {
    category: "runtime",
    code: "MAX_STEPS_REACHED",
    message: "The run reached its maximum step count before finishing.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  MAX_TOOL_CALLS_REACHED: {
    category: "runtime",
    code: "MAX_TOOL_CALLS_REACHED",
    message: "The run reached its maximum tool-call count before finishing.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  TOKEN_BUDGET_EXCEEDED: {
    category: "runtime",
    code: "TOKEN_BUDGET_EXCEEDED",
    message: "The run exceeded its token budget.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  USAGE_UNAVAILABLE: {
    category: "runtime",
    code: "USAGE_UNAVAILABLE",
    message: "Token usage was unavailable, so the budget could not be enforced.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  COST_BUDGET_EXCEEDED: {
    category: "runtime",
    code: "COST_BUDGET_EXCEEDED",
    message: "The run exceeded its estimated cost budget.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  COST_ESTIMATION_FAILED: {
    category: "runtime",
    code: "COST_ESTIMATION_FAILED",
    message: "Cost estimation failed during the run.",
    guidance: CATEGORY_GUIDANCE.runtime,
  },
  LLM_FAILED: {
    category: "external-api",
    code: "LLM_FAILED",
    message: "A language-model call failed during the run.",
    guidance: CATEGORY_GUIDANCE["external-api"],
  },
  AUDIT_FAILURE: {
    category: "persistence",
    code: "AUDIT_FAILURE",
    message: "The run could not record an audit entry and was stopped.",
    guidance: CATEGORY_GUIDANCE.persistence,
  },
});

/** Map an agent-loop failure code onto the same operator-facing model. */
export function presentAgentFailure(code: string): OperatorError {
  const found = (AGENT_FAILURE_PRESENTATION as Readonly<Record<string, OperatorError | undefined>>)[
    code
  ];
  return found ?? INTERNAL_ERROR;
}
