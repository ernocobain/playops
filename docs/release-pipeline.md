# Release pipeline: current runtime capabilities and CLI limits

[Quickstart](../README.md) · [Configuration](credentials.md) · [Permissions and approvals](permissions-and-approvals.md) · [Audit format](audit-log.md)

## Scope and evidence

PlayOps consumes an **operator-provided, already-built `.aab`**. It does **not** compile Android apps, invoke Gradle, or provide an Android build pipeline. Build/sign your app outside PlayOps.

The Release Agent has implemented tools for managed edits, bundle upload, version/track checks, release configuration/notes, validation, exact commit approval, independent published-state verification, staged rollout control, halt/resume and known-edit hygiene/cleanup. Their acceptance is **fake/mock-only**, apart from the separately recorded prior read evidence and narrowly scoped edit-cleanup observation. Review reply, bundle-upload, `tracks.update`, commit and rollout mutation authorization remain **live-unverified**; a passing dry-run or doctor does not resolve them.

### There is no one-command live release CLI

The installed command surface accepts only:

```sh
playops releases --dry-run releases.commit_edit
```

**Current installed behavior:** exit **1** with `No trusted composition-bound release operation is available; no API, credential, approval, or session access was performed.` The entrypoint does **not** supply the required trusted operation factory. The syntax is valid, but there is no usable live-release or configured dry-run orchestration in the installed CLI. `releases --help` is not implemented either. Use the top-level help and this guide for the limitation, rather than assuming a missing command works.

The rest of this guide describes **runtime tool capabilities and their safe progression**, not shell commands you can type. A trusted composition/caller must supply validated operator intents, register the requested tools, and use the real permission/approval/verification/audit runtime. CLI-first packaging does not advertise a public library API or a stable deep-import integration surface.

## Inputs and prerequisite state

Runtime Release composition uses the configured package/credential/audit path and requires `release.edit_session_path`. Deep verification, rollout/status control, hygiene and exact cleanup also need `release.edit_cleanup_journal_path`. Credential, session and journal files remain external to the installed package; relative paths use cwd.

The artifact path (for example, fake `/path/to/artifacts/example-release.aab`), track, release name/status, retained codes, localized notes and rollout intent are **operation-scoped, operator/composition-bound inputs**. They are not model-supplied targets, config-file release commands, or options currently exposed by the installed bin. Validated bundle version codes are retained as exact decimal strings (an illustrative version is `"123"`); no guess about the global app version history is made.

## Conceptual safe progression

Each named item below is a runtime capability, **not an installed CLI command**. Every ordinary mutation needs a verifier; every destructive/publish item additionally needs exact human approval. Refusals are stops, not instructions to repeat a mutation.

1. **Inspect known state, then open a managed edit — `releases.inspect`, `releases.open_edit`.** Inspection is `read` and never silently inserts an edit. Opening is **`destructive`**, because Google edit creation may invalidate other uncommitted work for the same app/API user. After approval it re-checks the local session and refuses an active tracked edit, inserts once without automatic retry, persists its returned identity/expiry, then verifies both `edits.get` and local read-back. Approval does not override concurrency protection.
2. **Upload the prebuilt AAB — `releases.upload_bundle` (`write`).** The exact artifact path is trusted input. The tool checks the managed session/edit, computes local SHA-256, uploads once with generated retry disabled, and verifies exact returned versionCode/SHA-256 via `edits.bundles.list`. It does not commit or build the file. Ordinary write permission does **not** request interactive approval.
3. **Verify version code — `releases.verify_version_code` (`read`).** Reconfirms the exact uploaded bundle identity and requires its versionCode to be strictly greater than every code currently returned for the operator-bound target track. This is **target-track evidence**, not a scan of every code ever used by the app.
4. **Inspect the target track — `releases.inspect_target_track` (`read`).** Reads the actual bound track and releases, including status/fraction, without changing them. Track selection is explicit trusted input, not a default inferred by the model.
5. **Configure the release — `releases.configure_release` (`write`).** Binds the uploaded identity and operator-selected track/name/status/initial fraction and any explicit retained codes. Fresh session/edit/bundle/track/version checks precede one `edits.tracks.update` on **only the bound track**. Its request constructs the track's `releases` array with **one new release** containing the uploaded version plus explicitly supplied retained version codes (none retained by default). It **does not preserve the track's full prior release array or its metadata**: prior notes/priority are not round-tripped. `tracks.get` verifies the intended release's identity, codes, status and fraction, not preservation of the entire previous track state. Inspect the current track and choose retained codes deliberately; this is not the notes tool's full-state preservation contract. No commit occurs here. Staged rollout is represented with `inProgress` and a valid fraction; validation failures stop the operation.
6. **Attach localized notes — `releases.attach_release_notes` (`write`).** Binds the configured release, bundle and track. Locales use canonical BCP-47; duplicate canonical locales and invalid/control-bearing text fail; each note is limited to **500 Unicode code points**. Fresh state checks precede one track update; read-back checks exact notes and preservation of non-note state. No LLM invents or approves release notes in this path.
7. **Validate — `releases.validate_edit` (`read`).** Confirms local/remote identity and expiry, calls `edits.validate` on that exact session, and returns validation evidence. It never commits or requests publish approval. Validation is not proof of mutation authorization or published state.
8. **Obtain exact publish approval.** Trusted commit intent binds package, edit, track, version, release, status/fraction, notes/state digest, validation expiry and review behavior. The human summary warns about app changes and invalidating other active edits. The current policy is **`ERROR_IF_IN_REVIEW`**; approval cannot authorize cancelling a review or an unrelated operation.
9. **Commit — `releases.commit_edit` (`publish`).** After approval, re-loads the session, re-reads the exact edit/track, compares the approved state digest, and validates again. Changed/expired state stops before commit and requires fresh approval. It attempts commit once, disables automatic retry, and submits `changesNotSentForReview:false`. Confirmed acknowledgement closes the local session with read-back and emits domain audit evidence. This boundary reports **`liveReleaseVerified:false`**: successful commit is **not** independent published-state verification.
10. **Independently inspect/verify the committed state.** Layer A, `releases.inspect_committed_release` (**`read`**), uses the direct deployed-release summary to confirm track/version/release identity without opening an edit; it cannot prove exact `completed`/`inProgress`/`halted` status, fraction or notes. Layer B, `releases.verify_committed_release` (**`destructive`**), requires **separate** approval, first obtains Layer A evidence and requires an empty managed session, then inserts a temporary edit, journals its exact identity before more remote work, reads exact `TrackRelease` state and deletes that temporary edit once. Full success proves expected status/fraction/notes with cleanup; it **does not prove serving/device propagation** (`servingPropagationVerified:false`). Missing/ambiguous Layer A evidence stops before temporary creation.
11. **Advance a staged rollout when applicable — `releases.update_rollout_fraction` (`destructive`).** A separate exact approval binds the existing `inProgress` release and old/new fraction. The new fraction must be strictly greater than the current fraction and strictly between 0 and 1; this tool does **not** complete the rollout at 1, upload or create a new release. It opens an operational edit, re-checks fresh target/non-target state, changes only the fraction, validates/commits once under `ERROR_IF_IN_REVIEW`, and performs bounded direct/deep post-commit verification. Temporary verification edits use the cleanup journal.
12. **Halt/resume when applicable — `releases.halt_rollout`, `releases.resume_rollout` (both `destructive`).** Separate exact approvals bind the fresh release/state/fraction. Halt changes `inProgress` → `halted`; resume changes `halted` → `inProgress` with the preserved trustworthy fraction strictly between 0 and 1. They never complete, advance the fraction, upload or invent another release; unrelated state stays unchanged. Validation, one commit and independent read-back remain required.
13. **Inspect and clean only known leftover state — `releases.inspect_edit_hygiene`, `releases.cleanup_known_edit`.** See below. Cleanup is not an automatic janitor and cannot turn UNKNOWN into inactive simply because an operation failed.

The tools are separately registered capabilities, not one transaction. Fresh exact operation bindings and verification are required at their own boundaries; a previous successful/approved step does not automatically authorize the next.

## Dry-run contract

The pure Release dry-run planner describes the intended API sequence, permission, approval requirements, safe body shape, local actions and unresolved remote preconditions for all current mutating Release tools. It performs **no API/network/browser call, credential access, approval request/token consumption, session/journal mutation or audit write**. Rendering/CLI output and supplemental CLI diagnostics are not Release mutations.

Remote edit IDs, hashes, version/track state and expiry not known locally appear as **symbolic runtime values/result references**, not fabricated evidence. Notes are shown as safe redacted shapes. No draft plan proves local artifact validity, remote preconditions, authorization or successful publication. The installed adapter currently refuses without a trusted factory as explained above; adding configuration does not silently enable it. This guide does not supply an ad-hoc deep-import workaround that bypasses the supported CLI or approval gate.

## Known-edit hygiene and cleanup

The external **managed-session file** preserves the exact operational edit. The **cleanup journal** durably preserves known temporary verification-edit identities immediately after a valid insert response, before track reads. Failed/malformed/foreign journal state is rejected, not overwritten. Both have single-process atomic persistence but **no cross-process lock**.

`releases.inspect_edit_hygiene` is **`read` / report-only**. It considers only the managed session and known journal entries:

- `expired`: trusted local expiry elapsed; this is not a claim of remote deletion.
- `active`: the exact remote read succeeded and matched the recorded identity/expiry.
- `unknown`: unreadable/malformed/foreign local state, failed or mismatched remote reads, or otherwise undecidable state. It never deletes, clears or reconciles records. Auth/transport/429/5xx and a bare `400` / `FAILED_PRECONDITION` do **not** prove inactivity.

`releases.cleanup_known_edit` is **`destructive`** and requires a separately approved, exact known record selected by trusted composition. There is no model-selected edit ID, wildcard, bulk cleanup, background cleanup or operator cleanup command in the installed CLI.

- **Local-expiry path:** trusted recorded expiry permits removing only that exact local record and verifying removal, with **zero Google calls**. No remote deletion is claimed.
- **Confirmed-active path:** after approval and exact local re-check, one fresh successful matching `edits.get` permits **one retry-disabled `edits.delete`**, followed by a read of the same exact identity. Local reconciliation occurs only when the **complete confirmed-delete context** matches the narrow post-delete verifier: same package/edit, successful pre-read, acknowledged single retry-disabled delete, then HTTP 400 with `FAILED_PRECONDITION` and `failedPrecondition`. The tuple alone is never a global inactive signal; the contextual rule rests on one controlled observation, not a permanent Google contract.
- **Anything else:** retain the record, report the failure/uncertainty, and issue no second delete. A retained historical UNKNOWN record is **not automatically deleted or reconciled**. Approval cannot override UNKNOWN.

Google exposes no active-edit listing for PlayOps discovery. If Google accepted an insert but the process died before receiving/persisting a trustworthy identity, PlayOps cannot reconstruct that unknown edit. Empty local state does not prove another process has no active remote edit. The cleanup journal reduces known-identity loss; it does not remove the insert-response crash window.

**Temporary cleanup is tool-specific, not a universal single-attempt guarantee.** Exact post-commit verification and halt/resume use guards to avoid a second temporary-delete attempt. **Current rollout advancement is an exception:** after a failed post-commit temporary-edit delete, its outer catch can invoke `deleteEdit` again for that same identity. A failed journal-write recovery delete can enter the same second-call path. Each wrapper invocation disables generated-client retry, but that does **not** prevent two workflow calls. When both deletes fail, the operation reports `ROLLOUT_VERIFICATION_CLEANUP_FAILED`, external state is uncertain, and a successfully written journal record remains. This existing runtime limitation is documented, **not fixed by this documentation-only milestone**; it is not permission for an operator to retry automatically.

Temporary flows' confirmed-delete acknowledgement is not advertised as the same post-delete contextual proof provided by the explicit `cleanup_known_edit` tool. That tool's exact single-delete contract above remains separate. Do not delete journals to make a report look clean.

## When a step fails

Stop and preserve the relevant audit/session/journal evidence. An operation may already have changed Google even if output, verification, cleanup or audit persistence failed. If **`externalStateUncertain=true`**, inspect current remote state **before** another action; **never blindly retry** upload/commit/rollout/destructive work. Use read-only inspection under its existing bounded retry contract where appropriate. Do not treat temporary cleanup success as proof that a release mutation was rolled back.

The Release pipeline is implemented and fake-tested; the installed CLI exposure, live authorization, propagation, multi-process and crash-window limitations above remain explicit. Security review and versioning/release-process milestones are still pending.
