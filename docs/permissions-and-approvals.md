# Permission model and approval flow

[Quickstart](../README.md) · [Audit format](audit-log.md) · [Release walkthrough](release-pipeline.md)

## Three separate controls

**Permission** declares what a registered tool can do. **Approval** is a human decision bound to one exact gated operation. **Verification** checks the resulting state after execution. Approval does not prove success; an API acknowledgement does not replace read-back; verification cannot grant permission. Google Play authorization is an additional external requirement, independent of these PlayOps controls.

The current runtime has exactly four permission levels:

| Permission    | Implemented meaning and examples                                                                                                                                                                                                                                                                                                                                       | Human approval                              | Post-action verifier                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `read`        | Observation, analysis or draft generation without a Google mutation. Examples: `reviews.classify`, `reviews.draft_reply`, `releases.inspect`, `releases.inspect_target_track`, `releases.verify_version_code`, `releases.validate_edit`, `health.compare_to_baseline`, `health.check_thresholds`.                                                                      | Not required; approval evidence is ignored. | Optional; absent verifier yields `VERIFICATION_SKIPPED`, not `VERIFIED`. |
| `write`       | Ordinary local state persistence or uncommitted edit work: `reviews.ingest` writes its checkpoint; `releases.upload_bundle`, `releases.configure_release`, `releases.attach_release_notes` modify a managed edit, not the published app.                                                                                                                               | **Not required** by the permission engine.  | **Required**; absence refuses execution in the agent loop.               |
| `destructive` | Operations that can invalidate/discard state or change an existing rollout: `releases.open_edit`, `releases.verify_committed_release`, `releases.update_rollout_fraction`, `releases.halt_rollout`, `releases.resume_rollout`, `releases.cleanup_known_edit`. Opening even a temporary edit may invalidate uncommitted work; exact cleanup can discard it permanently. | **Required**, exact operation binding.      | **Required**.                                                            |
| `publish`     | Applying an edit to the app or creating/replacing a public review reply: `releases.commit_edit`, `reviews.publish_reply`.                                                                                                                                                                                                                                              | **Required**, exact operation binding.      | **Required**.                                                            |

These are declared tool policies, not HTTP-verb classifications or a hierarchy that automatically grants other operations. `releases.validate_edit` uses Google's validation endpoint but is deliberately `read`: it does not commit. `health.check_thresholds` reads Google and appends internal audit evidence; that does not turn it into a Google write/publish action. A `read` operation can still use an LLM or create required internal audit evidence. No permission means a promise of offline execution.

Tool names in the table are **runtime capabilities**, not extra commands accepted by the installed CLI. Review/health commands use explicit, bounded runtime steps. Full live Release tool orchestration is not an installed CLI workflow.

## How a gated action proceeds

1. The agent loop resolves a registered tool and its trusted binding, parses input, and requires a verifier for `write`, `destructive`, or `publish` before execution.
2. The permission engine allows `read`/`write` without a human grant. For `destructive`/`publish`, missing approval returns `APPROVAL_REQUIRED`; malformed or mismatched evidence fails closed.
3. A gated binding creates a **safe human summary** and **request digest** from the exact operation. The approval gate registers a request with `requestId`, tool, permission, `requestDigest`, creation time and expiry, and appends `approval.requested` to the audit ledger.
4. The human resolver returns an approved/denied grant. Before considering its permission record, the agent loop checks **request ID and request digest**; the permission engine then checks the exact tool name, permission and decision. Approval for a different tool/request is not reusable.
5. Allowed execution starts only after required audit writes. Tools re-check their bound state before mutation. Success requires parsed output and post-action verification, followed by safe result serialization and the relevant required audit events. A later audit or verification failure does not undo an earlier Google mutation or justify repeating it.

The audit file is also the approval ledger; structured diagnostics are **not** a replacement ledger. Audit failure prevents a grant from being successfully issued/resolved. Execution is sequential, not a transaction with automatic rollback.

## Exact binding and stale-state protection

- **Review replies:** the SHA-256 request digest binds package, review ID, exact draft and expected user/developer-reply timestamps. The command shows the actual public draft before asking. A fresh review/developer-reply read must still match before the one publish attempt; `REVIEW_CHANGED` / `DEVELOPER_REPLY_CHANGED` stop it and require a fresh draft/approval. Replacing an existing public reply is explicitly warned about.
- **Release commit:** approval binds the exact package/edit/track/version/release/status/fraction/notes state, validation expiry and review policy through request/state digests. Commit re-reads the edit and track, compares the state digest and validates again. Changed state requires new approval. Only `ERROR_IF_IN_REVIEW` is allowed; this is not permission to cancel an existing Google review.
- **Other Release actions:** opening an edit has its own package-bound destructive request; deep verification, rollout advancement, halt, resume and exact-record cleanup each have their **own** trusted intent/digest/summary. A publish approval does not authorize a later destructive verification or a different action. Operator inputs are composition-bound, not wildcard/model-selected targets.

## Daemon human-verifiable approval statements

The privilege-separated daemon wire protocol is **version 5**. Its four signed operations (`open_edit`, `commit`, `verify_committed`, `reconcile_commit`) require **ApprovalStatement V1**. Each challenge carries `approvalStatementVersion: 1` and `approvalStatementCanonical`: the complete deterministic JSON string whose **exact UTF-8 bytes** hash to the lowercase SHA-256 `requestDigest`. Object keys are sorted, there is no JSON whitespace, and the existing release/code/country/locale set ordering is retained. Note text is exact, including non-ASCII, newlines and empty text where the trusted remote commit domain permits it; no text Unicode normalization is introduced. The `attach_notes` request parser's existing restrictions remain unchanged.

Read the **complete canonical statement**, not just the unsigned sibling `summary`. Common fields name the operation, tool, permission and package; `facts` and `consequences` describe the authorized action. Unknown fields/types, unsupported versions, noncanonical JSON, digest mismatch and contradictory challenge/payload metadata are rejected. Summary is convenience only: it is not a second authorization authority and must not influence approval independently of the statement.

- **Open edit:** expects no tracked unexpired local session, opens one edit and tracks its identity. Inserting may invalidate this API user's other active edit and lose uncommitted work; it is not publication.
- **Commit:** exposes every normalized target-track release, its complete version-code set, status/fraction, targeting/priority and **all exact localized note text**, plus the selected release and review policy. Commit applies the **entire validated app edit**, not merely this track or version. Other edit contents are not enumerated here; the operator must trust the managed edit provenance. `ERROR_IF_IN_REVIEW` is retained. Acknowledgement is not remote verification or device/serving propagation proof.
- **Verify committed:** names the package/track/version/release and the journal-recorded expected candidate fingerprint. It authorizes the direct deployed-summary cross-check and at most one temporary-edit read-back, then only that exact temporary edit's identity-guarded, non-retried delete. Insert can invalidate another active edit. Historical exact notes, status and rollout are not retained in this verification intent; a fingerprint does not reveal them. This is a read-back lifecycle approval, not a second publication approval or propagation claim.
- **Reconcile commit:** names the recovery attempt, mode, durable state, observed classification and cleanup flags. The original edit is inspected first and never deleted or committed. Expired verification may insert at most once only without a prior attempted insert; an existing temporary identity is recovered without repeating an attempted delete. Expected-state proof plus confirmed cleanup can establish committed; the exact active original, no attempted commit transport or a known negative outcome can establish not committed. Prior/unrelated observations, missing identity/proof or unconfirmed cleanup remain ambiguous, not evidence that publication did not happen. Cleanup alone is not release verification.

**Identifiers and integrity are not human content.** Request ID and nonce identify one approval; expiry limits its lifetime. These remain bound by the byte-identical `PLAYOPS_OPERATOR_APPROVAL_V1` Ed25519 domain and UTF-8 length-prefixed payload, not duplicated in the statement. `stateDigest` is independently reconstructible from the visible commit target-track candidate. `commitBindingFingerprint` retains the prior exact binding of the private original edit/validation identity and all original commit fields; it is an integrity commitment, not readable edit content. Verification's expected-state/binding fingerprints commit to durable expectations without reconstructing unavailable historical note text. Reconciliation's `candidateFingerprint` covers the full strict journal snapshot (including optional fields and timestamps) without disclosing raw journal records, private edit handles or paths.

No statement is durably added to pending schema **2** or to the commit journal. Prepare derives it from trusted evidence; the fresh signed mutation path rederives trusted state and rejects drift before claim/consumption/remote mutation. Local proof continuation remains a separate recovery path. Old opaque pending digests cannot authorize these new operations, including open-edit; a fresh transparent prepare and signature are required. Completed historical commit evidence can still support recovery, but is not retroactively a transparent approval. Wire-v4 requests fail closed; the signing domain stays V1.

The canonical signed payload bound stays **2048 bytes** and the complete serialized response bound stays **256 KiB**. All four prepare paths preflight the complete JSON envelope (including double escaping, UTF-8, correlation, summary, UUID/nonce and expiry) **before** durable pending creation. The longest canonical ISO expiry reserves six envelope bytes beyond an ordinary 24-byte expiry because expiry appears twice. Oversize/invalid statements are refused with `APPROVAL_CHALLENGE_UNDELIVERABLE`, without truncation or a new pending record.

The pure approval decoder/validator has no file access, key loading or signing. Independent synthetic-key tests reconstruct the canonical JSON hash and every UTF-8 payload field from the serialized challenge alone, including unsigned-note attachment followed by prepare/execute and note-drift refusal. This does **not** supply an operator client, private signer, production deployment, socket/anchor hardening or real-Google mutation acceptance. No installed CLI prepare/execute/signing workflow is added.

## Current interactive CLI behavior

The installed CLI creates an interactive approval resolver only when **both stdin and stdout are TTYs**. Current `reviews reply` uses it; installing an npm tarball does not weaken the gate.

The real prompt shape is:

```text
Approval required
  Tool:       reviews.publish_reply
  Permission: publish
  Action:     <safe summary of the exact displayed public draft>
Proceed? [y/N]
```

This is a template, not an audit record or copied operator session. `y` or `yes` (case-insensitive, surrounding whitespace ignored) approves; any other returned answer denies. The default is **No**. Denial/cancellation stops publishing. If approval is unavailable in a noninteractive run, it fails closed: it may already have fetched, classified and displayed a draft, but it does **not** publish. `reviews reply` returns exit **2** for approval required/denied; execution/config/verification failure returns **1**.

There is no current `--yes`, `--force`, or `--approve` bypass/token path for `reviews reply`, and no installed CLI command issuing approval challenges. Do not script an affirmative response as a substitute for reviewing an exact operation. The configured `agent.approval_timeout_seconds` is parsed but not connected to a timer in the present readline prompt; the docs do not promise automatic prompt expiry.

## Token architecture and limitations

The runtime approval gate can issue a **256-bit opaque challenge token**, shown once to its caller. Only its SHA-256 **`proofDigest`**, never the raw token, is stored. Token validation reconstructs ledger state and requires the exact request ID, tool, permission and request digest. Challenges have a **10-minute TTL**; missing, invalid, expired, already-consumed or different-request tokens are rejected. A valid resolution appends both `approval.approved` and `approval.consumed`.

This is a runtime architecture, **not an advertised CLI token workflow**. Interactive approval is a different source and does not consume a token. The token TTL is not an enforced interactive-prompt timeout.

**Concurrency limit:** token consumption is check-then-append on an append-only file **without cross-process locking**. Two simultaneous processes could both accept the same token. The implementation targets the current single-operator/single-process scope; it does not provide multi-process safety or a distributed approval service. Review checkpoints, managed sessions and cleanup journals likewise do not have distributed locking. Do not run concurrent state-mutating workflows against the same state files.

## Uncertain external state is a stop condition

An approved operation can still fail after Google accepted it. `externalStateUncertain=true` preserves that distinction; the safe error boundary tells the operator **not to retry automatically**. Inspect current Google state, the relevant audit evidence and local session/journal before deciding on a new action. No raw stack/cause is needed to communicate that state.

Read-only API requests have bounded retry where their current wrappers allow it. This is **not** a retry policy for upload, publish, commit, rollout or destructive cleanup. A mutation's failure or a failed verifier must never be treated as permission for blind repetition. Live mutation authorization remains [unverified as documented](credentials.md#connectivity-is-not-mutation-authorization).
