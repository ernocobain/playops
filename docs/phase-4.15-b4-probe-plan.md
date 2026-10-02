# Phase 4.15 / Blocker B4 — controlled live-evidence probe plan

> **STATUS: PREPARED, NOT APPROVED, NOT EXECUTED.** No live Google call was made while preparing
> this plan. Phase 4.15 remains **BLOCKED** and `[ ]`; no implementation change was made; no test or
> source file was touched; Phase 5 was not started.
>
> **Target finding (decisive):** the only configured Google Play application on this host is
> `com.bizdirect.app`. **No disposable/test application is configured anywhere.** Per the operator's
> instruction, the probe therefore **must not run against BizDirect without explicit operator
> authorization** — see §2 and §10.
>
> **Target adjustment (operator decision, 2026-10-01, later same day).** The operator chose the
> disposable-target path and named the target: **`com.dhikrama.driver`** (Nagili Driver, an unused
> application that already has Internal Testing / artifact history). The **existing configured
> service account and its JSON key are reused deliberately** — no new service account, no new key —
> and the credential still comes from the existing trusted PlayOps configuration
> (`config/playops.yaml`). Therefore **only the package name is overridden, via env**
> (`PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME=com.dhikrama.driver`); the
> `PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` override is **not** used. See §13 for the adjusted
> preflight, its machine-checked assertions, the residual risk this reintroduces, and the exact live
> command. `com.bizdirect.app` remains untouched.

## 1. The single question this probe answers

What **structured** error does the installed `@googleapis/androidpublisher@42.1.0` boundary return
when `edits.get` is called for an edit that was **just successfully deleted**?

It does not answer, and must not be used to claim: whether other failure classes (auth, transport,
5xx) can be distinguished, whether the same signal appears for _superseded_ or _expired_ edits, or
whether the signal is a permanent contract. One observation on one application is one observation.

## 2. Target reconnaissance (observed 2026-10-01 06:56 WIB, safe facts only)

| Fact                                                         | Observed                                             |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| Config loads                                                 | yes (`config/playops.yaml`)                          |
| Bound application                                            | **`com.bizdirect.app`** (the only configured target) |
| Credential path configured                                   | yes (path deliberately not printed)                  |
| `release.editSessionPath` / `release.editCleanupJournalPath` | **not configured** (empty in local config)           |
| `PLAYOPS_*` env overrides                                    | none present                                         |
| Other package candidates in `config/` + `docs/`              | only `com.example.app` (documentation placeholder)   |
| Runtime dependencies / SDK under test                        | exactly 4 / `@googleapis/androidpublisher@42.1.0`    |

**Conclusion: no disposable/test target exists.** `com.bizdirect.app` is the operator's real
application and the same app used for the earlier live `doctor` read evidence. The operator's
instruction is therefore triggered: **the probe must not run against BizDirect without explicit
operator authorization.** §10 states exactly what that authorization has to say.

## 3. Hard preconditions (all required, all machine-checked by the script)

1. No active managed PlayOps edit: the probe uses its **own scratch session store** and refuses if a
   tracked session file already exists there (it never reads or writes the configured live session).
2. Cleanup journal contains no conflicting candidate: the probe refuses if its scratch journal holds
   any record before starting.
3. Exact target identity printed safely: package name + service-account `client_email` only. Never the
   key, the credential JSON, the credential path, or a token.
4. Explicit destructive operator approval, twice: a `--i-authorize-destructive-edit-probe` flag **and**
   an interactive prompt where the operator must type the exact package name (TTY required).
5. Structural impossibility of anything else: the probe imports only `createEdit`, `getEdit`,
   `deleteEdit`, and **refuses to run** if any forbidden identifier (`uploadBundle`, `updateTrack`,
   `validateEdit`, `commitEdit`, `listTracks`, `edits.bundles.upload`, `edits.tracks.update`,
   `edits.validate`, `edits.commit`) appears in its own source body.

## 4. Probe sequence (as implemented in the script)

| #   | Step                                                                                  | Failure behaviour                                                              |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Confirm the local release-edit session store is empty (scratch path)                  | refuse, exit 2                                                                 |
| 2   | Confirm the cleanup journal has no conflicting record                                 | refuse, exit 2                                                                 |
| 3   | Print exact target package + service-account identity                                 | —                                                                              |
| 4   | Require explicit destructive approval (flag + typed package name, TTY)                | refuse, exit 2, nothing created                                                |
| 5   | `edits.insert` exactly once, `retry:false`                                            | record failure, no retry                                                       |
| 6   | Validate returned `editId` + non-expired `expiryTimeSeconds`                          | record failure; no delete attempted without a trustworthy id                   |
| 7   | Persist the temporary cleanup-journal record immediately (D6 ordering)                | record failure; journal record retained                                        |
| 8   | `edits.get` exact id and confirm it is active                                         | record failure if it does not read back as active                              |
| 9   | `edits.delete` exact id exactly once, `retry:false`                                   | record failure; journal record retained                                        |
| 10  | `edits.get(packageName, deletedEditId)` → capture only safe structured metadata       | see §5                                                                         |
| 11  | Treat the observation as a single data point, never as a contract                     | —                                                                              |
| 12  | Reconcile the scratch journal record **only** when the probe safely proves inactivity | otherwise retain the record and keep the workspace (never delete the identity) |
| 13  | Produce a _proposed_ classifier from observed structured evidence + official docs     | proposal only (see §7)                                                         |
| 14  | Do **not** implement that classifier until the operator reviews the probe result      | —                                                                              |

## 5. Capture allowlist (exact fields printed) and forbidden output

Captured from the post-delete `edits.get` failure:

- `httpStatus` — numeric HTTP status when structurally available
- `topLevel.code` / `topLevel.status` — top-level numeric error code / status
- `structured.errorStatus`, `structured.errorReason`, `structured.reasons[]` —
  `response.data.error.status`, `response.data.error.reason`, and each
  `response.data.error.errors[].reason` / `.status`
- `machineReadableReasonPresent` — whether any machine-readable reason field existed at all
- `messagePresent` + `messageLength` — presence and length only (the human text is neither stored nor
  printed, because D4 forbids deriving a classifier from human-readable strings)
- PlayOps `PublisherError.code` (`API_REQUEST_FAILED`) and `outcome`
  (`FAILED_AS_DOCUMENTED` / `UNEXPECTED_SUCCESS`)

Never captured or printed: authorization headers, credentials, access tokens, raw request headers,
full raw response bodies, service-account JSON, the local credential path, raw edit ids.

## 6. Prepared commands (review only — none of the live ones executed)

```bash
# 0) Preflight retry of the safe reconnaissance (no Google call, no secrets printed)
NODE_ENV=development node /home/dhikrama/.hermes/cache/scratch/playops-b4-probe-recon.mjs

# 1) Gate evidence: all three refusals must hold before any probe run
P=/home/dhikrama/.hermes/cache/scratch/playops-b4-getedit-after-delete-probe.mjs
NODE_ENV=development node "$P"                                                              # no flag  -> refuse
NODE_ENV=development node "$P" --i-authorize-destructive-edit-probe --confirm-package=com.example.x  # mismatch -> refuse
NODE_ENV=development node "$P" --i-authorize-destructive-edit-probe --confirm-package=com.bizdirect.app < /dev/null  # non-TTY -> refuse

# 2) THE LIVE PROBE — RUN ONLY AFTER EXPLICIT OPERATOR AUTHORIZATION (§10), from a real terminal
NODE_ENV=development node "$P" --i-authorize-destructive-edit-probe --confirm-package=com.bizdirect.app

# 3) After the probe: hygiene inspection must show zero known records
#    (registered automatically when a cleanup-journal path is configured)
```

## 6a. Prepared commands — Nagili Driver target adjustment (review only; NOT executed)

```bash
PROBE_PKG="com.dhikrama.driver"     # disposable target (Nagili Driver)
PROBE=/home/dhikrama/.hermes/cache/scratch/playops-b4-getedit-after-delete-probe.mjs
PREFLIGHT=/home/dhikrama/.hermes/cache/scratch/playops-b4-nagili-preflight.mjs
cd /home/dhikrama/Project/playops

# 0) PREFLIGHT — all ten assertions must PASS. NO Google API call, NO credential path printed.
#    Only the package is overridden; the credential still comes from config/playops.yaml.
env PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME="$PROBE_PKG" node "$PREFLIGHT"

# 1) After the preflight, and after confirming Play Console app access for the service-account
#    email on com.dhikrama.driver, run the live probe from a REAL TTY (see §13.4).
```

## 7. Gate evidence already obtained (2026-10-01, no Google call made)

| Case                                          | Observed                                                                                         | Exit |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| No authorization flag                         | `REFUSED: missing --i-authorize-destructive-edit-probe`                                          | 2    |
| Flag present, wrong package                   | `REFUSED: --confirm-package does not match the bound package`                                    | 2    |
| Flag + correct package, non-interactive stdin | `REFUSED: interactive authorization requires an interactive terminal (TTY); nothing was created` | 2    |

The script also self-refuses if its own source contains a forbidden mutation identifier, and its
first empirical version failed exactly that check (the denylist literals were inside the scanned
region) — fixed by scanning only the body after the declaration block. That is recorded as evidence
that the self-check is live and not decorative.

## 8. Outcome handling (D1/D3/D4-compliant)

- **Post-delete `edits.get` fails with a structured reason/status** → record it, and reconcile the
  scratch journal record **only** if the delete response was acknowledged _and_ a structured
  not-found-style signal was observed. The observation becomes _candidate_ evidence for a classifier,
  never a contract.
- **Post-delete `edits.get` unexpectedly succeeds** → the delete ack did not take effect; keep the
  journal record, keep the workspace, and report; do not retry the delete.
- **Any earlier failure (insert/validation/read/delete)** → journal record retained, workspace kept,
  exact id preserved, and the report states which step failed. Nothing is published, uploaded,
  updated, validated, or committed at any point.
- **Never** treat 401/403/429/5xx/timeout/`ECONNRESET`/unclassified results as inactivity.

## 9. Classifier proposal procedure (no code yet) and the test that would follow

The proposal will be written only after the probe output exists, and must cite, for each candidate
signal: the observed payload field, the observed value, the HTTP status, and the official
documentation that permits the mapping. If the observation and the documentation disagree, the
documentation wins and the proposal must say so.

Test shape to be added **after** operator review (not implemented now, no source change):

- `tests/publisher-edit-inactive.test.ts` — fixture-driven, fake transport only:
  - fixture = the observed post-delete payload (redacted of any real ids)
  - assert `REMOTE_INACTIVE` **only** for that exact structured signal
  - assert 401 / 403 / 429 / 500 / timeout / `ECONNRESET` / unclassified / missing-reason all map to
    UNKNOWN with zero deletes
  - assert a successful `edits.get` still means ACTIVE
- `tests/releases-cleanup-remote-delete.test.ts` — the eventual remote-delete path: exactly one
  `edits.delete`, `retry:false`, post-delete verifier, record retained on any unproven outcome,
  and no delete at all for UNKNOWN.

## 10. What the operator authorization must say before this probe runs

Because **no disposable target exists**, the probe cannot run against `com.bizdirect.app` without an
explicit operator decision that accepts these facts:

1. The probe creates **one real Google Play edit** on `com.bizdirect.app`.
2. Creating it may **invalidate another active edit owned by the same API user** for that app,
   discarding uncommitted work in it.
3. The probe then deletes that same edit; if the delete cannot be confirmed, one temporary edit may
   remain and its id will be retained locally for a follow-up hygiene inspection.
4. The probe never publishes, uploads, updates a track, validates a release, or commits.
5. Fallback if the operator does not want that risk: configure a disposable/test Play application
   (separate package + service account) and re-run this same plan against it, or wait for Google to
   publish a structured inactive-edit error.

## 11. Residual risk and stop conditions

- **Hard stop** if the recon ever shows a non-empty managed session/journalled candidate, a mismatched
  package, or a missing credential — the probe must not run in those states.
- **Hard stop** after the probe if the report shows `journalRecordsRemaining > 0`: the workspace is
  kept on purpose and the operator must run the hygiene inspection before any other release work.
- The probe does not prove anything about expired/superseded edits, other applications, or Google's
  future behaviour.

## 12. Artifacts

- Probe script (runnable, not executed): `/home/dhikrama/.hermes/cache/scratch/playops-b4-getedit-after-delete-probe.mjs`
- Recon script (safe, already run): `/home/dhikrama/.hermes/cache/scratch/playops-b4-probe-recon.mjs`
- Both live in the Hermes scratch directory (project convention: live/probe tooling never ships in the
  repository) and are pruned after ~24h idle; this document fully specifies their behaviour so they can
  be regenerated from it.
- Nagili Driver preflight (local only, no Google call, no credential path printed):
  `/home/dhikrama/.hermes/cache/scratch/playops-b4-nagili-preflight.mjs`

## 13. Nagili Driver target adjustment — intentional service-account reuse (prepared, not run)

### 13.1 Target and credential policy

- Target package: `com.dhikrama.driver` (Nagili Driver). Operator-stated to be unused and to already
  have Internal Testing / artifact history — that satisfies the documented Edits-API precondition
  ("an existing app that has at least one APK uploaded"). _Operator-reported; not verified here,
  because verifying it would require the very Google call this preflight exists to avoid._
- Credential: the **existing** configured service account is reused on purpose. No new service
  account, no new key, no credential env override. `com.bizdirect.app` is not touched and its config
  is not modified.

### 13.2 Only the package name is overridden

`src/config/loader.ts` resolves `DEFAULT_CONFIG < config/playops.yaml < environment` (`:294-315`), so
setting `PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME=com.dhikrama.driver` alone changes the effective target
while `google_play.service_account_json` continues to come from the trusted local config. Setting the
credential env var as well is explicitly **not** required and is not done.

### 13.3 Preflight assertions (all machine-checked, all must PASS)

Observed 2026-10-01 on this host (local only, zero Google API calls):

| #   | Assertion                                                                                            | Observed                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | effective `packageName` == `com.dhikrama.driver`                                                     | PASS                                                                                                                |
| 2   | effective `packageName` != `com.bizdirect.app`                                                       | PASS                                                                                                                |
| 3   | package env override == true **and applied**                                                         | PASS (`envOverride.packageName: true`)                                                                              |
| 4   | credential configured + loadable (typed `service_account`)                                           | PASS                                                                                                                |
| 5   | `client_email` == expected existing identity                                                         | PASS (`bizdirect-play-console-mcp@calm-drive-476709-h8.iam.gserviceaccount.com`; overridable via `EXPECT_SA_EMAIL`) |
| 6   | output contains neither the credential path nor key material                                         | PASS (self-asserted on its own report)                                                                              |
| 7   | probe imports only `createAndroidPublisherClient, createEdit, getEdit, deleteEdit`                   | PASS                                                                                                                |
| 8   | no `uploadBundle`/`updateTrack`/`validateEdit`/`commitEdit`/`listTracks` in the probe's scanned body | PASS (0 violations)                                                                                                 |
| 9   | scratch session/journal clean; live session/journal unconfigured and absent                          | PASS (3 empty `playops-b4-probe-*` dirs, no `edit-session.json`/`edit-cleanup-journal.json`)                        |
| 10  | no Google API call during preflight                                                                  | PASS (structural: only `dist/config/index.js` is imported; no auth/publisher client is constructed)                 |

Negative controls run the same day, proving the guards are live rather than decorative: without the
package override, assertions 1/2/3 FAIL (`effectivePackage: com.bizdirect.app`, exit 2); with a wrong
`EXPECT_SA_EMAIL`, assertion 5 FAILS (exit 2).

### 13.4 Residual risk reintroduced by sharing the service account (must be accepted knowingly)

Reusing a credential that is **authorized for `com.bizdirect.app`** removes the fail-closed property a
dedicated service account would have provided: if the package override were missing from the probe
process, the effective target would silently be `com.bizdirect.app` _and_ the credential would be
authorized for it — the preflight's negative control demonstrates exactly that fallback. What still
stands in the way is the probe's own double gate (both compare the **effective** package, so a
missing override requires the operator to type and pass `com.bizdirect.app` explicitly):
`--confirm-package=<exact effective package>` and the interactive typed package name. Mandatory
compensating controls: run the preflight in the _same_ shell as the probe, export the override once
rather than typing it ad hoc, and never run the probe without having seen assertion 1–3 PASS.

### 13.5 Exact live probe command (PREPARED — DO NOT RUN until the operator confirms Play Console access)

```bash
export PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME=com.dhikrama.driver   # export once, in this shell
PROBE=/home/dhikrama/.hermes/cache/scratch/playops-b4-getedit-after-delete-probe.mjs
cd /home/dhikrama/Project/playops
node "$PROBE" --i-authorize-destructive-edit-probe --confirm-package=com.dhikrama.driver
# at the prompt, type exactly: com.dhikrama.driver
```

Before running it, the operator must confirm in Play Console that the existing service-account email
`bizdirect-play-console-mcp@calm-drive-476709-h8.iam.gserviceaccount.com` has **app access to Nagili
Driver (`com.dhikrama.driver`)** — Users and permissions → the service-account row → App permissions →
`com.dhikrama.driver` — without broadening its permissions elsewhere.

## 14. Live run result — PRE-DELETE failure diagnosed as a probe-harness defect (2026-10-01, local only)

**Observed (operator-supplied) run report on `com.dhikrama.driver`:** `steps.insert = { ok: true,
editIdReturned: true }`; `steps.failure = { at: "pre-delete", errorCode: "EDIT_INVALID", httpStatus:
null }`; `steps.journalRecordsRemaining = 0`; `reconcile = { performed: false, reason: "probe did not
reach a safe proof; journal record retained" }`.

**Exact call/order graph (probe lines).** 244 `createEdit` → 245 record insert ok → **248
`parseGooglePlayEditSession(created, packageName)`** → 249-256 expiry check (throws a plain `Error`,
`code` undefined) → 257 `steps.validation = {ok:true}` → 260-266 `journal.record` + list → 269
`getEdit` (pre-delete) → 276 `deleteAttempted = true` → 277 `deleteEdit` → 282 `getEdit`
(post-delete) → 297-307 reconcile + conditional `journal.remove` → 308-314 catch → 315-331 finally
(list, print, keep-or-`rmSync` workDir).

**Root cause (deterministic, reproducible offline).** Line 248 hands the raw `PublisherEdit` returned
by the Phase-1 boundary — shape `{ id, expiryTimeSeconds }`
(`src/googleplay/publisher/index.ts:137-141`, produced by `normalizeEditResponse:630-654`) — to
`parseGooglePlayEditSession`, which validates the **PlayOps session** shape: allowed keys are exactly
`{packageName, editId, expiryTimeSeconds}` with an explicit unknown-key rejection
(`src/releases/index.ts:288-291`), then a package binding + `editId` check (`:292-294`). The API's
field is `id`, not `editId`, and there is no `packageName` field, so the **first failing invariant is
the unknown-key check at `:289-291`** → `ReleaseError("EDIT_INVALID", "Temporary edit session is
invalid.")`; the package-binding check at `:292-294` would fail as well. The harness used a
session-shape validator where it needed to construct a session from the boundary's edit shape.

**Why this is pinned and not a guess.** `EDIT_INVALID` is a PlayOps domain code that the publisher
boundary can never emit (0 occurrences in `src/` and `dist/` `googleplay/publisher`; its only codes
are `INVALID_ARGUMENT | API_REQUEST_FAILED | INVALID_RESPONSE`). The only `EDIT_INVALID` source
reachable from the probe's imports is `parseGooglePlayEditSession`. Combined with
`at: "pre-delete"` (set at `:276`, so nothing after 277 threw) and `journalRecordsRemaining: 0`
(`:316`, so `journal.record` at 260 never ran, which also rules out a throw at the pre-delete
`getEdit` at 269), the throw site is uniquely line 248.

**Consequences.** No HTTP request other than the single `edits.insert` occurred: the pre-delete
`edits.get` at 269 was never reached, so `deleteEdit` was never attempted and `steps.validation` was
never set. `httpStatus: null` is mechanical, not evidence of a statusless remote error: `ReleaseError`
carries no `response`/`status` (class at `src/releases/index.ts:204-218`), so the probe's `safeStatus`
(`:191-195`) falls back to the code string `"EDIT_INVALID"`, which fails its `/^\d{3}$/` test.

**Journal "contradiction" — resolved.** The count is correct and the prose is wrong. `journal.record`
was never called (option A: never added); `journalRecordsRemaining: 0` is an accurate read of the real
journal at `:316`. The string "journal record retained" is **hard-coded** in the catch branch at
`:314`, which never inspects journal state — a second, independent harness defect (misleading
reporting, not inconsistent state). The `finally` block then took the `else` branch (`:329-330`)
because the count was 0 and deleted the `mkdtemp` workDir.

**Durable identity: none.** `RECOVERABLE_EDIT_ID_PRESENT = false`. The id existed only in-process
(`created.id`); it was never journaled, the probe never writes `sessionStorePath` (only
`existsSync`-checks it at `:128`), and the workDir was removed by `:330`. Local inspection confirms
it: no new `playops-b4-probe-*` directory in the scratch TMPDIR (only the three empty 06:57/06:58
refusal-gate dirs), no `edit-session.json` / `edit-cleanup-journal.json` anywhere in the scratch tree
or `/tmp`, and no saved probe stdout. Even a saved report could not contain the id — the probe's
allowlist forbids printing raw edit ids.

**Remote state (do not assume):** `edits.insert` succeeded, so one real edit was created on
`com.dhikrama.driver`, and it was **not** deleted. **The remote edit may remain active but cannot be
safely addressed from current persisted state** (`edits.list` does not exist, per the irreducible
window already noted in §11).

**Dist/source drift:** none. No `src/**/*.ts` file is newer than its `dist` counterpart (newest src
2026-10-01 06:29, dist built 06:35); the logic of `parseGooglePlayEditSession`,
`validateReleasePackageName`, `editIdIsValid`, `normalizeEditResponse` and `getEdit` was compared
line-by-line between `src` and `dist` and is semantically identical. The probe file itself is
unchanged (`md5 4e1147fe…`, 13 865 bytes, 06:58).

**Two harness defects to fix before any rerun (NOT fixed in this pass, and no rerun is authorized):**
(1) line 248 must construct the session/expiry from the boundary's `PublisherEdit` shape (`id` +
`expiryTimeSeconds`) instead of passing it to the session-shape validator; (2) the catch-branch
`reconcile.reason` at `:314` must be derived from actual journal state instead of a static string.
**Both were fixed in §15.**

## 15. Harness v2 — shape fix, D6 markers, and zero-network replay evidence (2026-10-01, local only)

No live probe was run in this pass; no Google call, no new edit, no credential read, no production
source change, and Phase 4.15 status is untouched.

### 15.1 Exact change

Three scratch files (project convention: probe tooling never ships in the repository):

| File                                                        | Role                                                                                                                                                                                                                     | md5         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `playops-b4-probe-core.mjs` (new, 396 lines)                | pure control flow; receives `createEdit` / `getEdit` / `deleteEdit` / `journal` / validators / clock by injection. **Contains no module loader statements at all**, asserted at harness startup and again in the replay. | `289760e6…` |
| `playops-b4-getedit-after-delete-probe.mjs` (v2, 263 lines) | live harness: self-check, argument gate, config/credential load, identity print, scratch workDir, gates, TTY prompt, real client + real journal, then `runProbeFlow`.                                                    | `bf909436…` |
| `playops-b4-getedit-after-delete-probe.v1.mjs`              | the defective v1 preserved verbatim for the audit trail.                                                                                                                                                                 | `4e1147fe…` |
| `playops-b4-fake-replay.mjs` (626 lines)                    | zero-network replay: 10 cases, 233 assertions.                                                                                                                                                                           | `6372c3cb…` |

The shape fix itself is one pure mapper plus a two-stage validation, reusing the EXISTING production
parser rather than a copy of its rules:

```
PublisherEdit { id, expiryTimeSeconds }
  -> toSessionCandidate(): { packageName: <effective package>, editId: <id>, expiryTimeSeconds? }
  -> stage 1: parseGooglePlayEditSession({packageName, editId}, packageName)     // proves id + binding
  -> stage 2: parseGooglePlayEditSession(candidate, packageName)                 // proves expiry shape
  -> stage 3: compareEpochSeconds(getNowSeconds(), expiry) >= 0 ? expired : valid // BigInt, never Number
  -> on success: the validated session (with editId) is the only thing passed onward
```

`parseGooglePlayEditSession` was **not** weakened and no production session semantics changed; the
harness simply stopped feeding it the wrong shape. Because the same parser also validates what
`journal.record` stores internally (`cleanup-journal.ts:269-293`), probe-time validation and
journal-time validation are now provably the same rule.

### 15.2 Corrected call order (enforced by sequence and asserted by exact operation log)

```
createEdit -> validate id + expiry -> journal.record -> journal.list (read-back)
           -> getEdit (pre-delete) -> deleteEdit -> getEdit (post-delete)
           -> conditional journal.remove -> journal.list (final count)
```

No further remote call can occur before the journal record is durably persisted **and read back**.

### 15.3 Report semantics (the lying message is gone)

`reconcile.reason` is now derived only from real counters (`journalRecorded`,
`journalRecordsRemaining`, `journalReconciled`), with `derivedFrom` attached:

| Real state                                        | Wording                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `journalRecorded=false`, remaining `0`            | "no cleanup journal record was created"            |
| `journalRecorded=true`, remaining `>0`            | "cleanup journal record retained"                  |
| `journalRecorded=true`, remaining `0`, reconciled | "cleanup journal record reconciled"                |
| recorded, remaining `0`, not reconciled           | "no record remains but reconciliation did not run" |

Explicit markers replace the old inference: `editIdReturned`, `editIdValidated`, `expiryValidated`,
`validationCompleted`, `journalRecorded`, `journalReadBackConfirmed`, `preDeleteGetAttempted`,
`deleteAttempted`, `postDeleteGetAttempted`, `journalReconciled`. The three "attempted" markers are set
**immediately before** the corresponding call; `steps.failure.at` is derived from those markers. Safe
output rules are unchanged: no raw edit id, no credential path, no key, no token, no raw body.

### 15.4 Recovery branch (trustworthy id, untrustworthy expiry)

If the insert returns a trustworthy id but the expiry is missing/invalid/already expired, the harness
does **not** continue to any read or delete, does not create another edit, and reports
`recovery.remoteEditMayExist`. Whether the identity can still be preserved durably was determined
empirically against the REAL production journal on a scratch path (replay case R): a record without
`expiryTimeSeconds`, and a record with a non-decimal expiry, are both rejected with
`INVALID_ARGUMENT`; an already-expired **valid decimal** expiry is accepted. Consequence:

- missing/invalid expiry → **no durable representation exists**; the report states that limitation
  explicitly and stops (no schema expansion was performed or assumed);
- expired-but-valid expiry → the identity IS recorded, then the flow halts, leaving the record for the
  existing local-expiry reconciliation path (it does not prove anything about remote state).

### 15.5 Zero-network replay evidence

`node playops-b4-fake-replay.mjs` (run with all `PLAYOPS_*` variables unset) →
`B4_FAKE_REPLAY_PASS { cases:10, assertions:233, networkCalls:0, browserCalls:0, credentialsLoaded:0, googleApiCalls:0, realEditsCreated:0 }`, exit 0. Observed operation logs and journal counts:

| Case                                                   | Operation log                                                            | Records | Wording               |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ------- | --------------------- |
| S1 success + synthetic structured 404 (reconcile path) | create > record > list > preDelete > delete > postDelete > remove > list | 1 → 0   | reconciled            |
| S2 success + ambiguous post-delete failure (= case D)  | create > record > list > preDelete > delete > postDelete > list          | 1       | retained              |
| S3 post-delete read unexpectedly succeeds              | create > record > list > preDelete > delete > postDelete > list          | 1       | retained              |
| A `journal.record` fails after insert                  | create > record > list                                                   | 0       | no record was created |
| B pre-delete read fails (record already persisted)     | create > record > list > preDelete > list                                | 1       | retained              |
| C delete fails                                         | create > record > list > preDelete > delete > list                       | 1       | retained              |
| E pre-delete read-back identity mismatch               | create > record > list > preDelete > list                                | 1       | retained              |
| A2 recovery: expiry missing                            | create > list                                                            | 0       | no record was created |
| A3 recovery: id missing                                | create > list                                                            | 0       | no record was created |
| R2 recovery: expiry already expired                    | create > record > list                                                   | 1       | retained              |

Asserted in every case: exact ordering; D6 (a pre-delete read only after the journal write _and_ its
read-back); exactly one `createEdit`; at most one `deleteEdit`; exactly one journal record during
remote work; final count follows the synthetic result; every marker matched to an actually logged
operation; prose consistent with counters; the raw edit id absent from the report; `networkCalls=0`,
`browserCalls=0`, `credentialsLoaded=0`. Still-true v1 gates were re-verified: no-flag → refuse
(exit 2) and mismatched `--confirm-package` → refuse (exit 2), both before any credential load or
workDir creation.

**The synthetic post-delete "inactive" fixture used in S1 is NOT B4 evidence and must not be used to
implement the production classifier.**

### 15.6 Production impact: none

Only scratch probe files changed. `src/**` and `dist/**` mtimes and content are unchanged, no `src`
file is newer than its `dist` counterpart, and no production helper was added or modified, so the five
gates were not required and were not run (nothing in `dist` changed for them to observe).

### 15.7 Previous orphan (unchanged, must not be guessed around)

**A previous live `edits.insert` on `com.dhikrama.driver` may have left one active edit whose id was
never persisted.** Its id must not be guessed, no arbitrary delete may be attempted, and it must not
be claimed as cleaned up. A future `edits.insert` may supersede/invalidate it under Google's
single-active-edit semantics, but that is **not verified cleanup** and no such insert was performed in
this pass. B4 stays OPEN and Phase 4.15 stays `[ ]`.

## 16. Raw SDK error observation — wrapper loss located, one read-only GET (2026-10-02)

No production source, test, or `dist` file was changed by this pass. No Edit was created, deleted,
uploaded, updated, validated, or committed. No journal write or removal occurred (sha256 identical
before/after). Phase 4.15 remains `[ ]`; B4 remains **OPEN**.

### 16.1 Wrapper information loss (local, zero-network, verified)

Diagnostic: `/home/dhikrama/.hermes/cache/scratch/playops-b4-wrapper-trace.mjs` — real `GaxiosError`s
produced by a **loopback** HTTP server (`127.0.0.1`), fed through the production `getEdit`
(`dist/googleplay/publisher/index.js`). Zero Google calls; no credentials loaded.

Raw boundary (installed `gaxios@7.3.1`, `@googleapis/androidpublisher@42.1.0`, `googleapis-common@9.1.0`):
own keys of the thrown error are `stack, message, cause, config, response, code, status, error`. For an
HTTP error response: `code` is numeric (e.g. `404`), `status` is the numeric HTTP status,
`response.status` is the numeric HTTP status, `response.data.error.{code,status,errors[].reason,details}`
is the AIP-193 body, and `cause` is the extracted error-info object
`{message, code, status, errors, details}`.

Production `wrapApiError` output (`PublisherError`): own keys
`stack, message, cause, code, name, reason, externalStateUncertain`, with `code = "API_REQUEST_FAILED"`
and **no `status` and no `response`**; `reason` exists but is `undefined` on this path.

**Fields discarded at the observable `PublisherError` surface:**

1. numeric HTTP status as a structured field — it survives only **inside the human message string**
   (e.g. `"edits.get failed for ... (status 400): Google API request failed"`);
2. `response.data.error.status` (machine-readable Google status, e.g. `NOT_FOUND`);
3. `response.data.error.code` (numeric API error code);
4. `response.data.error.errors[].reason` (structured reason);
5. `response.data.error.details` (typed detail entries);
6. transport/system `code` strings (e.g. `ECONNRESET`).

**Correction to the earlier premise.** The raw error object is **not destroyed**: `wrapApiError` passes
it as the error `cause` (`{ cause }` → `super(message, options)`), so it remains reachable at
`publisherError.cause`. What the wrapper does not do is _surface_ any of it structurally — and the
previous probe's projector (`playops-b4-probe-core.mjs`, `structuredErrorMetadata`) read
`cause.response` / `cause.status` on the **PublisherError itself** and never descended into
`cause.cause`. That fully explains the earlier all-`null` `postDeleteRead`: it was an artifact of the
read level, **not** proof of a statusless remote error. The COMPILER-VISIBLE `PublisherError.code` is
the string `"API_REQUEST_FAILED"`, which `safeStatus` already rejects, so it can never carry the status.

### 16.2 Probe-local safe projector and fake tests (no live use)

`/home/dhikrama/.hermes/cache/scratch/playops-b4-raw-error-evidence.mjs` defines a pure, total projector
(`projectThrownError`) that copies only named allowlisted primitives — it never spreads, serializes, or
echoes the thrown value: `errorTypePresent, code, status, responseStatus, apiErrorCode, apiErrorStatus,
reasons[], detailTypes[], messagePresent, messageLength`. Google status/reason tokens are allowlisted by
shape (`^[A-Z][A-Z0-9_]{0,63}$`, `^[A-Za-z][A-Za-z0-9_]{0,63}$`); type URLs by
`^[A-Za-z0-9_./:-]{1,160}$`.

`--self-test` result: **193 assertions, 0 failures**, `networkCalls 0`, `googleApiCalls 0`,
`credentialsLoaded 0`. Cases A–F (404, 403, 429, 500, `ECONNRESET` transport with no response, and
malformed/hostile inputs including throwing getters) preserved the safe fields, never emitted message
text, headers, config, URL, or tokens, and never threw. The probe's own source is scanned at startup and
the only Google operation it can reach is `edits.get` (any other `edits.<verb>(` refuses the run).

### 16.3 Retained journal validation

Only `/tmp/playops-b4-probe-TX5SKW/edit-cleanup-journal.json` was read, through the **production**
parser `createFileReleaseEditCleanupJournal(path, { expectedPackageName: "com.dhikrama.driver" })`:
`list()` returned exactly **1** record, `record.packageName === "com.dhikrama.driver"`,
`source === "exact_release_verification"`. The raw edit id was never printed. The journal file was not
written or removed: sha256 `64c263e829c7a022e31534e292d84cc11b29cd2a6043d7783520c4fee3eeb90d` was
identical before and after the run.

### 16.4 The single live read-only observation

Exactly **one** Google API operation: the raw generated client
`edits.get({ packageName, editId }, { retry: false })` — retry disabled at client scope **and** per call
— using the existing configured service account (no credential path printed). Effective target was
asserted to equal `com.dhikrama.driver` and to differ from `com.bizdirect.app`.

Raw projected result:

| Field                            | Value                    |
| -------------------------------- | ------------------------ |
| `errorTypePresent`               | `true`                   |
| `code`                           | `400`                    |
| `status`                         | `400`                    |
| `responseStatus`                 | `400`                    |
| `apiErrorCode`                   | `400`                    |
| `apiErrorStatus`                 | `"FAILED_PRECONDITION"`  |
| `reasons`                        | `["failedPrecondition"]` |
| `detailTypes`                    | `[]`                     |
| `messagePresent`/`messageLength` | `true` / `27`            |

**HTTP status observable at the raw boundary: YES** (400 present in four independent places:
`error.code`, `error.status`, `error.response.status`, `error.response.data.error.code`).
**Machine-readable Google status/reason observable: YES** —
`response.data.error.status = "FAILED_PRECONDITION"` and
`response.data.error.errors[0].reason = "failedPrecondition"`.

The message text was deliberately **not** captured (presence + length only, per the capture allowlist).
Any token-acquisition request by the auth library is not an Edits operation and was not separately
counted; `googleApiCalls = 1` counts the one permitted API operation.

### 16.5 Full sequence now proven for this exact edit

`edits.insert` OK → id/expiry validated → journal recorded **and read back** → pre-delete `edits.get` OK
(same id, same package) → `edits.delete` OK (one attempt, `retry:false`) → post-delete `edits.get`
**fails with HTTP 400 / `FAILED_PRECONDITION` / reason `failedPrecondition`**.

Inference (not proof): the delete is the only change between the successful pre-delete read and the
failing post-delete read, so the post-delete failure is _attributed_ to the delete. The delete's own
response is still only an acknowledgement, not proof of remote inactivity.

### 16.6 Classifier: candidate evidence only — NOT implemented, NOT sufficient to weaken policy

A structured signal exists, but this is **one observation on one application**, and it is **400
`FAILED_PRECONDITION`**, not a 404. `FAILED_PRECONDITION` is a generic Google precondition code that
could equally accompany an edit that never existed, was superseded, expired, or is otherwise unusable,
and the message text that might disambiguate is intentionally not captured. Therefore:

- do **not** implement "any 404 = inactive" (no 404 was observed here at all);
- do **not** implement "any `FAILED_PRECONDITION` = inactive";
- do **not** implement "any `API_REQUEST_FAILED` after delete = inactive".

Candidate narrow signal for a **future** verifier, subject to more observations and operator review: an
`edits.get` executed **immediately after an acknowledged delete of that exact id, for that exact
package**, failing with HTTP 400 **and** `apiErrorStatus === "FAILED_PRECONDITION"` **and**
`reasons` containing `"failedPrecondition"`. Even then, 401 / 403 / 429 / 5xx / transport /
unclassified must remain UNKNOWN.

### 16.7 Minimal production wrapper change (proposal only — NOT implemented)

The smallest change that preserves safe structured classification without exposing raw Gaxios objects or
raw messages, mirroring the existing `safeStatus` / `structuredCommitRejectionReason` patterns: extend
`PublisherError` with optional `status?`, `googleStatus?`, and `googleReason?` (populated only from the
allowlisted fields in §16.1) and have `wrapApiError` fill them from
`cause.response.data.error.{status,code}`/`errors[].reason` plus `safeStatus(cause)`. No message text, no
headers, no config, no change to retry semantics. **Await operator review; not implemented in this
pass.**

### 16.8 Status

Journal record count after the observation: **1** (retained). No new mutation was performed. Phase 4.15
remains `[ ]`; B4 remains **OPEN**.

## 17. Resolution (2026-10-02) — B4 RESOLVED by a narrow contextual verifier

§16.8 above is superseded: **B4 is RESOLVED** and Phase 4.15 is `[x]`.

The captured evidence was not turned into a global rule. Instead:

- the production Google boundary now surfaces only allowlisted structured metadata (`status`,
  `googleStatus`, `googleReasons`, `transportCode`) projected by the pure, total
  `projectPublisherErrorMetadata`; raw messages, headers, config, URLs, credentials, tokens, response
  bodies, and the raw Gaxios object are never copied or serialized;
- `src/releases/post-delete-verification.ts` provides the pure contextual classifier
  `classifyPostDeleteEditRead`, which returns REMOTE_INACTIVE only for the complete confirmed-delete
  context described in §16.5 and UNKNOWN otherwise — `400` alone, `FAILED_PRECONDITION` alone,
  `failedPrecondition` alone, and every 401/403/429/5xx/transport/unclassified outcome stay UNKNOWN;
- `releases.cleanup_known_edit` uses it: one fresh exact `edits.get` → exactly one retry-disabled
  `edits.delete` → post-delete exact `edits.get` → contextual verdict → conditional local
  reconciliation plus read-back, with every unverified outcome retaining the record and issuing no second
  delete;
- standalone `releases.inspect_edit_hygiene` remains conservative and still reports a bare failure as
  UNKNOWN.

**The retained journal `/tmp/playops-b4-probe-TX5SKW/edit-cleanup-journal.json` was left untouched**
(sha256 `64c263e8…`, exactly one record) and deliberately NOT reconciled: it has no confirmed-delete
context inside the production workflow, so ordinary hygiene inspection reports it UNKNOWN. That is the
intended conservative behaviour and it does not block Phase 4.15 acceptance.

The single observation on `com.dhikrama.driver` remains documented as evidence for that workflow context
— one controlled observation, not a permanent Google API contract.
