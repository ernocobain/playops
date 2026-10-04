# PlayOps security review — Phase 6.5

> **Repository-internal review artifact.** It is **not** part of the distributed npm
> package (the packaged operator guides are `docs/credentials.md`,
> `docs/permissions-and-approvals.md`, `docs/audit-log.md`, `docs/release-pipeline.md`
> plus `README.md`). Operator-facing conclusions are distilled into those guides.

## 1. Scope, source reference, method

| Item                        | Value                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Roadmap item                | `6.5 Security review pass: secrets handling, dependency audit, least-privilege scopes documented.`                       |
| Reviewed source             | clean `master` at `458e6ae8d39ef1891d849c259a6265ee4db9307b` (`feat: add safe error taxonomy`) plus this phase's changes |
| Worktree state at preflight | clean, no untracked files                                                                                                |
| Execution policy            | **source-only**, plus two explicitly bounded offline probes (see §3)                                                     |
| Environment                 | official Node.js **v24.21.0** / npm **11.19.0** (scratch-local, not a global install)                                    |

Method: read the complete 1,181-line plan and every Phase 6.1–6.4 contract; inspected
all of `src/` by module (config/credentials, auth, publisher/reporting, retry, runtime
tools/permissions/approvals/verification/agent/LLM/browser, reviews, releases, health,
audit, logging, errors, CLI); built a static inventory of registered tools and Google
mutation sites; audited the locked dependency tree with `npm audit`; retrieved official
Google/npm/Node reference pages read-only and cited them below; ran two bounded,
network-free, scratch-only probes under `bwrap` (`--unshare-all`, cleared environment,
read-only target, scratch-only writes, `prlimit` ceilings, dummy state).

**Not claimed:** this is not penetration testing, not a production certification, and
not a general statement that PlayOps "is secure". It records what was inspected, what
was verified, what could not be verified, and what remains an accepted limitation.

## 2. Checklist (each item is exactly one of PASS / LIMITATION / UNVERIFIED / FINDING)

| #   | Area                                                                                             | Verdict                                                                            |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Credentials kept outside repo/package; path-only configuration                                   | **PASS** (`src/config/credentials.ts:65-69`, `docs/credentials.md`)                |
| 2   | No credential/private-key material in errors, logs, audit or tool output                         | **PASS** (audited paths in §5)                                                     |
| 3   | Redaction predicate covers documented key families in audit and diagnostics                      | **PASS** (`src/shared/redaction.ts`, `src/logging/context.ts:17-22`)               |
| 4   | Free-form strings are not universally secret-scanned                                             | **LIMITATION** (documented, `docs/audit-log.md`)                                   |
| 5   | All production logger call sites use fixed messages + allowlisted metadata                       | **PASS** (§6)                                                                      |
| 6   | CLI safe error boundary: no stack/cause/raw remote body; debug is not a loophole                 | **PASS** (`src/cli/index.ts:55-65`, `src/errors/index.ts`)                         |
| 7   | Packaged artifact excludes config, credentials, state, reports, AAB, Hermes data                 | **PASS** (§7)                                                                      |
| 8   | No production dependency install scripts / native addons                                         | **PASS** (§8)                                                                      |
| 9   | `npm audit` (production and full trees)                                                          | **PASS — 0 vulnerabilities**, §8                                                   |
| 10  | Registry signature/attestation verification                                                      | **PASS** (178 signatures, 49 attestations), §8                                     |
| 11  | Exactly two Google OAuth scopes, least privilege documented                                      | **PASS** (§9)                                                                      |
| 12  | Every `write`/`destructive`/`publish` tool declares a verifier; loop refuses otherwise           | **PASS** (§10)                                                                     |
| 13  | Exact approval binding for `destructive`/`publish`; fail-closed denial/non-interactive           | **PASS** (§10)                                                                     |
| 14  | Model cannot supply operator-bound values (package, paths, approval, intent)                     | **PASS** (§10)                                                                     |
| 15  | One attempt per Google mutation (method-level `retry:false`)                                     | **PASS** (§11)                                                                     |
| 16  | One **workflow-level** delete attempt per temporary edit identity                                | **FINDING F-01 (fixed)**                                                           |
| 17  | Local state files not group/world readable                                                       | **FINDING F-02 (fixed)**                                                           |
| 18  | LLM boundary: untrusted review text, schema-constrained output, no auto-publish                  | **PASS** (§12)                                                                     |
| 19  | No hidden telemetry/analytics destination; outbound hosts limited to Google + configured 9Router | **PASS** (§13)                                                                     |
| 20  | 9Router base URL is operator authority, not model input; URL shape validated                     | **PASS** (§13)                                                                     |
| 21  | Browser fallback remains interface-only, not wired into the agent loop                           | **PASS** (§13)                                                                     |
| 22  | Audit append-only + non-transactional + no tamper evidence                                       | **LIMITATION** (§14)                                                               |
| 23  | Single-process concurrency limits (approval token, checkpoint, session, journal, audit)          | **LIMITATION** (§14)                                                               |
| 24  | Live Google mutation authorization (reply, upload, tracks.update, commit, rollout/halt/resume)   | **UNVERIFIED** (§15)                                                               |
| 25  | Physical TTY, power-loss, multi-user hostile host, pathological-size behaviour                   | **UNVERIFIED** (§15)                                                               |
| 26  | Google SDK debug logging cannot leak token-endpoint bodies by default                            | **PASS by default / FINDING F-04** (env-gated; not enabled by PlayOps; documented) |
| 27  | 9Router destination cannot silently downgrade secrets to cleartext                               | **FINDING F-05** (documented; validation deliberately not changed)                 |
| 28  | Nested classifier/drafter LLM fan-out cannot exceed the operator's agent budget                  | **LIMITATION F-06** (documented)                                                   |
| 29  | Audit append cannot be redirected through a symlink                                              | **FINDING F-07** (documented; main precondition removed by the directory-mode fix) |
| 30  | Consumer install of the local tarball resolves exactly the audited dependency set                | **FINDING F-08** (documented: `^` ranges, no shipped lockfile)                     |
| 31  | Payload validator rejects every non-approved extension/root segment                              | **FINDING F-09** (defense-in-depth gap; the exact `files` allowlist still governs) |

## 3. Bounded probes actually executed

| Probe                         | Command shape                                                                                                                                         | Result                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State-file creation modes     | `bwrap --unshare-all … prlimit --as=16Gi --nproc=64 --fsize=1Mi --nofile=256 --cpu=60 node state-mode-probe.mjs` (dummy state in scratch, no network) | umask `022` → audit/checkpoint/edit-session/cleanup-journal **0644**, report **0600**; umask `002` → **0664** / **0600**                                                                                |
| Same probe after the F-02 fix | identical command                                                                                                                                     | all five writers → **0600**; PlayOps-created parent directories → **0700**; no group/other bits (any umask). An operator-created report directory keeps the operator's mode (PlayOps never creates it). |

Evidence files: `…/playops-phase65-preflight/state-mode-probe.mjs`,
`official-sources.json`, `audit-prod.json`, `audit-all.json`, `tool-inventory.json`,
`gate-*.log`, `package-acceptance.log`.

## 4. Findings

### F-01 — Rollout temporary-edit cleanup could issue a second workflow-level delete

| Field                                 | Detail                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity                              | **P2** (meaningful weakness: violates the project's own one-attempt mutation/uncertainty policy; bounded real-world effect)                                                                                                                                                                                                                                                                                             |
| Component                             | `src/releases/rollout-tool.ts` (post-commit verification of `releases.update_rollout_fraction`)                                                                                                                                                                                                                                                                                                                         |
| Evidence (pre-fix)                    | Delete call at line 715; local handle cleared only **after** success (716-719); outer `catch` deleted again whenever `verificationEdit !== undefined` (729-733); journal-write recovery path could leave the handle set and enter the same second call. Pinned by the then-current test `tests/releases-rollout.test.ts` ("marks verification cleanup failure uncertain without retry") asserting `calls.delete === 2`. |
| Sibling controls (unchanged, correct) | `src/releases/verify-committed-release-tool.ts:355,384,444` (`cleanupAttempted`) and `src/releases/status-control-tool.ts:681,709,733` (`verificationDeleteAttempted`) set the flag **before** the delete and guard the catch; `src/releases/cleanup-tool.ts:437-449` performs a single linear delete.                                                                                                                  |
| Realistic consequence                 | None beyond the intended deletion: the retried call uses the **same exact** temporary identity this workflow created and already intended to delete, so no other operator's edit can be destroyed. Worst case is an extra failing API call (`400 FAILED_PRECONDITION` per the recorded B4 observation) and a misleading "no retry" claim in code/tests.                                                                 |
| Exploit / precondition                | No lower-trust principal is required; it is triggered by a transient remote failure of the first delete (or a failed journal write followed by a failed recovery delete). It is therefore a **policy** defect, not an attacker-reachable weakness.                                                                                                                                                                      |
| Remediation (applied)                 | Added `deleteAttempted`, set **before** each delete attempt; the failure path now performs at most one workflow delete, keeps the journal record so the exact edit id stays discoverable, and reports `ROLLOUT_VERIFICATION_CLEANUP_FAILED` with `externalStateUncertain: true`.                                                                                                                                        |
| Regression tests                      | `tests/releases-rollout.test.ts` — updated normal-path assertion (`delete === 1`, journal record retained) and a new journal-write + delete-failure case asserting exactly one `edits.delete` and no track read.                                                                                                                                                                                                        |
| Status                                | **FIXED and verified** (targeted tests, full gates, package acceptance on Node 24 — §16)                                                                                                                                                                                                                                                                                                                                |

### F-02 — Local state files were created with umask-dependent group/other access

| Field                  | Detail                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity               | **P3** (low-risk hardening; no credential material in these files, single-operator model)                                                                                                                                                                                                                                |
| Component              | `src/audit/log.ts`, `src/reviews/checkpoint/index.ts`, `src/releases/session-store.ts`, `src/releases/cleanup-journal.ts`                                                                                                                                                                                                |
| Evidence               | Node v24.21.0 `fs` reference: `fs.open`/`fsPromises.open` mode default `0o666 (readable and writable)` when a file is created; these four writers passed no mode, while `src/health/report.ts:120` already used `0o600`. Bounded probe measured 0644 (umask 022) / 0664 (umask 002) for all four vs 0600 for the report. |
| What the files contain | Audit: event metadata, review/package identifiers, request and token **digests** (never raw tokens), threshold values, metric values. Checkpoint/session/journal: package name, review ids, edit ids, expiry — operational identifiers, no credentials.                                                                  |
| Realistic consequence  | Another local user (or a process running as another user) on a shared host could read the audit trail and PlayOps state. It does **not** yield credentials, access tokens or the ability to call Google.                                                                                                                 |
| Exploit / precondition | Requires another local principal plus a permissive umask (022/002).                                                                                                                                                                                                                                                      |
| Remediation (applied)  | Explicit `0o600` at creation for all four writers (`openSync(logPath, "a", 0o600)`, `open(tempPath, "wx", 0o600)`); mode survives the atomic rename. Existing files keep their operator-set mode and are never re-permissioned (asserted).                                                                               |
| Regression tests       | `tests/state-file-permissions.test.ts` — no group/other bits for all five writers under umask `000`, `0600` preserved under a stricter umask, and append never re-permissions an existing ledger.                                                                                                                        |
| Status                 | **FIXED and verified** (§16)                                                                                                                                                                                                                                                                                             |

### F-03 — Plan wording overstated the state-file permission guarantee

| Field       | Detail                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity    | **P3** (documentation accuracy)                                                                                                                                                                                                                                                                                                |
| Evidence    | The Phase 6.1 contract described audit logs, checkpoints, edit sessions, cleanup journals and health reports as "hard-linked, exclusive-create, no group/other access" — true only for the health report's exclusive hard-link publication; the four earlier writers used temp `wx` + `fsync` + `rename` and no explicit mode. |
| Remediation | Plan text corrected in the Phase 6.5 record; `docs/audit-log.md` now states the actual policy (new files `0600`, existing file modes untouched, no encryption/signature).                                                                                                                                                      |
| Status      | **FIXED** (documentation only)                                                                                                                                                                                                                                                                                                 |

### F-04 — Google SDK debug logging can write token-endpoint bodies to stderr when an env var is set

| Field                               | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity                            | **P3** (env-gated diagnostic facility of the official SDK; not enabled or reachable by PlayOps defaults)                                                                                                                                                                                                                                                                                                                                  |
| Component                           | `google-auth-library@11.1.0` (`AuthClient` interceptors) + `google-logging-utils@2.0.1`, reached through `src/googleplay/auth/index.ts`                                                                                                                                                                                                                                                                                                   |
| Evidence                            | `node_modules/google-auth-library/build/src/auth/authclient.js:69-72` registers `DEFAULT_REQUEST_INTERCEPTOR`/`DEFAULT_RESPONSE_INTERCEPTOR` unless `useAuthRequestParameters === false`; `:215-226` logs `response.data`; `node_modules/google-logging-utils/build/src/logging-utils.js:329,352-366` makes every SDK logger a no-op **unless** `GOOGLE_SDK_NODE_LOGGING` is set, and `NodeBackend` writes with `console.error` (stderr). |
| Consequence                         | With that variable set, OAuth token-endpoint responses (access token/id token) and other Google response bodies appear on stderr outside PlayOps redaction and can persist in terminal/CI logs.                                                                                                                                                                                                                                           |
| Exploit / precondition              | Requires the operator's own environment to set `GOOGLE_SDK_NODE_LOGGING`. PlayOps never sets it and no untrusted input controls it.                                                                                                                                                                                                                                                                                                       |
| Remediation (recorded, not applied) | Keep the variable unset for PlayOps processes (now stated in `docs/credentials.md`). A code-level alternative exists (`useAuthRequestParameters: false`, or supplying an interceptor-free transporter) but it would also drop the SDK's default `x-goog-api-client`/`User-Agent` request headers, so it was **deliberately not applied** in this phase.                                                                                   |
| Status                              | **Documented** (operator guidance added); no runtime change                                                                                                                                                                                                                                                                                                                                                                               |

### F-05 — 9Router base URL may be a non-loopback plaintext HTTP endpoint

| Field                               | Detail                                                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity                            | **P3** (operator-controlled configuration; no untrusted input)                                                                                                                                                                                                             |
| Component                           | `src/reviews/composition.ts:74-90`, `src/runtime/llm/providers/9router/index.ts:273-294`                                                                                                                                                                                   |
| Evidence                            | Validation enforces scheme ∈ {`http:`,`https:`}, a hostname, and absence of userinfo/query/hash/whitespace — it does not require HTTPS off-loopback. The adapter sends `Authorization: Bearer <apiKey>` plus the review-bearing JSON body to `{baseUrl}/chat/completions`. |
| Consequence                         | A remote `http://` endpoint (operator-set) exposes the bearer key and user review content in cleartext to that host and any on-path observer.                                                                                                                              |
| Exploit / precondition              | Requires the operator to configure a non-loopback `http://` URL; the documented default is `http://127.0.0.1:20128/v1`.                                                                                                                                                    |
| Remediation (recorded, not applied) | Require `https:` for anything that is not strict loopback. Not applied here because rejecting a previously accepted configuration is a compatibility decision rather than a minimal, obviously-safe fix; guidance was added to `docs/credentials.md`.                      |
| Status                              | **Documented**; recommendation recorded for a future phase                                                                                                                                                                                                                 |

### F-06 — Nested classifier/drafter LLM calls are outside the agent budget and scale with review volume

| Field                  | Detail                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity               | **P3** (cost/availability, operator-initiated; already an explicit source-level limitation)                                                                                                                                                                                                            |
| Component              | `src/reviews/classification/index.ts`, `src/reviews/drafting/index.ts`, `src/cli/reviews.ts`, `src/reviews/ingestion/index.ts`                                                                                                                                                                         |
| Evidence               | Classification and drafting call `llm.complete()` directly (source comments state the limitation); `reviews triage` iterates the ingested delta, whose bounds are 50 pages × 100 reviews; the outer `runAgent` limits (`maxSteps`/`maxToolCalls`/`maxTotalTokens`) do not account for the inner calls. |
| Consequence            | One `reviews triage` over a large delta can issue very many sequential provider calls (cost/time) that no PlayOps budget, permission or audit event accounts for. Publishing is still separately approval-gated, so this is not a publish-safety issue.                                                |
| Exploit / precondition | Operator runs triage against a large new/updated review delta (for example after spam activity). No remote party can trigger it directly.                                                                                                                                                              |
| Remediation (recorded) | Cap reviews processed per run and/or propagate inner usage into the agent budget — a product/scale decision, not applied in this pass.                                                                                                                                                                 |
| Status                 | **Documented limitation** (pre-existing, now recorded in the review artifact)                                                                                                                                                                                                                          |

### F-07 — Audit append follows a symlink (`open(…, "a")`)

| Field                               | Detail                                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity                            | **P3** (defense in depth; precondition broadly removed by the F-02 directory fix)                                                                                                                                            |
| Component                           | `src/audit/log.ts` append path; read paths in the three stores and the config loader                                                                                                                                         |
| Evidence                            | `openSync(logPath, "a")` / `readFile(path)` follow symlinks; no `O_NOFOLLOW`. State **writes** are not redirected because they use exclusive temp + `rename`, which replaces the destination entry rather than following it. |
| Consequence                         | A local actor able to create/replace an entry in the state directory could redirect audit appends to another file, or influence a read (reads are bounded by strict structural validation).                                  |
| Exploit / precondition              | Requires write access to the audit/state parent directory — previously possible for a group peer via the umask defaults, now restricted for PlayOps-created directories by F-02's `0700`.                                    |
| Remediation (recorded, not applied) | Open the audit log with `O_NOFOLLOW` (guarding platform availability) and/or verify the parent with `lstat`/`realpath`. Not applied to avoid a platform-fragile change in a hardening pass.                                  |
| Status                              | **Documented**                                                                                                                                                                                                               |

### F-08 — The shipped tarball does not pin runtime dependency versions at consumer install time

| Field                  | Detail                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity               | **P3** (supply-chain/reproducibility observation; no demonstrated compromise)                                                                                                                                                                    |
| Component              | `package.json` runtime ranges; `scripts/package-content.mjs` payload (no `package-lock.json` ships)                                                                                                                                              |
| Evidence               | Direct dependencies use `^` ranges; the payload allowlist excludes the lockfile; the acceptance harness installs the `.tgz` with `npm install --omit=dev`. A consumer install therefore resolves those ranges from the registry at install time. |
| Consequence            | A consumer could get a newer (unreviewed) minor/patch of a direct dependency than the audited set.                                                                                                                                               |
| Exploit / precondition | Requires a networked consumer install of the local tarball; the current distribution model is an operator-built local artifact.                                                                                                                  |
| Remediation (recorded) | Ship exact versions or document consumer pinning/verification. Version/branching policy belongs to Phase 6.6; exact-pinning would also rewrite `package-lock.json`, so it was not done here.                                                     |
| Status                 | **Documented** (+ operator guidance in `docs/credentials.md`)                                                                                                                                                                                    |

### F-09 — Package path validator lags the allowlist (defense in depth)

| Field                  | Detail                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity               | **P3** (validator hardening; the authoritative control still holds)                                                                                                                                                           |
| Component              | `scripts/package-content.mjs` (`FORBIDDEN_EXTENSIONS`, `FORBIDDEN_ROOT_SEGMENTS`)                                                                                                                                             |
| Evidence               | The forbidden-extension set omits `.md`/`.txt`/`.yaml`/`.yml`/`.csv`/`.ini` and the forbidden-root set omits segments such as `bin/`; those checks alone would not flag `notes.md`, `dump.txt`, `secrets.yaml` or `bin/x.js`. |
| Consequence            | None today: the real control is the byte-exact comparison of the packed list against the approved `files` set (`scripts/package-content.mjs`, `scripts/package-acceptance.mjs`).                                              |
| Remediation (recorded) | Extend the negative extension/root lists; reusing the loose check without the exact comparison is what would be unsafe.                                                                                                       |
| Status                 | **Documented**                                                                                                                                                                                                                |

### Candidates raised but **not** findings

| Candidate                                                                       | Why not a finding                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit appends are not fsynced by default                                        | Deliberate, documented durability policy; required writes (threshold alerts) use the durable option and fail closed. Availability/durability tradeoff, not a vulnerability.                                                                                                                                                                                                  |
| Approval token consumption is check-then-append with no lock                    | Accepted single-operator/single-process design constraint, disclosed in source and docs; no multi-instance deployment is advertised.                                                                                                                                                                                                                                         |
| `openSync(logPath, "a")` on an existing path follows the operator's own symlink | The path is operator-controlled configuration; no untrusted path component reaches it.                                                                                                                                                                                                                                                                                       |
| `normalizeScopes` error message includes the offending scope value              | It is a **scope string** (not a secret) supplied by the caller; no credential/token content.                                                                                                                                                                                                                                                                                 |
| `getGoogleAccessToken` embeds the library message in the `AuthError` message    | Flagged for the record: google-auth-library token errors are already sanitized upstream for credential material and the boundary keeps `cause` programmatic; the CLI never renders this message (Phase 6.3 renders a fixed taxonomy message). Residual risk limited to library messages containing the token endpoint/project identifiers in an unhandled programmatic path. |
| Release configuration constructs a one-release track array                      | Assessed in §11: bounded, approval-gated, and target-release-scoped verification; not a security defect.                                                                                                                                                                                                                                                                     |

## 5. Secrets inventory (source → consumer → persistence)

| Secret-bearing input                                                   | Source                                                    | In-memory consumer                                                                       | Persisted?                                                                                     | Logged?                                   | Audited?                                                                 | Serialized to model/tool output?  | In errors?                                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| Service-account JSON file (`private_key`, `client_email`, `token_uri`) | Operator path in config (`googlePlay.serviceAccountJson`) | `loadServiceAccountCredentials` → `ServiceAccountCredentials` → `createGoogleAuthClient` | No (file stays external; only its path is echoable metadata)                                   | No                                        | No                                                                       | Never                             | Never (`CredentialError` carries path+code only)                       |
| OAuth access token                                                     | `JWT.getAccessToken()`                                    | Passed to Google client constructors                                                     | No                                                                                             | No                                        | No                                                                       | No                                | No (`ACCESS_TOKEN_MISSING`/`FAILED` fixed messages)                    |
| 9Router API key                                                        | `llm.nine_router.api_key` / `PLAYOPS_LLM_9ROUTER_API_KEY` | `create9RouterAdapter` → `Authorization` header only                                     | No                                                                                             | No (key is a redaction-recognized family) | No                                                                       | No                                | No (non-2xx body deliberately not read)                                |
| Authorization headers                                                  | Google SDK / 9Router fetch                                | Transport only                                                                           | No                                                                                             | No                                        | No                                                                       | No                                | No                                                                     |
| Approval tokens (256-bit)                                              | `randomBytes` in the approval gate                        | `resolveApprovalToken`                                                                   | Only `sha256` `proofDigest` in the audit ledger                                                | No                                        | Digest only                                                              | Never (grants carry no raw token) | No (fixed messages)                                                    |
| Credential/state paths                                                 | Operator config                                           | Loaders/stores                                                                           | Path strings in state files where required (session/journal are package-bound, not path-bound) | Allowlisted `command`/`exitCode` only     | Not audited                                                              | Not model-facing                  | Path appears in `CredentialError` message (operator-facing, by design) |
| Google SDK/Gaxios error objects                                        | SDK                                                       | `projectPublisherErrorMetadata` (allowlist)                                              | No                                                                                             | No                                        | Allowlisted `status`/`googleStatus`/`googleReasons`/`transportCode` only | No                                | No (code + numeric status only)                                        |
| HTTP request/response metadata                                         | SDK/fetch                                                 | Transport only                                                                           | No                                                                                             | No                                        | No                                                                       | No                                | No                                                                     |

## 6. Logger, error and audit call-site review

- The only production logger call sites are `src/cli/logging.ts:63-65` with the three
  fixed messages `CLI command completed.` / `declined.` / `failed.` and the allowlisted
  context `command`, `exitCode`, plus `category`/`code`/`externalStateUncertain` derived
  from the safe taxonomy boundary — never a message, stack, cause or raw error.
- `src/cli/index.ts` writes command output/`report` bytes to stdout and human command
  errors via `console.error(text)`; those `text` values are fixed strings produced by the
  command handlers (verified in Phase 6.3 and re-checked here). The unexpected-thrown
  path renders `presentOperatorError(cause)` to stderr via `writeSync`.
- `src/logging/context.ts` copies own data descriptors only, converts accessors/proxies/
  custom prototypes to `[UNSUPPORTED]`, applies the shared key predicate plus
  `apiKey`/`api_key` spellings with all separator forms, and reduces native errors to
  `{name:"Error", status?, externalStateUncertain?}` — `message`, `stack`, `cause`,
  headers and response bodies are never read.
- Audit redaction keeps its narrower legacy policy (documented difference), and audit
  metadata is an explicit per-event allowlist rather than a serializer of arbitrary
  objects.

## 7. Package payload

`npm run test:package` on Node 24 verifies the real tarball and the production-only
consumer install: compiled runtime JavaScript + `package.json`/`README.md`/`LICENSE` +
the packaged example config + the four operator guides, with negative assertions that
reject `config/playops.yaml`, `.env*`, credential JSON, audit logs, checkpoints, release
session/journal state, reports, `.aab` files, `src/`, `tests/`, `scripts/`, internal docs
(including `PLAYOPS_PLAN.md` and this review) and Hermes state. The harness also asserts
that installing and running the package writes nothing inside `node_modules/playops/`.

## 8. Dependency and supply-chain audit

| Check                            | Command (Node v24.21.0 / npm 11.19.0)    | Observed result                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production tree                  | `npm audit --omit=dev --json`            | **0 vulnerabilities** (info/low/moderate/high/critical all 0); production dependency count 48 including transitives                                                                                                         |
| Full tree incl. devDependencies  | `npm audit --json`                       | **0 vulnerabilities**                                                                                                                                                                                                       |
| Registry signatures/attestations | `npm audit signatures`                   | 178 packages with verified registry signatures, 49 with verified attestations                                                                                                                                               |
| Direct runtime dependencies      | `package.json`                           | exactly 4: `yaml@2.9.1`, `google-auth-library@11.1.0`, `@googleapis/androidpublisher@42.1.0`, `@googleapis/playdeveloperreporting@15.0.1`                                                                                   |
| Lockfile integrity               | `package-lock.json`                      | lockfileVersion 3, `integrity` present for every production entry, installed versions match the lock exactly                                                                                                                |
| Production lifecycle scripts     | static scan of installed manifests       | production `install`/`postinstall`/`preinstall`/`prepare` hooks: **none**. Only upstream `prepare: npm run compile` entries exist (released tarballs already contain `dist/`), which npm does not run for registry installs |
| Native addons                    | static scan                              | none in the production tree (`fsevents` is an optional **dev**-only marker)                                                                                                                                                 |
| Producer install command         | `docs`, `scripts/package-acceptance.mjs` | `npm ci` from the lockfile; no `npm install`/upgrade path is used for acceptance                                                                                                                                            |

No `npm audit fix`, dependency upgrade, or lockfile regeneration was performed. No
vulnerability was suppressed or re-classified.

## 9. Least-privilege scopes (verified against official references)

| Scope constant                   | Value                                                    | Verified requirement                                                                                                                            | Used by                               |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `ANDROID_PUBLISHER_SCOPE`        | `https://www.googleapis.com/auth/androidpublisher`       | Google's `Method: reviews.reply` reference lists this as the required OAuth scope ("Authorization scopes / Requires the following OAuth scope") | `doctor`, Review Agent, Release Agent |
| `PLAY_DEVELOPER_REPORTING_SCOPE` | `https://www.googleapis.com/auth/playdeveloperreporting` | Google's `vitals.crashrate.query` reference lists this scope                                                                                    | `doctor`, App Health                  |

The APIs do not publish narrower per-operation scopes for these methods, so scope
reduction is not available; least privilege is applied at **app/permission level**
instead (Play Console account-level vs app-level permission model, retrieved read-only
from Google's own "Add developer account users and manage permissions" page). No
specific Play Console permission or role label is asserted here because Google's naming
is not verified from authoritative documentation for this account. Guidance is now in
`docs/credentials.md`.

## 10. Registered-tool inventory and authorization model

Static inventory (25 registry tools) plus the loop's enforcement path
(`src/runtime/agent/index.ts`): input schema parse → **mutation verifier preflight**
(`VERIFIER_REQUIRED` before any execution) → `evaluateToolPermission` → approval
request/digest binding → execute → output schema parse → verification → serializer.
`src/runtime/permissions/index.ts:105-121` allows `read`/`write` without approval and
requires an exactly-matching `{toolName, permission, decision:"approved"}` record for
`destructive`/`publish`, failing closed on malformed, mismatched or denied evidence.

| Group                 | Tools                                                                                                                                                                                | Permission  | Approval                 | Verifier                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------ | ----------------------------- |
| Review                | `reviews.ingest`                                                                                                                                                                     | write       | not required             | yes (checkpoint read-back)    |
| Review                | `reviews.classify`, `reviews.draft_reply`                                                                                                                                            | read        | not required             | none (`VERIFICATION_SKIPPED`) |
| Review                | `reviews.publish_reply`                                                                                                                                                              | publish     | exact binding            | yes (`reviews.get` read-back) |
| Release (read)        | `releases.inspect`, `releases.inspect_target_track`, `releases.verify_version_code`, `releases.validate_edit`, `releases.inspect_committed_release`, `releases.inspect_edit_hygiene` | read        | not required             | none                          |
| Release (write)       | `releases.upload_bundle`, `releases.configure_release`, `releases.attach_release_notes`                                                                                              | write       | not required             | yes                           |
| Release (destructive) | `releases.open_edit`, `releases.verify_committed_release`, `releases.update_rollout_fraction`, `releases.halt_rollout`, `releases.resume_rollout`, `releases.cleanup_known_edit`     | destructive | exact per-action binding | yes                           |
| Release (publish)     | `releases.commit_edit`                                                                                                                                                               | publish     | exact commit binding     | yes                           |
| Health                | `health.get_crash_rate`, `health.get_anr_rate`, `health.get_excessive_wakeups`, `health.compare_to_baseline`, `health.check_thresholds`                                              | read        | not required             | none                          |

Two further tool-name constants (`submit_review_classification`,
`submit_review_reply_draft`) are **not** registry tools: they are the nested LLM
structured-output calls used by classification/drafting.

Every mutating tool is composition-bound: model-facing input is `{}` (or a narrow field
set) and rejects extra keys, so the model cannot select the package, credential path,
artifact path, track, release identity, approval decision, threshold policy or digest.

## 11. Google mutation / retry review

Method-level: every mutation wrapper passes `retry:false` at both the service and the
per-call boundary (`createAndroidPublisherClient` constructor and each mutation call), so
no generated/Gaxios retry stack exists for PlayOps mutations. Workflow-level attempts:

| Workflow                                              | Mutation sequence                                                          | Repeat-call behaviour                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `releases.open_edit`                                  | one `edits.insert`                                                         | single attempt; failure is uncertain, no compensating second edit             |
| `releases.upload_bundle`                              | one `edits.bundles.upload` (120 s timeout)                                 | single attempt                                                                |
| `releases.configure_release` / `attach_release_notes` | one `edits.tracks.update`                                                  | single attempt                                                                |
| `releases.commit_edit`                                | one `edits.commit` (`ERROR_IF_IN_REVIEW`, `changesNotSentForReview:false`) | single attempt; ambiguous outcome keeps session + uncertainty                 |
| `releases.update_rollout_fraction`                    | `edits.insert` → `tracks.update` → `validate` → `commit`                   | one attempt each; temporary verification delete now **single-attempt** (F-01) |
| `releases.halt_rollout` / `resume_rollout`            | same lifecycle, status-only update                                         | one attempt each; guarded verification delete                                 |
| `releases.verify_committed_release`                   | temporary `edits.insert` → `tracks.get` → `edits.delete`                   | one attempt each; guarded delete                                              |
| `releases.cleanup_known_edit`                         | one `edits.delete` → post-delete `edits.get`                               | exactly one attempt, contextual verifier                                      |
| `reviews.publish_reply`                               | one `reviews.reply` POST                                                   | single attempt; read-back verification                                        |

`getEdit`/`tracks.get`/`bundles.list`/metric reads keep the bounded Phase 1.5 **read**
retry (3 attempts incl. initial) with generated retry disabled.

### 11a. Release-track reconstruction assessment

`releases.configure_release` builds the bound track's `releases` array as **one new
release** (uploaded version code plus explicitly supplied retained codes; none by
default) and does not round-trip prior releases' notes/priority. Assessed:

- Can existing releases be unintentionally omitted? Yes, if the operator does not pass
  retained codes — but the tool refuses when an outstanding `draft`/`inProgress`/`halted`
  release already exists on the target track (`OUTSTANDING_RELEASE_EXISTS`), and
  completed historical releases being dropped from the _track array_ does not delete
  them from the app; version-code membership is what the operator must choose.
- Is the consequence explicit? The approval summary and the shipped
  `docs/release-pipeline.md` (§ "Configure the release") state the one-release
  construction and that `tracks.get` verification is target-release-scoped, not
  full-preservation.
- Does read-back detect the intended state? Yes — the verifier confirms the intended
  release's identity, version-code set, status and fraction semantics; it deliberately
  does **not** assert preservation of the track's other releases, and no PlayOps
  code path proves Google's merge-versus-replace behaviour for an omitted
  `releases[]` on `edits.tracks.update`.
- Classification: **not a security defect** (no boundary crossing, no credential/PII
  exposure, gated by the outstanding-release precheck, disclosed in the approval
  summary, the shipped guide and the dry-run plan). Residual operational risk — a
  tolerated `completed` release could be dropped from the target track array while the
  verifier still passes — is recorded as **UNVERIFIED (Google semantics)**. A future
  phase could either round-trip the existing release array the way
  `attach_release_notes`/rollout/status-control do, or add a preservation assertion to
  the verifier; neither was done here because it would change release behaviour.

## 12. LLM boundary

Review text is untrusted data placed only in the user message; classification and
drafting use a fixed system prompt, `temperature: 0`, one required structured tool call
with locally re-validated arguments, and no retry. Neither path can publish: drafting
imports no publish/approval code (source-scan asserted), and `reviews.publish_reply` is a
separate `publish` tool behind exact human approval plus a fresh-state read-back. Model
tool arguments are validated by the authoritative `ToolSchema.parse` before execution,
and model-facing schemas cannot carry provider config, package identity, paths or
approval fields. Prompt injection inside a review cannot invoke arbitrary tools through
the nested classifier/drafter path because that path exposes exactly one structured-output
tool and no registry tools. Residual risk: instruction-following quality of the model
itself, mitigated by schema validation and the human publish gate — **not** claimed as
complete prompt-injection immunity.

## 13. Network boundary

Outbound destinations are limited to Google endpoints constructed by the official SDKs
and the operator-configured 9Router base URL. A source scan for telemetry/analytics
hosts (`sentry`, `datadog`, `segment`, `posthog`, `mixpanel`, `telemetry`, `analytics`)
returns **no** production match, and no browser-automation dependency (`playwright`,
`puppeteer`, `selenium`, `chromium`) exists in `src/` or `package.json`. The 9Router base
URL is read from YAML/env (operator authority, never model input), validated as `http:`/
`https:` with a hostname and no credentials, query, fragment or whitespace
(`src/reviews/composition.ts:74-90`), and the adapter appends a fixed
`/chat/completions` path. No hidden collector, tunnel or updater exists.

## 14. Accepted limitations (no fix attempted)

1. **Audit integrity:** append-only JSONL with no file locking, no cryptographic tamper
   evidence, no signature chain; multi-entry writes are ordered but not transactional;
   default appends are not fsynced. Documented in `docs/audit-log.md`.
2. **Concurrency:** approval-token consumption, review checkpoint, managed edit session
   and cleanup journal all assume a single PlayOps process per state file. Two concurrent
   processes could both consume a token or lose checkpoint updates. No lock/DB is
   introduced and multi-instance operation is not advertised.
3. **Google-side races:** GET→UPDATE→GET sequences are not atomic compare-and-set; a
   concurrent Play Console change can still race. Mitigated by fresh state digests and
   read-back verification.
4. **Irreducible windows:** an accepted `edits.insert` whose identity never reaches local
   persistence is unrecoverable (Google exposes no active-edit listing); commit
   acknowledgement is not serving/device propagation.
5. **Free-form strings:** redaction is key-based defense in depth, not universal secret
   scanning.
6. **Browser fallback:** interface skeleton only; Phase 6.5 makes no claim about browser
   automation security because no browser implementation exists.

## 15. Unverified (explicitly not PASS)

- Live Google mutation authorization for `reviews.reply`, `edits.bundles.upload`,
  `edits.tracks.update`, `edits.commit`, rollout advancement and halt/resume. Prior
  `doctor` reads and the single contextual cleanup observation do not establish these.
- Physical TTY approval behaviour, power-loss durability, pathological-size/OOM
  behaviour of the diagnostic serializer, and multi-user/hostile-host protection.
- Play Console role/permission labels for the operator's actual account.

## 16. Verification of this phase's changes (official Node v24.21.0 / npm 11.19.0)

| Gate                                        | Result                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=development npm run build`        | exit 0                                                                                                                                                                                             |
| `NODE_ENV=development npm run test:run`     | exit 0 — **2,091/2,091 tests across 96 files** (baseline 2,086/95; +5 new cases)                                                                                                                   |
| `NODE_ENV=development npm run lint`         | exit 0                                                                                                                                                                                             |
| `NODE_ENV=development npm run typecheck`    | exit 0                                                                                                                                                                                             |
| `NODE_ENV=development npm run format:check` | exit 0                                                                                                                                                                                             |
| `npm run test:package`                      | real isolated tarball → production-only consumer install → installed CLI/module checks; all checks PASS, 103 entries, no observed application-network calls                                        |
| Built smokes (existing scratch harnesses)   | Phase 5.1 23/23, 5.2 31/31, 5.3 42/42, 5.4 55/55, 6.2 35/35, 6.3 17/17 — all exit 0                                                                                                                |
| Targeted                                    | `tests/state-file-permissions.test.ts` + `tests/releases-rollout.test.ts` 36/36; security-relevant selection (state permissions, rollout, documentation, audit, audit-durable, edit cleanup) 97/97 |
| Bounded probe                               | five state writers `0600`, PlayOps-created parents `0700`, no group/other bits                                                                                                                     |

## 17. Not done (deliberately)

No encryption with a local/hardcoded key, no secret hashing-then-logging, no generic
"universal sanitizer", no SAST/badge tooling, no new runtime dependency, no live Google
mutation used as a security test, and no compliance/certification claim.

## 18. Independent source-only review cross-check

Three source-only subagent reviews were run in parallel (`deleg_0457bd2d`: secrets/
output/LLM/network; mutation/approval/tool authority; filesystem/persistence/package).
Their output is a **self-report**, so every conclusion used here was re-derived by the
parent from the cited source. Disposition of what they raised:

| Raised candidate                                                                        | Parent re-derivation                                                                                                                            | Disposition                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Rollout temporary delete can run twice (their C-1)                                      | Re-read `rollout-tool.ts` delete/catch sites and both sibling guards; confirmed max 2 attempts, same identity, no cross-edit deletion reachable | **Confirmed → F-01, fixed**                                                |
| Audit/state files use umask defaults, not owner-only (their P65-AUDIT-MODE)             | Re-derived from Node `fs` docs and the bounded probe; additionally confirmed the audit file doubles as the approval/verification ledger         | **Confirmed → F-02, fixed** (file `0600` + PlayOps-created parent `0700`)  |
| Google SDK debug logging can emit token-endpoint bodies (their S1)                      | Re-read the installed SDK interceptor + logging-utils activation path                                                                           | **Confirmed → F-04, documented** (env-gated; no behaviour change)          |
| 9Router accepts non-loopback `http://` (their S3)                                       | Re-read the URL validation and adapter header/body construction                                                                                 | **Confirmed → F-05, documented** (compatibility-sensitive)                 |
| Nested classifier/drafter LLM calls escape the agent budget (their S2)                  | Re-read the classifier/drafter call sites, CLI loop and ingestion bounds                                                                        | **Confirmed → F-06, documented**                                           |
| Audit append follows symlinks (their P65-STATE-SYMLINK)                                 | Re-read the append/read paths and the rename-based state writes                                                                                 | **Confirmed → F-07, documented**                                           |
| Tarball does not pin dependency versions (their P65-PKG-PIN)                            | Re-read `package.json`, payload allowlist and acceptance install command                                                                        | **Confirmed → F-08, documented**                                           |
| Payload validator extension/root lists are incomplete (their P65-PAYLOAD-VALIDATOR-GAP) | Re-read the validator and the authoritative `files` comparison                                                                                  | **Confirmed → F-09, documented**                                           |
| `configure_release` verifier does not check preservation (their C-2)                    | Re-read the precheck, request body and verifier scope                                                                                           | **Not a security defect; folded into §11a as UNVERIFIED Google semantics** |
| Auth 401/403 resend could repeat a mutation if `forceRefreshOnFailure` were set         | Re-read `oauth2client.js` resend gate, `jwtclient.js` expiry path and PlayOps' construction (option never set)                                  | **Not reachable in PlayOps** — recorded as an observation only             |
| `health.check_thresholds` is `read` yet writes durable audit entries                    | Re-read the tool; local evidence write, documented                                                                                              | **Not a boundary crossing**                                                |
| `parseEnvNumber` embeds the raw env value in `ConfigError.message`                      | Re-read the parse helper; numeric settings only, and no production path prints `.message` (Phase 6.3 renders fixed text)                        | **Latent only, recorded in §4 (N1-equivalent)**                            |
| `AuthError` wraps the library message                                                   | Re-read the boundary; the CLI never renders it                                                                                                  | **Recorded in §4**                                                         |

Their independent tool inventory (25 registry tools, every mutation with a verifier, every
`destructive`/`publish` tool with an approval binding) matched the parent's static
inventory and `src/runtime/agent/index.ts` enforcement path.

Nothing from the reviews was accepted as a finding without the parent re-reading the
cited source; no live service, credential, browser or target execution was used by any
party.
