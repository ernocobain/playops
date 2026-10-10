# Operator client (`playops daemon`)

This guide documents the operator-facing client for the local PlayOps release
daemon. It is **not production-ready**: the transport is a plain `0600` Unix
socket, deployment and privilege separation are still blocked, and the operator
path has only offline/fake-service acceptance. Treat it as the framing and UX
layer over a frozen protocol, not as a deployed operator tool.

## Command hierarchy

```
playops daemon status
playops daemon open prepare|execute
playops daemon notes attach
playops daemon commit prepare|execute
playops daemon verify prepare|execute
playops daemon reconcile prepare|execute
```

There is no generic raw command (there is no `daemon send '<json>'`) and no
arbitrary protocol surface: the client can only name one of the frozen
protocol-v5 operations.

## Pinned production endpoint

The production endpoint is a source-level constant,
`/run/playops/playops.sock`. There is deliberately **no** `--socket` flag, **no**
`PLAYOPS_DAEMON_SOCKET_PATH` / `PLAYOPS_SOCKET` environment variable, no
configuration file and no working-directory discovery that can redirect it.
Tests inject a socket path through the module API only. The client reads no
credential, state root, audit path, journal, pending store or `/etc/playops`
anchor.

## Protocol version

The wire protocol is version 5. Requests are one length-prefixed frame per
connection (a 4-byte big-endian length followed by JSON, then a half-close),
and the daemon answers with raw JSON read to end-of-connection. The client
fails closed on an unrecognized response outcome rather than inferring success
or failure from it.

## Off-host signer workflow

Approvals are single-use and bound to the exact request:

1. **Prepare** (for example `playops daemon open prepare --out challenge.json`).
   The daemon creates a pending request and returns an `approval_required`
   challenge. A `prepare` that returns a valid challenge is a success (exit 0).
2. **Export** the challenge. The export is
   `{"clientExportVersion":1,"daemonProtocolVersion":5,"challenge":…,"operator":…}`.
   The `challenge` is the verbatim daemon challenge; the `operator` echo is
   non-authoritative.
3. **Sign off-host.** The signer independently revalidates the challenge,
   renders the semantic facts itself, and signs the exact `canonicalPayload`
   bytes with Ed25519. The private key never enters this client.
4. **Execute** with the signature on stdin:
   `playops daemon open execute --request-id <uuid> --signature-stdin`.
   The signature field is read from standard input only, to EOF; there is no
   `--signature <value>` argument and no environment variable. For example:
   `playops daemon open execute --request-id <uuid> --signature-stdin < signature.txt`.
   Keep the returned signature file private (mode `0600`), avoid putting a live
   signature in argv, shell variables/history or environment, and delete it after
   consumption/expiry. Input is one unpadded base64url token decoding to 64 bytes;
   the client never verifies cryptographic authorization or loads a signing key.

The client's own display is **convenience only**: the off-host signer's
independent rendering of the exported challenge is the authoritative
human-readable approval. Confirm the semantic facts on the signer side before
signing.

### requestDigest verification

The only semantic authority is the canonical `ApprovalStatement`, not any
sibling `summary`. The signed `requestDigest` is the SHA-256 of
`approvalStatementCanonical`; execution revalidates the statement, the digest
and the payload-to-metadata binding before anything is consumed.

### `--challenge <file>` caveats

`--challenge <path>` revalidates the exact challenge and refuses on a mismatch
with `--request-id` **before connecting**. It only re-establishes internal
consistency: there is no daemon signature over the challenge, so the file does
**not** authenticate the daemon's origin. A challenge file is an opaque,
one-time approval reference; integrity is re-established by revalidation, never
by trusting the file. Files are created exclusively at mode `0600`, refuse to
overwrite an existing file and refuse a symbolic-link target. Reads open a
no-follow regular-file descriptor and enforce the actual-byte limit, rather
than checking a path and reopening it. The export-file bound accommodates a
full protocol response plus wrapper overhead. Canonical strings are never
truncated; an incompatible export version is refused.

Challenges contain no private key and cannot authorize an operation by themselves.
They do contain request identity, nonce, expiry and unpublished release content;
treat them as moderately private operational data and delete them after use.
If terminal controls or output size make human rendering unsafe, no partial
signable statement is shown: prefer preparing with `--out` and inspect the exact
export on the off-host signer. Do not automatically prepare again merely to
change output format: another prepare may create another pending request.

## Exit codes

- **0** — the command did what it was asked, including `prepare` returning a
  valid `approval_required` challenge and exporting it.
- **1** — a definite failure: usage, connect-before-dispatch, protocol error,
  `approval_mismatch`, `approval_expired`, `request_not_found`,
  `request_already_consumed`, `request_claim_held`, `operation_in_progress`,
  `operation_unavailable`, `capability_blocked`, `config_invalid`,
  `remote_failure`, `local_state_failure`.
- **2** — the client cannot determine the mutation outcome and operator recovery
  is required: `external_state_ambiguous`, `cleanup_pending`, a lost or
  malformed response after a possible dispatch, or an operator interrupt after a
  possible dispatch.

This meaning of **2** is intentionally different from the legacy `playops
reviews`/`health` convention, where exit 2 means "declined / approval
required". The exact daemon outcome is always carried verbatim in human text
and in `--json`.

## Retry rules and disconnect uncertainty

Mutating executes (`execute_open_edit`, `attach_notes`, `execute_commit`,
`execute_verify_committed`, `execute_reconcile_commit`) are **never**
automatically retried. A failure before any byte could be written is a
connect failure with provably zero mutation; a failure after the write started
is reported as an unknown outcome (exit 2). The client imposes no short response
timeout on a mutating execute, so it waits for the daemon rather than
manufacturing false ambiguity. If a response is lost after a possible dispatch,
use `daemon status` only as an aggregate observation and inspect authoritative
recovery evidence through the appropriate operator workflow — do not replay.
The client never opens the journal or daemon state itself, and status cannot
resolve a particular request.

Every `prepare_*` can change durable local state. A lost or malformed prepare
response is also exit 2: **prepare outcome unknown; another prepare may create
another pending request**. No second prepare is issued automatically. An
unrecognized outcome, invalid field type, over-size response, or invalid UTF-8
fails closed; after possible dispatch the client preserves uncertainty.

Ctrl-C (`SIGINT`) and the module API's abort signal stop only client waiting.
After possible dispatch they produce **OUTCOME UNKNOWN FROM CLIENT PERSPECTIVE**
and exit 2. Disconnect does not cancel daemon work. A request interrupted before
connection/write is a definite local failure (exit 1). `status` may be retried
safely because it is read-only, but this implementation has no hidden retry loop.

## `notes attach` is an unsigned remote mutation

`playops daemon notes attach` performs a **real remote Google Play release-notes
update**. It does **not** publish or commit and it does **not** require a human
approval signature, so socket membership itself is a remote-mutation authority.
Response loss creates uncertainty and the request is never automatically
retried. The command requires `--yes` before it connects (including interactive use in
the production CLI). This is only a local UX confirmation, not authorization:
automation controlling the operator account can bypass it or speak the socket
protocol directly. It does not add a signature requirement or daemon permission.

## Status limitations

`playops daemon status` is read-only and aggregate-only. The summary carries
protocol/package versions, the served-operation list, tri-state local flags and
pending-state counts. These counts **cannot resolve a specific requestId**, and
status is **not** recovery: never infer a specific success or failure from it
alone.

## Transport limitation and deployment status

The daemon socket is a plain `0600` Unix socket owned by the daemon's Unix
account. There is no peer-credential check and no group `0660` transport, so a
distinct operator user cannot currently connect; the client cannot guarantee
display correctness against an attacker in the same Unix account. Deployment,
systemd integration, privilege separation and R6A remain blocked. Acceptance
runs a stub/fixture daemon rather than a production composition, because a
production `playopsd` cannot be started offline (it needs a credential and the
`/etc/playops` anchor).

## Trusted artifact and launcher boundary

Production must use a root/admin-owned installed client and trusted Node runtime,
not a user-writable checkout, user-global npm/NVM install, cwd executable or
user-controlled wrapper. Deployment must prevent PATH hijacking, `NODE_OPTIONS`,
`NODE_PATH` and custom-loader injection **before Node starts**; application socket
pinning is not a substitute for that launcher boundary. No launcher, host group,
`0660` socket, service unit or deployment is created by this client stage.

The actual `playops daemon` entrypoint does not import legacy config/Google/
credential composition. Testing uses a module-only endpoint injection seam; no
production argv/config/`PLAYOPS_*` value can select an endpoint. Installed-package
checks keep an external-network blocker active while permitting only an isolated
AF_UNIX test subtree, and include real subprocess stdin and SIGINT tests. They
are offline acceptance, not a production healthy-start or R6A claim.

## Related guides

- [Permission and approval model](permissions-and-approvals.md)
- [Credential handling](credentials.md)
- [Audit log](audit-log.md)
- [Release pipeline](release-pipeline.md)
