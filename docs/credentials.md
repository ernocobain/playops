# Credentials and configuration

[Quickstart](../README.md) · [Permissions and approvals](permissions-and-approvals.md)

## Google setup is separate from local configuration

PlayOps currently uses a Google **service-account JSON file**, not an interactive Google login, pasted access token, or automatic credential discovery.

1. Create or select your Google Cloud project and service account. Enable the Google Play Android Developer API (Android Publisher) and, for doctor/health, the Google Play Developer Reporting API.
2. Grant that service account access to the intended application in Google Play Console's **Users and permissions**, with only the rights needed for the operations you intend to use. Google Cloud API enablement and Play Console app authorization are separate requirements. Do not add release rights merely to run a connectivity check.
3. Obtain the service-account JSON using your organization's key-management policy. Store it **outside the repository and installed package**; provide PlayOps only its path. Never commit it, paste it into a ticket/chat, or place it in an audit/log message.

Google's [Publisher setup guide](https://developers.google.com/android-publisher/getting_started) and [Reporting setup guide](https://developers.google.com/play/developer/reporting/overview) explain the upstream setup. PlayOps does not create service accounts, enable APIs, grant Play Console permissions, or rotate keys for you. It requests the Android Publisher OAuth scope for reviews/releases and the Play Developer Reporting scope for health; doctor requests both. An OAuth scope is **not** proof of app-level authorization.

## Effective configuration and paths

The CLI loads **`config/playops.yaml` relative to its current working directory**, not the install directory. Precedence is **built-in defaults < YAML file < environment**. A missing default file is allowed and leaves defaults in place; commands that need a package/credential still fail closed when those values are absent. A malformed file fails even if environment variables could otherwise supply its settings.

There is **no `--config` CLI option**, config-path environment override, automatic XDG/home search, or tilde expansion. The internal loader accepts an explicit file path programmatically; that is not an installed CLI feature. A literal `~/...` in YAML is not expanded. Shell expansion before launching a command is a different matter.

`google_play.service_account_json` / `PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` specifies a **file path**, never JSON content. Absolute paths work. Relative paths resolve against `process.cwd()` even if the config file was selected programmatically elsewhere; they are not relative to the YAML file or npm package. Audit/state paths are likewise operator-selected, with relative paths interpreted from cwd. Use a consistent operator working directory and keep writable state outside `node_modules/playops/`.

All names, paths, dates and IDs in these docs are illustrative. This example sets no active health threshold:

```yaml
# In your operator directory: config/playops.yaml
# Fake target/path: replace with your own approved app and external file.
google_play:
  package_name: "com.example.playopsdemo"
  service_account_json: "/path/to/private/example-service-account.json"
audit:
  log_path: "./logs/playops.audit.jsonl"
logging:
  level: info
health:
  crash_rate_reported_threshold: null
  anr_rate_reported_threshold: null
  excessive_wakeup_rate_reported_threshold: null
```

Environment overrides for a fake target/path, not a runnable connectivity test:

```sh
export PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME=com.example.playopsdemo
export PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=/path/to/private/example-service-account.json
```

Changing cwd changes the meaning of relative configuration and credential paths. Installing PlayOps does not relocate, copy, or discover your credentials.

## Credential validation and file protection

The file must exist, be a **readable regular file**, parse as a JSON object, have `type` equal to `service_account`, and contain non-empty `client_email`, `private_key` and `token_uri` strings. This is minimal shape validation, **not** cryptographic private-key validation, token acquisition, or a Google permission test. Symlinks are followed by the current filesystem loader; it does not enforce an ownership/mode policy.

The project keeps operator config and credentials out of the distribution; the repository ignores its local operator config. As an operator precaution on Unix-like systems, limit the credential file to its intended owner (for example, owner-only read/write and a private parent directory). **PlayOps checks readability, not `0600` enforcement.** Use your organization's credential lifecycle and least-privilege policy. Do not assume key-based log redaction makes it safe to log credential contents.

## Settings reference

YAML keys and environment names below are the current loader's actual controls. No environment variable means no override; a present value overrides that field, including a blank string where that field's validation allows it.

| YAML field                          | Environment override                        | Default / purpose                                                                                                                         |
| ----------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `google_play.package_name`          | `PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME`          | Empty; approved Android package target.                                                                                                   |
| `google_play.service_account_json`  | `PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`  | Empty; external credential file path.                                                                                                     |
| `audit.log_path`                    | `PLAYOPS_AUDIT_LOG_PATH`                    | `./logs/playops.audit.jsonl`; append-only operation evidence.                                                                             |
| `logging.level`                     | `PLAYOPS_LOGGING_LEVEL`                     | `info`; `debug`, `info`, `warn`, `error`.                                                                                                 |
| `review.checkpoint_path`            | `PLAYOPS_REVIEW_CHECKPOINT_PATH`            | Empty; required by Review composition; ingestion state.                                                                                   |
| `release.edit_session_path`         | `PLAYOPS_RELEASE_EDIT_SESSION_PATH`         | Empty; required by Release composition; managed edit identity.                                                                            |
| `release.edit_cleanup_journal_path` | `PLAYOPS_RELEASE_EDIT_CLEANUP_JOURNAL_PATH` | Empty; required for journal-backed release verification/control/cleanup capabilities.                                                     |
| `llm.nine_router.base_url`          | `PLAYOPS_LLM_9ROUTER_BASE_URL`              | Empty; HTTP(S) OpenAI-compatible 9Router endpoint for reviews.                                                                            |
| `llm.nine_router.model`             | `PLAYOPS_LLM_9ROUTER_MODEL`                 | Empty; opaque configured provider model ID, not a built-in model choice.                                                                  |
| `llm.nine_router.api_key`           | `PLAYOPS_LLM_9ROUTER_API_KEY`               | Absent; optional provider bearer credential. Prefer secure environment injection, not committed YAML.                                     |
| `agent.max_steps`                   | `PLAYOPS_AGENT_MAX_STEPS`                   | `20`; parsed setting. Review composition requires at least 2; current review/health CLI steps use their own fixed bounded runtime limits. |
| `agent.approval_timeout_seconds`    | `PLAYOPS_AGENT_APPROVAL_TIMEOUT_SECONDS`    | `300`; parsed setting, **not wired to a timeout in the current interactive prompt**. Not the approval-token TTL.                          |

Review commands require checkpoint, audit, Google and 9Router configuration; triage classifies and reply drafts using that provider. Doctor and health do not require an LLM provider. Release operation intent (artifact, track, release, notes, rollout) is trusted **operation-scoped composition input**, not additional YAML or model-selectable config. The installed release CLI does not compose those live operations; see the [release walkthrough](release-pipeline.md).

## Health thresholds: exact reported scale, disabled by default

These are the only accepted current threshold fields:

| YAML field                                        | Environment override                                      |
| ------------------------------------------------- | --------------------------------------------------------- |
| `health.crash_rate_reported_threshold`            | `PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD`            |
| `health.anr_rate_reported_threshold`              | `PLAYOPS_HEALTH_ANR_RATE_REPORTED_THRESHOLD`              |
| `health.excessive_wakeup_rate_reported_threshold` | `PLAYOPS_HEALTH_EXCESSIVE_WAKEUP_RATE_REPORTED_THRESHOLD` |

- In YAML, **`null` or omission = disabled**. There is **no default active threshold** and no recommended operational value.
- An active field must be a **quoted, exact non-negative decimal string**, with no surrounding whitespace. Syntax only, **not a recommendation**: `crash_rate_reported_threshold: "0.01"`. Unquoted YAML numbers are rejected.
- PlayOps compares the API's exact **reported-scale** decimal values; it does **no percent/fraction conversion or aggregation**. The string `"0.01"` is **not established to mean 1%**. Google's descriptive percentage wording is not a conversion factor.
- A present threshold environment override must be a decimal string. Blank, `"null"`, or negative overrides are invalid; remove the environment variable to leave the YAML/default disabled rule effective. There is no environment disable sentinel.
- Legacy YAML `crash_rate_threshold` / `anr_rate_threshold`, typed `crashRateThreshold` / `anrRateThreshold`, and `PLAYOPS_HEALTH_CRASH_RATE_THRESHOLD` / `PLAYOPS_HEALTH_ANR_RATE_THRESHOLD` fail with **`CONFIG_MIGRATION_REQUIRED`**. They are never converted or silently retained. Other unsupported health fields are rejected too.
- Excessive-wakeup thresholds are implemented for `excessiveWakeupRate`, **DAILY only**. Crash/ANR rules use `crashRate` / `anrRate`. A breach is a point strictly **greater than** the configured threshold; equality does not breach, and missing data is not zero.
- `health.check_thresholds` is a separate **runtime capability**, not an installed CLI command. It writes breach-only internal audit alerts, not human notifications. `health report` does not run it, even if thresholds are active.

## Connectivity is not mutation authorization

After deliberate setup, `playops doctor` checks local config → credential shape → token acquisition → a one-review `reviews.list` read → `vitals.anrrate.get`. It is read-only on Google, but **does make live OAuth/API requests** when prerequisites pass. Exit 0 / READY means these checks passed, not that every release/reply operation is authorized. Missing prerequisites skip later checks; exit 1 / NOT READY does not prove connectivity. An empty review list is a successful read. A bare HTTP 403 does not identify the exact cause; check API enablement, effective service-account identity, app access, and required permission without broadening rights indiscriminately.

The recorded project evidence distinguishes:

- **Implemented and fake/mock verified:** runtime permission/approval/verification boundaries, Review publishing safeguards, Release workflow, health reports/thresholds, audit/logging/error contracts, and local-tarball installation on Node 24.
- **Prior live read/connectivity evidence:** the doctor's specific reads succeeded; this is not a blanket production authorization claim.
- **Narrow live cleanup evidence:** one controlled insert/read/delete/post-delete-read observation supports only the contextual cleanup verifier. It is not a universal Google inactive-edit error contract or authorization proof for every application.
- **Still live-unverified:** review reply mutation (`reviews.reply`), bundle upload (`edits.bundles.upload`), release configuration/notes (`edits.tracks.update`), edit commit (`edits.commit`), and rollout/halt/resume mutation authorization. Fake acceptance does not resolve these.

Security review and versioning/release-process work remain separate, unfinished milestones. This guide documents the current controls; it does not declare PlayOps production-authorized.
