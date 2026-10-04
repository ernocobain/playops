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
