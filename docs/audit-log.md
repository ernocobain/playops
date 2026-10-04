# Audit log, diagnostic logging, and error output

[Quickstart](../README.md) · [Approval flow](permissions-and-approvals.md)

## Audit and diagnostics are different systems

|                | Audit                                                                                                          | Structured diagnostic log                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose        | Security/operation evidence: approvals, execution, verification and threshold breaches.                        | Supplemental operational diagnostics. **Not authoritative audit evidence.**                                                                          |
| Destination    | Operator's `audit.log_path` / `PLAYOPS_AUDIT_LOG_PATH`; default `./logs/playops.audit.jsonl`, relative to cwd. | Current CLI writes to **stderr**, never health-report stdout.                                                                                        |
| Format         | Append-only UTF-8 JSONL, one complete newline-terminated object per event.                                     | UTF-8 JSONL envelope `{timestamp, level, message, context?}`. Human-facing errors may also be on stderr; stderr as a whole is not exclusively JSONL. |
| Failure policy | Required audit failures fail closed; they are not silently downgraded to diagnostics.                          | Best effort: clock/serialization/sink failure drops diagnostics without fallback/retry.                                                              |
| Controls       | No log-level filtering of approval/verification/alert evidence.                                                | Minimum `debug < info < warn < error`; default **`info`**.                                                                                           |

Do not use a diagnostic "command completed" line as proof of Google mutation success or durable audit persistence. The specific domain verification and audit events provide the evidence. A command's nonzero exit also does not imply its earlier mutations were rolled back.

## Actual audit record schema

The writer adds a UUID `id` and UTC ISO timestamp (or uses an explicitly supplied timestamp). It creates parent directories when needed and uses append mode; it never truncates, compacts or rotates the log.

| Field       | Type / meaning                                                         |
| ----------- | ---------------------------------------------------------------------- |
| `id`        | String; writer-generated UUID event identity.                          |
| `timestamp` | String; ISO-8601 UTC timestamp.                                        |
| `type`      | String; namespaced event type.                                         |
| `actor`     | String; event actor, such as `operator`, `system` or `agent`.          |
| `action`    | String; operation/tool identifier.                                     |
| `status`    | `success`, `failure`, `denied` or `pending`.                           |
| `metadata`  | Optional structured object; secret-key values sanitized before append. |

`metadata` is event-specific, not a universal payload schema. The reader preserves file order; missing/empty file returns an empty list, and malformed JSON lines produce `AUDIT_MALFORMED_LINE`. It is not a full schema-validation or tamper-detection service. Preserve a malformed ledger for investigation rather than deleting it to bypass approval state.

### Synthetic JSONL examples

These **invented examples** match the current emitted event fields; they are not copied from real audit logs. The shared request/digest illustrates correlation, not a usable approval token. Each physical line is one complete JSON object.

```jsonl
{"id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-01-01T00:00:00.000Z","type":"approval.requested","actor":"operator","action":"reviews.publish_reply","status":"pending","metadata":{"requestId":"00000000-0000-4000-8000-000000000010","toolName":"reviews.publish_reply","permission":"publish","requestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":"2026-01-01T00:10:00.000Z"}}
{"id":"00000000-0000-4000-8000-000000000002","timestamp":"2026-01-01T00:00:05.000Z","type":"approval.approved","actor":"operator","action":"reviews.publish_reply","status":"success","metadata":{"requestId":"00000000-0000-4000-8000-000000000010","toolName":"reviews.publish_reply","permission":"publish","requestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source":"interactive"}}
{"id":"00000000-0000-4000-8000-000000000003","timestamp":"2026-01-01T00:00:06.000Z","type":"verification.completed","actor":"system","action":"reviews.publish_reply","status":"success","metadata":{"toolName":"reviews.publish_reply","permission":"publish","required":true,"status":"passed","code":"VERIFIED","requestId":"00000000-0000-4000-8000-000000000010","requestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
```

Other real event families include `approval.challenged`, `approval.denied`, `approval.expired`, `approval.consumed`, `agent.run.*`, `agent.tool.*`, and release-specific commit/verification/control events. Raw approval tokens, private keys, credential JSON and request/response bodies must not be supplied as metadata.

### Threshold alerts

`health.check_thresholds` emits `health.threshold.alert` only for actual **strictly greater-than** breaches, with actor `system`, action `health.check_thresholds`, status `success`, and these metadata fields: `metricKind`, `metricName`, `observedValue`, `thresholdValue`, `operator`, `result` (`BREACHED`), `startTimeUtc`, `aggregationPeriod`, `window`, `dimensions`. Observed/threshold decimals retain reported scale. This is an **internal audit alert**, not a human notification or scheduler. Below/equal/no-data results do not append breach alerts. `health report` never triggers threshold evaluation.

## Durability and fail-closed boundaries

Ordinary audit appends use append mode and close the file; **not every audit write requests fsync**. The writer's explicit durable option synchronizes the appended file and containing directory before returning. Phase 5.4 threshold-alert writes require that durable mode; failed/unsupported write, sync or close fails with `AUDIT_WRITE_FAILED`, and threshold execution fails with `ALERT_AUDIT_FAILED` instead of reporting success.

Approval/verification/runtime required audit failures remain fail-closed, independently of diagnostic logging. "Required" does not mean every such write uses durable mode. Writes across multiple events/alerts are ordered but **not transactional**: a partial failure may leave earlier events present, and there is no automatic rollback, multi-process lock or exactly-once guarantee. File/directory fsync does not establish synchronization of all newly created ancestors or verified power-loss behavior.

Keep audit/state directories outside the installed package and protect them with your filesystem access policy. PlayOps creates **new** audit, checkpoint, edit-session and cleanup-journal files owner-only (`0600`, further restricted by a stricter umask) and PlayOps-created parent directories `0700`; the health report is published `0600` into an **operator-supplied existing directory** (its mode is the operator's choice). An **existing** file or directory keeps whatever mode its operator set, and PlayOps never re-permissions, encrypts or signs an existing ledger. Redaction is not access control.

## Redaction: guarantees and limits

The audit metadata sanitizer recursively copies object/array data and replaces sensitive-key values with **`[REDACTED]`**. Matching is case-insensitive; underscore/hyphen separators are removed; exact or suffix matches cover these key families:

`authorization`, `token`, `accessToken`, `refreshToken`, `password`, `secret`, `privateKey`, `clientSecret`.

Examples of recognized forms include `ACCESS_TOKEN`, `refresh_token`, `private_key`, `client-secret`, and `serviceAccountPrivateKey`. Diagnostic context retains that policy and additionally recognizes broader separator forms and **`apiKey` / `api_key`** equivalents. Do **not** assume the audit's older policy also redacts every API-key spelling.

**Neither is universal secret detection.** Free-form arbitrary message/string content is not universally scanned. Developers/operators must select safe static messages and allowlisted metadata; never pass raw credentials, headers, remote SDK bodies, request/response payloads, arbitrary causes, or config/environment dumps into logs. Protected keys are defense in depth, not permission to log secrets under an innocuous key. Audit metadata is not a generic hostile-object serializer; use ordinary safe structured data.

Diagnostic Error context never emits the raw error's message, stack or cause. Its generic Error projection keeps only fixed `name:"Error"`, optional numeric HTTP status and boolean uncertainty; the CLI's thrown-failure diagnostic additionally supplies mapped `category`/`code`/`externalStateUncertain`, not raw error data or user guidance.

## Operator diagnostic controls

Set YAML `logging.level` or override it with `PLAYOPS_LOGGING_LEVEL`. Valid values are exactly lowercase **`debug`, `info`, `warn`, `error`**; default is **`info`**. Blank/case-changed/unsupported values are invalid config. The post-command diagnostic config read falls back safely to info if it cannot load diagnostic settings; it never rewrites the command's result.

The current CLI emits one supplemental lifecycle record after an ordinary command: exit 0 → info/completed, exit 2 → warn/declined, exit 1/thrown failure → error/failed. Help stays quiet. It does not instrument every domain step. No built-in file transport/rotation, remote collector, or OpenTelemetry integration is provided.

## Safe operator-facing errors

Phase 6.3 provides stable **category/code**, a deterministic safe message, optional guidance and preserved `externalStateUncertain` when present. Unknown thrown values use `runtime` / `INTERNAL_ERROR`, not thrown-object serialization. Errors use **stderr**; the unexpected-thrown-failure entrypoint boundary has this form:

```text
PlayOps runtime failure (INTERNAL_ERROR): An unexpected internal PlayOps failure occurred.
```

Guidance may follow on a second line. Existing command-specific safe messages, exit codes, doctor report output and approval prompts are preserved; **not every handled command error displays a taxonomy prefix**. Health stdout remains exactly the saved report bytes, without diagnostics.

There is no raw stack trace, raw Error object or cause chain in that safe boundary, including at debug level. An uncertain external outcome tells the operator that state may already have changed: **do not retry automatically; inspect current state and audit evidence first**. Debug is not permission to expose credentials, tokens or SDK data. This policy does not advertise a global handler for every process crash or a safety contract for repository development scripts.
