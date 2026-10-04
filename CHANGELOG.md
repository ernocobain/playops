# Changelog

Operator-visible changes to PlayOps are recorded here. The format follows the
common [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) heading style,
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
under the pre-1.0 policy documented in [docs/release-process.md](docs/release-process.md).

This file describes what operators can rely on today, including known
limitations. It is not a security report; the security review notes live with
the repository maintainers.

## [Unreleased]

No unreleased changes yet.

## [0.1.0] - 2026-10-04

First prepared release line. PlayOps is distributed only as a **local npm
tarball** produced by `npm pack`. This release is **not** published to the
public npm registry, is not a standalone binary or container, and ships no
installation or updater automation. The package stays `private: true`.

Supported runtime: Node.js 24 LTS (`engines: >=24 <25`), ESM.

### Added

- **Installed CLI.** One supported entry point, `playops`, aliasing the compiled
  `dist/cli/index.js`. `playops --help` is the safe first command: it needs no
  configuration, credentials, or network access. The previous library-style
  `main` field was removed instead of being promoted into a public JavaScript API.
- **`playops doctor`.** Read-only readiness check: configuration → credential
  shape → OAuth token → Android Publisher read → Play Developer Reporting read.
  It performs no Google mutation, and it does contact Google once prerequisites
  pass. Exit 0 / `READY` proves those checks only.
- **Review Agent.** `playops reviews triage` (read new/updated reviews, persist
  local ingestion state, classify) and `playops reviews reply <reviewId>` (fresh
  read, classify, draft, display the **exact** public draft, require an explicit
  interactive approval, publish once, then read back). No auto-publish, and no
  `--yes`, `--force`, or `--approve` shortcut exists.
- **App Health.** `playops health report` produces a dated UTF-8 report from
  explicit current/baseline UTC windows, saves it exclusively (never overwriting
  an existing file), and writes exactly the saved bytes to stdout. Crash-rate,
  ANR-rate, and excessive-wakeup metrics are supported.
- **Release Agent runtime capabilities** for an **existing** prebuilt `.aab`
  (artifacts are accepted, never compiled): managed edit session, bundle upload
  with SHA-256 verification, versionCode safety gate against the selected track,
  target-track inspection, release configuration, localized release-note
  attachment, edit validation, approval-gated commit, independent two-layer
  post-commit read-back, staged-rollout advancement, halt/resume, a side-effect-free
  dry-run planner, and known-edit hygiene/cleanup.
- **Runtime core.** Tool registry, four permission levels
  (`read` / `write` / `destructive` / `publish`), approval gates with
  single-use, time-limited, operation-bound tokens, mandatory post-action
  verification for mutations, and a provider-neutral LLM adapter with a
  9Router (OpenAI-compatible) provider.
- **Operator documentation** shipped inside the package: credential and
  configuration setup, permissions and approvals, audit log and diagnostics,
  release pipeline walkthrough, and this repository's release process
  ([docs/release-process.md](docs/release-process.md)).

### Changed

- **Packaging is CLI-only and payload is explicit.** The tarball contains
  compiled runtime JavaScript, the operator-safe example configuration, the
  operator guides, `README.md`, `CHANGELOG.md`, and `LICENSE`. It excludes
  operator configuration, credentials, state, reports, tests, sources, and
  internal planning documents.
- **Prepared version identity.** `package.json`, `package-lock.json`, and this
  changelog now agree on `0.1.0`, the first installable operational release line.
  Before this release the package was intentionally left at `0.0.0` while
  packaging was still being established.

### Security

- **Owner-only state files.** The audit log, review checkpoint, release edit
  session, and cleanup journal are created with mode `0600`, and parent
  directories PlayOps itself creates are created `0700`. Existing operator files
  and directories keep their mode and are never re-permissioned. The audit log
  doubles as the approval/verification ledger, so this also protects the
  integrity of that evidence.
- **Bounded temporary-edit cleanup.** A temporary Google Play edit created solely
  for release verification is deleted at most **once per identity per workflow**
  across the exact-verification, rollout, and halt/resume paths, including
  journal-write recovery. A cleanup failure keeps the written journal record
  (the identity stays discoverable) and reports an uncertain external state
  instead of retrying the delete.
- **Safe error presentation.** A single PlayOps-owned taxonomy boundary renders
  operator-facing failures with a stable category, code, deterministic message,
  and optional guidance — never a stack trace, raw `Error`, cause chain, or raw
  remote response. `externalStateUncertain` is preserved exactly and replaces any
  guidance with an explicit do-not-retry instruction.
- **Secrets discipline.** Service-account JSON and private keys, OAuth access
  tokens, the 9Router API key, authorization headers, and approval tokens are not
  logged, audited, serialized into tool output, or included in operator-visible
  errors. Approval tokens persist only as a SHA-256 digest in the capability
  ledger.
- **Least privilege.** Exactly two Google OAuth scopes are requested, one per
  API surface actually used, and are never extended implicitly. App-level access
  should be limited to the operated app(s) and the capabilities actually used.
- **Dependency posture.** The recorded dependency set audits clean (no known
  vulnerabilities) and contains no production install hooks or native addons.
  Nothing was upgraded merely because a newer version exists.

### Known limitations

- **Live Google mutation authorization remains unverified.** No live bundle
  upload, track update, commit, rollout/halt/resume, or review reply has been
  exercised. Earlier connectivity and read checks prove reads only and say
  nothing about mutation permission.
- **No end-to-end live release CLI command.** The installed `releases --dry-run`
  path has no trusted composition-bound operation factory and refuses safely
  with exit 1. The release runtime capabilities are operator/composition-bound.
  A dry-run plan is never authorization or publication proof.
- **Browser fallback is a skeleton.** There is no browser implementation,
  provider, credential/session model, or agent-loop integration, and no
  documented Google Play API gap that would justify one.
- **Single-process coordination.** State files, approval-token consumption, and
  report publication assume a single operator process; there is no cross-process
  locking. Google `GET → UPDATE → GET` sequences are not atomic, and the
  `edits.insert` response window is irreducible because the API exposes no way to
  list a user's active edits.
- **Alerts are not notifications.** Threshold breaches append durable audit
  events for a `read`-level runtime capability. `health report` never triggers
  them, and no scheduler, email, chat, or push delivery exists.
- **Redaction is key-based.** Known key families are redacted in audit and
  diagnostics; arbitrary free-form strings are not universally scanned, so
  credentials, headers, and SDK bodies must never be passed to log messages.
- **Distribution.** There is no public registry publication, standalone binary,
  container, installer, updater, code signing, or automated release workflow, and
  no compatibility promise beyond the pre-1.0 policy.
