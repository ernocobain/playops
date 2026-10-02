# Phase 4.15 — Edit lifecycle hygiene — STATUS: SAFE SUBSET IMPLEMENTED, REMOTE DELETE BLOCKED

> Operator decision (2026-10-01): D1–D6 locked, then **Option 1 — implement the safe subset**
> (durable journal + read-only hygiene inspection + local-expiry reconciliation; remote active
> edits stay report-only).
>
> `PLAYOPS_PLAN.md` is deliberately **untouched**: Phase 4.15 remains `[ ]`, and no phase after it
> was started. The roadmap item's "deleted" half cannot be verified for a remote edit, so `[x]`
> would overclaim (§7).

## 1. Goal (roadmap wording)

`PLAYOPS_PLAN.md:277` — "Edit lifecycle hygiene: abandoned/failed edits are detected and either
deleted or reported; unit-tested." Phase 4.15 had not been started (`:583`).

## 2. Locked decisions (D1–D6, operator-issued)

- **D1 — expired managed record:** explicit operator action only; no implicit self-heal, no
  startup/background janitor. If trusted local expiry already proves `now >= expiryTimeSeconds`:
  remote DELETE = 0, no claim a remote delete occurred, reconcile only the exact local lifecycle
  record, read back local state to verify removal.
- **D2 — active managed edit:** may be abandoned only with an exact destructive approval bound to that
  specific known edit. The human summary MUST warn that deleting it permanently discards uncommitted
  Google Play edit state. No bulk cleanup, no clean-all, no wildcard candidate, no model-selected edit ID.
- **D3 — unknown:** a lifecycle record PlayOps actually possesses whose remote state cannot be
  established safely (corrupt record, package-binding mismatch, transient/auth/transport `getEdit`
  failure, unclassified Google error, undecidable inside bounded read policy) → DELETE = 0, record
  retained, REPORT ONLY. An arbitrary remote edit whose identity PlayOps never persisted is **outside
  PlayOps' discoverable universe** (Android Publisher exposes no `edits.list`); that limitation is documented.
- **D4 — `getEdit` failure is NOT automatically inactive:** only classify `REMOTE_INACTIVE` when an
  existing Google-error boundary can identify a structured, allowlisted inactive signal safely.
  401/403/429/5xx/timeout/`ECONNRESET`/unknown reason become UNKNOWN. If no evidence-backed safe
  classifier exists → **STOP and report**; never invent one from human error strings.
- **D5 — runtime-compatible ordering:** inspection (`read`, no approval) may do read-only `getEdit`
  classification; cleanup (`destructive`) must pass the normal Phase 2 destructive approval gate
  **before** its execution callback. No "GET first, then ask approval inside the tool". Approval never
  overrides UNKNOWN.
- **D6 — temporary-edit journal ordering:** preconditions → `edits.insert` exactly once → validate
  returned id + expiry → persist the exact journal record IMMEDIATELY → only then may `tracks.get` or
  further remote work continue → confirmed `edits.delete` → remove the exact journal record. Journal
  persistence failure after a successful insert: stop the normal workflow, no `tracks.get`, no second
  edit, one `retry:false` delete attempt for that exact id, `externalStateUncertain = true` if deletion
  cannot be confirmed. No pre-insert pending marker; the irreducible insert-response window stays documented.

## 3. D4 gate investigation — evidence actually observed (2026-10-01, live browser reads)

| Source (official unless noted)                                                     | Last updated       | What it actually says about a non-active edit                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `developers.google.com/android-publisher/api-ref/rest/v3/edits/get`                | 2025-05-21 UTC     | Path params, empty body, `AppEdit` on success. **No error section at all**; literal `404` does not occur in the page HTML.                                                                                                                                                    |
| `.../rest/v3/edits/delete`                                                         | 2025-05-21 UTC     | Success body is an empty JSON object. **No error section**; no documented "already gone" no-op semantics.                                                                                                                                                                     |
| `.../rest/v3/edits` (REST Resource)                                                | **2026-09-28 UTC** | Has an "Error codes" section — "The operations of this resource, return the following HTTP error codes:" — whose table contains **only the header row** (`Error code / Reason / Description / Resolution`, zero data rows). Neither `notFound` nor `404` appears in the HTML. |
| `.../rest/v3/edits/commit`                                                         | live               | Documents exactly **one** structured rejection: `ERROR_IF_IN_REVIEW` → HTTP 400 plus a JSON error sample. This is why the existing commit classifier is evidence-backed.                                                                                                      |
| `.../rest/v3/edits/validate`, `.../edits/insert`                                   | 2025-05-21 UTC     | No error section.                                                                                                                                                                                                                                                             |
| `developers.google.com/android-publisher/concurrency-considerations` + Edits guide | 2025-12-18 UTC     | Invalidation semantics only; **no error codes**.                                                                                                                                                                                                                              |
| API-library docs (python/java)                                                     | —                  | "Calls will fail if the edit is no long active (e.g. has been deleted, superseded or expired)." No status code, no reason string; the page contains zero occurrences of `404`, `error`, `reason`, `notFound`.                                                                 |
| Installed SDK `@googleapis/androidpublisher@42.1.0` (+ `gaxios@7.3.1`)             | local              | `Schema$AppEdit` declares only output-only `id` / `expiryTimeSeconds`; method doc comments are only "Gets an app edit." / "Deletes an app edit." No error contract.                                                                                                           |
| Repository error boundary (local)                                                  | local              | Only structured classifier: `structuredCommitRejectionReason` (`src/googleplay/publisher/index.ts:779-796`) allowlisting `error.status` / `error.errors[].reason` for `CHANGES_ALREADY_IN_REVIEW`, plus `isCertainCommitRejection` (4xx except 408/429, `:798-801`).          |

**Gate result: FAILED.** Google documents no structured, allowlisted signal (status + reason) that
identifies an inactive/deleted/superseded/expired edit. A bare 404 is not unique — it can equally mean
a wrong package, project, or disabled API — so it is not safe as an inactivity proof, and building one
from the human-readable message is exactly what D4 forbids. The safe asymmetry is:

- `edits.get` **success** ⇒ the edit is active (one-directional, evidence-backed);
- `edits.get` **failure** ⇒ undecidable ⇒ UNKNOWN.

## 4. Implemented safe subset

| Artifact                                                                                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/releases/cleanup-journal.ts`                                                                               | Durable, versioned, atomic (`temp → fsync → rename`) journal of KNOWN ephemeral edit ids. Allowlisted record keys only (`version`, `packageName`, `editId`, `expiryTimeSeconds`, closed `source` enum, `createdAt`); malformed/unsupported/foreign state fails safe and is never overwritten; `record` / `list` / `remove`; local expiry classification helper.                                                             |
| `src/config/{types,loader}.ts`, `config/playops.example.yaml`                                                   | `release.editCleanupJournalPath` + `PLAYOPS_RELEASE_EDIT_CLEANUP_JOURNAL_PATH` (YAML `edit_cleanup_journal_path`). Journal-backed capabilities require a non-empty path.                                                                                                                                                                                                                                                    |
| `src/releases/hygiene-tool.ts`                                                                                  | `releases.inspect_edit_hygiene` — `read`, input `{}`, no approval, no verifier, REPORT ONLY. Classifies every KNOWN record (managed session, journalled verification edit) as `expired` / `active` / `unknown` with closed reasons; never deletes, clears, or scans remote edits; serializer leaks no edit id.                                                                                                              |
| `src/releases/cleanup-tool.ts`                                                                                  | `releases.cleanup_known_edit` — `destructive`, input `{}`, exact approval digest/summary bound to the exact bound record, no wildcard/bulk/model-selected candidate. Local-expiry proof ⇒ DELETE 0 + exact local reconciliation + read-back; active ⇒ `EDIT_CLEANUP_REMOTE_DELETE_UNVERIFIABLE`; undecidable ⇒ `EDIT_CLEANUP_STATE_UNKNOWN`; both retain the record and issue no delete. No remote-delete code path exists. |
| `src/releases/{verify-committed-release,rollout,status-control}-tool.ts`                                        | D6 ordering wired into all four temporary-edit sites (Phase 4.11 Layer B, 4.12 rollout, 4.13 halt/resume): journal write before any further Google call, removal only after a confirmed delete, journal-write failure without `tracks.get` and with no second delete.                                                                                                                                                       |
| `src/releases/dry-run.ts`                                                                                       | `releases.cleanup_known_edit` added as the 10th mutating capability; the plan shows the fresh read, the conditional delete explicitly marked **NOT EXECUTED IN THIS BUILD**, the post-delete read, and the conditional local reconciliation.                                                                                                                                                                                |
| `src/releases/{index,gateway,composition}.ts`                                                                   | Typed error codes for journal/hygiene/cleanup, narrow read-only hygiene/cleanup gateway views, composition wiring and tool registration.                                                                                                                                                                                                                                                                                    |
| `tests/releases-edit-cleanup.test.ts` + additions to readback/rollout/status-control/dry-run/composition suites | Journal integrity, hygiene classification across every failure kind, cleanup refusal paths, D6 ordering, Phase 2 gate behaviour, dry-run coverage.                                                                                                                                                                                                                                                                          |

## 5. Verification evidence (local Node v26.9.0)

- `NODE_ENV=development npm run test:run` → **1407/1407 tests across 66 files**, exit 0.
- `npm run typecheck` → exit 0; `npm run lint` → exit 0; `npm run format:check` → "All matched files
  use Prettier code style!", exit 0; `npm run build` → exit 0.
- Built fake-only smoke `node /home/dhikrama/.hermes/cache/scratch/playops-phase415-built-smoke.mjs` →
  `BUILT_PHASE415_EDIT_HYGIENE_SMOKE PASS { checks: 46, failed: 0, mutatingToolsCovered: 10,
networkCalls: 0, browserCalls: 0, getEditCalls: 6, remoteDeleteCalls: 0, insertCalls: 0,
commitCalls: 0, trackUpdateCalls: 0, phase2Verifications: 1 }` over compiled `dist/` plus the real
  Phase 2 permission/verification contracts, fake gateways only.
- Handoff proofs: (1) no `getEdit` failure treated as inactive; (2) 401/403/429/5xx/timeout/`ECONNRESET`/
  unclassified ⇒ UNKNOWN with delete 0; (3) no remote "inactive" classifier is depended on — only
  trusted local expiry reconciles; (4) cleanup approval runs through the normal Phase 2 gate before
  execution; (5) the bound record is re-read before anything else on execution; (6) the journal write
  happens after the valid insert and before any subsequent Google call; (7) a journal write failure
  prevents `tracks.get`; (8) it triggers at most one exact immediate delete; (9) no pre-insert journal
  record; (10) the irreducible insert-response crash window is documented; (11) no `edits.list`/global
  discovery (source-scan tests); (12) Phase 4.1–4.14 remain green; (13) dry-run coverage includes
  `cleanup_known_edit`.
- Scope: runtime dependencies remain exactly 4; `package.json`
  `d1ca499f3408e507e44d4ad7a88107f8da5ed786f8b58be38132f17718008a53` and `package-lock.json`
  `8f8b2805eb7acdcea9dd67212071e5df84c24ab139e741d50b7348d58599017e` are unchanged; no live Google call,
  credential read, browser action, or Git commit occurred (repository remains unborn `master`).

## 6. Honest limitations (unchanged by this work)

- **Irreducible insert-response window:** Google may accept `edits.insert` while the process dies before
  a trustworthy editId is received and journalled. No `edits.list` exists, so PlayOps cannot reconstruct
  that remote identity afterwards. Phase 4.15 does not remove this API-level limitation.
- **No remote deletion:** an active leftover edit can be detected and reported, but PlayOps cannot
  abandon it until Google documents a safe structured inactivity signal (or the operator authorises a
  live evidence probe).
- **Single-process atomicity only:** the journal, like the session store, has no distributed lock.
- **Not yet exposed as a CLI command:** the cleanup candidate is trusted composition input; there is no
  operator command that selects it.

## 7. Status and remaining blocked work

> **SUPERSEDED 2026-10-02 — see §8 below.** Phase 4.15 is now `[x]` and B4 is RESOLVED.

- Phase 4.15 remains `[ ]`: the roadmap acceptance says abandoned/failed edits are "detected and either
  deleted or reported". Detection and reporting are implemented and verified for every known record;
  remote **deletion** is not, so marking `[x]` would overclaim.
- Blocked: (a) remote `edits.delete` for an active known edit plus its post-delete `getEdit` verifier;
  (b) automation/CLI surface for candidate selection; (c) the `PLAYOPS_PLAN.md §14` blocker entry and the
  Phase 4.15 checkbox decision — left to the operator on purpose.
- Options for the blocked half: live evidence probe (needs explicit authorisation and does invalidate
  other active edits owned by the same API user), or wait for Google to fill the empty `REST Resource:
edits` error-code table.
- No phase after 4.15 was started.

## 8. SUPERSEDED (2026-10-02) — remote deletion implemented with a narrow contextual verifier

Everything in §7 above is superseded. Phase 4.15 is now `[x]` and B4 is **RESOLVED**.

- A controlled live observation on `com.dhikrama.driver` (accepted by the operator, recorded in
  `docs/phase-4.15-b4-probe-plan.md` §16) showed that an `edits.get` for an edit deleted in the same
  workflow fails with HTTP 400 / `FAILED_PRECONDITION` / `failedPrecondition`. That is evidence for one
  workflow context, **not** a documented Google contract, and the operator explicitly declined a global
  `400 ⇒ inactive` / `FAILED_PRECONDITION ⇒ inactive` rule.
- The production Google boundary now surfaces allowlisted structured metadata
  (`status`, `googleStatus`, `googleReasons`, `transportCode`) through the pure, total
  `projectPublisherErrorMetadata`; `ReleaseError` carries the same allowlisted classification, and no
  Google SDK/Gaxios type crosses into `src/releases`.
- Blocked item (a) is closed: `releases.cleanup_known_edit` performs exactly one retry-disabled
  `edits.delete` for one exact confirmed-active known edit, then a post-delete `edits.get` of the same
  identity, and treats the edit as inactive ONLY for the complete confirmed-delete context
  (`classifyPostDeleteEditRead`). Local reconciliation happens only for that verdict; every unverified or
  unacknowledged outcome retains the record, issues no second delete, and clears nothing local.
- Standalone `releases.inspect_edit_hygiene` is deliberately unchanged: a bare `getEdit` failure remains
  `unknown`, because it has no confirmed-delete context.
- Blocked item (b) — no operator CLI surface for candidate selection — and every honest limitation in
  §6 (single controlled observation, `FAILED_PRECONDITION` genericness outside the context, the
  irreducible `edits.insert`-response window, single-process journal atomicity) remain unchanged.
- The retained B4 probe journal was left untouched and deliberately not reconciled (§16 of the probe
  plan); ordinary hygiene inspection still reports it UNKNOWN, which does not block acceptance.
