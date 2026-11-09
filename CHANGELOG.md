# Changelog

Operator-visible changes to PlayOps are recorded here. The format follows the
common [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) heading style,
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
under the pre-1.0 policy documented in [docs/release-process.md](docs/release-process.md).

This file describes what operators can rely on today, including known
limitations. It is not a security report; the security review notes live with
the repository maintainers.

## [Unreleased]

### Added

- `playops health check`, a read-only CLI for configured App Health primary-metric thresholds. It prints a six-field summary (human or `--json`), uses exit `0` for no breach, `2` for a detected breach, and `1` for incomplete data, no data, disabled thresholds, invalid arguments, or runtime failure. It does not write audit alerts and does not perform Google mutations. This command is in the current source for the next pre-1.0 preparation; the published `v0.4.3` tarball predates it.

### Changed

- Prepared operator documentation for the next minor release (`v0.5.0`): README, credential/configuration guide, audit-log guide, and operator-client exit-code guidance now distinguish `playops health check` from `health report` and from the separate `health.check_thresholds` runtime capability. Package version, source, tests, and security configuration remain unchanged.
- Recorded the `2026-11-09` controlled live read-only health-check smoke: OAuth, Reporting metadata, and one Reporting query completed; the test app returned `NO_DATA` with exit `1`; no audit alert and no Publisher mutation occurred. This is connectivity/parsing evidence only.

### Known limitations

- The live smoke returned `NO_DATA` from Nagili Driver, a legacy non-production app with Internal Testing history that is no longer actively used. This is a possible explanation for the unavailable metrics, but the exact cause has not been proven. Threshold evaluation against real metric points, breach detection, and metric coverage remain unverified. A data-bearing non-production target is required before claiming those capabilities.
- `NO_DATA` is not a connectivity failure and must not be presented as threshold/breach validation.
- Documentation preparation does not change the package version, create a release, or authorize a PR, tag, publish, deployment, or live Google mutation.

## [0.4.3] - 2026-11-02

### Changed

- Documented the PR-first release procedure (release branch -> pull request -> GitHub Actions verify PASS -> operator merge approval -> merge commit -> master CI PASS -> operator tag authorization -> annotated tag on the master merge commit) and updated the annotated-tag contract accordingly.

## [0.4.2] - 2026-11-02

### Changed

- Release-status documentation correction and version bump to `0.4.2`: updated the prepared version in `package.json` and `package-lock.json` (root and `packages[""]`) from `0.4.1` to `0.4.2` (with all dependencies, lockfile edges, and `"private": true` unchanged) and corrected `CHANGELOG.md`, `README.md`, and `docs/release-process.md` to record that `v0.4.1` is committed (`622986f5c41a481d6e7b98992ce8fea8edd9a100`), annotated-tagged (`v0.4.1`, tag object `6b43504e46268a01e815fe898f6a545a5f2fd7bd` at `2026-10-31T23:36:53Z`), and pushed to GitHub `master` on `2026-10-31` (distinct from the `2026-10-24` historical preparation heading date for `0.4.1`), while `v0.4.1` has no GitHub Release, is not published to the npm registry (`package.json` remains `"private": true`), its local tarball `playops-0.4.1.tgz` (SHA-256 `98a7fcec8ffaeaa3ffdcd40d74297a9b76602c19447411babfd64441e220f401`) has not been officially distributed, the Git tag does not equate to npm publication or deployment, and production deployment, provisioning, daemon rollout, R6A, and live Google mutations remain blocked.

## [0.4.1] - 2026-10-24

Committed (`622986f5c41a481d6e7b98992ce8fea8edd9a100`), annotated-tagged (tag
`v0.4.1`, tag object `6b43504e46268a01e815fe898f6a545a5f2fd7bd`, tag time
`2026-10-31T23:36:53Z`), and pushed to GitHub `master` on `2026-10-31` (the
`2026-10-24` heading date is a historical preparation date, distinct from the
actual `2026-10-31` tag/push date). `v0.4.1` has no GitHub Release, is not
published to the npm registry (`package.json` remains `"private": true`), and
the `v0.4.1` local tarball `playops-0.4.1.tgz` (SHA-256
`98a7fcec8ffaeaa3ffdcd40d74297a9b76602c19447411babfd64441e220f401`) has not
been officially distributed. The Git tag does not constitute npm publication or
deployment: `v0.4.1` is **not** production readiness or Google mutation
authorization, production deployment, provisioning, daemon rollout, R6A, and
live Google mutations remain blocked, and frozen `v0.4.0` remains unchanged. The
earlier 327-file P3 snapshot outcomes — six release gates, five native script
suites, two byte-reproducible ordinary lifecycle packs, separate production-only
consumer install/`playops --help` verification, scoped F1/F2-only Kiro review,
and `2026-10-30` final post-audit source/protected-state/security postcheck
under `P3_WORKFLOW_CLOSED_WITH_DOCUMENTED_EXCEPTIONS` — together with the
initial staged/uncommitted `0.4.1` preparation subsequently committed and pushed
for review as `095fc3f551e37f84ad96ef2296cbf159583f07f5` on `2026-10-30`, are
historical records for their respective earlier snapshots, not verification
proof for modified source. Following focused Codex packaging/preparation review
— not a full-repository audit — `v0.4.1` adds actual on-disk `deploy/` inventory
validation in `scripts/normalize-package-modes.mjs` and regression coverage in
`scripts/normalize-package-modes.test.mjs` and `scripts/clean-dist.test.mjs`;
authoritative gate, rebuilt `playops-0.4.1.tgz` artifact, and review/audit
outcomes for each snapshot are supplied by external snapshot-bound receipts
generated by Hermes.

### Added

- Deterministic producer package-mode normalizer (`scripts/normalize-package-modes.mjs`, E2-A and Codex packaging follow-up). Validates the repository root, ancestor directories, regular-file descriptor identity (`nlink === 1`, no symlinks), package metadata, actual on-disk `deploy/` template inventory (`discoverDeploymentTemplateFiles`), and the complete allowlisted package payload before applying descriptor-bound `fchmodSync` mode changes. Normalizes declared `package.bin` entrypoints (`dist/cli/index.js`, `dist/daemon/main.js`) to exact `0755` and all other allowlisted payload files (`dist/**/*.js` runtime modules, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `config/playops.example.yaml`, `config/playops.production.example.yaml`, the seven shipped `docs/*.md` operator guides, and `deploy/**` templates) to exact `0644`, while permitting verified paired TypeScript compiler byproducts (`.d.ts`, `.js.map`) in `dist/` that remain excluded from the tarball. Historically verified at initial E2-A by 39 unit tests (covering idempotence, byte/umask preservation, allowlisted public `0644` and bin `0755` modes, refusal guards, and paired compiler-byproduct handling) plus one frozen smoke probe with 10 cases, runtime-JS regression, and 3 diagnostics, and expanded in the Codex packaging follow-up with unit refusal/guard coverage for direct and nested `deploy/` extras, missing templates, symlinks, hardlinks, unsafe paths, and special entries (`scripts/normalize-package-modes.test.mjs`) plus ordinary `npm pack` lifecycle regression tests (`scripts/clean-dist.test.mjs`).

### Changed

- Producer `prepack` lifecycle script (E2-B) is now `npm run build && node scripts/normalize-package-modes.mjs`, while `build` remains `node scripts/clean-dist.mjs && tsc -p tsconfig.json`. Synthetic dry-run lifecycle witnesses historically verified `clean -> compile -> normalize` ordering, build/normalizer failure propagation, and the continued absence of `prepare`, `preinstall`, `install`, and `postinstall` hooks (`E2_B_TECHNICALLY_VERIFIED` and fresh protected-state postcheck passed; engineering milestone accepted as `E2_B_ACCEPTED_WITH_DOCUMENTED_EXCEPTION` for a historical 300-second closeout-guard timeout, with prior `RUNNER_BLOCKED` receipts unchanged and no security, source-integrity, or release-gate waiver).
- Deployment-template allowlist and on-disk `deploy/` inventory hardening (P3 exact two-file delta in `scripts/package-content.mjs` and `scripts/package-content.test.mjs`, F1/F2, plus Codex packaging follow-up in `scripts/normalize-package-modes.mjs`, `scripts/normalize-package-modes.test.mjs`, and `scripts/clean-dist.test.mjs`): the shared package-content validator enforces an exact deployment-template allowlist (`deploy/systemd/playops.service` and `deploy/tmpfiles.d/playops.conf`), rejecting any extra or unexpected files under `deploy/` in shared `findPathViolations` (F1) and adding `DEPLOYMENT_TEMPLATE_FILES` to `REQUIRED_PAYLOAD_FILES`/`REQUIRED_FILES` so both templates are required to be present (F2). Addressing focused Codex packaging/preparation review of commit `095fc3f551e37f84ad96ef2296cbf159583f07f5` (not a full-repository audit), `normalizePackageModes` now walks the live `deploy/` directory on disk during `prepack` / ordinary `npm pack` rather than relying only on the static constant list, refusing direct or nested unapproved files, directories, symlinks, hardlinks, or special entries and missing required templates before mutating modes or emitting a `.tgz` archive.
- Synthetic credential fixture test setup (E1) in `tests/daemon-production-composition.test.ts` generates a temporary `service-account.json` inside a `mkdtempSync` root and explicitly normalizes and asserts the required `0640` file mode on that temporary file (distinct from the separately tracked `tests/fixtures/service-account.valid.json` fake fixture used for fresh-clone tests) so daemon production-composition tests remain deterministic under a restrictive umask (`0077`). Production credential authorization, group-separation, and fail-closed secret-file security policy are unchanged.
- Metadata preparation and release-documentation reconciliation (E2-C1 / post-P3 docs sync / Codex follow-up): updated `package.json`, `package-lock.json` (root and `packages[""]`), `scripts/package-acceptance.mjs` release-version assertions, and release documentation (`README.md`, `CHANGELOG.md`, `docs/release-process.md`) to `0.4.1` (originally committed and pushed for review as `095fc3f551e37f84ad96ef2296cbf159583f07f5` on `2026-10-30`, then updated for the packaging follow-up and committed as `622986f5c41a481d6e7b98992ce8fea8edd9a100`, annotated-tagged as `v0.4.1` with tag object `6b43504e46268a01e815fe898f6a545a5f2fd7bd` at `2026-10-31T23:36:53Z`, and pushed to GitHub `master` on `2026-10-31`) with all dependencies, lockfile edges, and `private: true` unchanged.

### Known limitations

- **Tagged source release without GitHub Release, npm publication, or tarball distribution — historical snapshot evidence and external snapshot-bound verification contract:** On the earlier 327-file P3 snapshot (incorporating the exact two-file P3 delta), all six release gates (`lint`, `test:run` with `3271` executed tests in `145` files, `typecheck`, `format:check`, `build`, and `test:package` with `123` checks, zero failures, and `networkCallsObserved` empty), all five native script suites (`13`, `39`, `87`, `15`, and `22` tests on that snapshot), two byte-reproducible ordinary lifecycle `npm pack` runs (`148` entries), separate production-only consumer install and `playops --help`, the scoped F1/F2-only Kiro review, and the `2026-10-30` post-audit source/protected-state/security postcheck completed under historical classification `P3_WORKFLOW_CLOSED_WITH_DOCUMENTED_EXCEPTIONS` (preserving the explicitly accepted historical FAIL/BLOCKED AGY lookup, runner, consumer, and final-continuation process exceptions, not a clean exception-free run or blanket whole-repository Kiro audit), and the initial `0.4.1` preparation was committed and pushed for review as `095fc3f551e37f84ad96ef2296cbf159583f07f5` on `2026-10-30`. Those historical counts, artifacts, audits, and initial staged/uncommitted preparation states apply only to their respective earlier snapshots and are not verification proof for the modified Codex packaging follow-up source (and the Codex feedback is a focused packaging/preparation review, not a full-repository audit). Final release-gate, native-script, rebuilt `playops-0.4.1.tgz` artifact (SHA-256 `98a7fcec8ffaeaa3ffdcd40d74297a9b76602c19447411babfd64441e220f401`), and review/audit outcomes for the `v0.4.1` snapshot are supplied by external snapshot-bound receipts generated by Hermes; `v0.4.1` is committed (`622986f5c41a481d6e7b98992ce8fea8edd9a100`), annotated-tagged (`v0.4.1`, tag object `6b43504e46268a01e815fe898f6a545a5f2fd7bd` at `2026-10-31T23:36:53Z`), and pushed to GitHub `master` on `2026-10-31` (distinct from the `2026-10-24` historical preparation heading date), has no GitHub Release, is not published to the npm registry (`package.json` remains `"private": true`), has not had its local tarball `playops-0.4.1.tgz` officially distributed, does not equate the Git tag with npm publication or deployment, and leaves frozen `v0.4.0` unchanged.
- **Production deployment, provisioning, daemon rollout, and R6A remain blocked:** All `0.4.0` deployment and operational blocks remain in force (independent-administrator handoff, operator privilege removal, credential rotation to a new production credential, administrator-owned `/opt/playops/node24` runtime, `/etc/playops` provisioning, and unverified live Google mutation authorization).

## [0.4.0] - 2026-10-10

### Added

- Human-verifiable approval statements (`ApprovalStatement` V1) for the four signed daemon operations. Each approval challenge carries `approvalStatementVersion: 1` and `approvalStatementCanonical`: the exact deterministic JSON text whose SHA-256 is the signed `requestDigest`. Commit statements list every target-track release and its exact localized release-note text. The daemon wire protocol is version 5, and pending approvals created under the previous opaque-digest scheme are refused instead of executed.
- Operator client for the release daemon (`playops daemon status|open|notes|commit|verify|reconcile`). It pins the production endpoint to `/run/playops/playops.sock`, validates challenges before display/export, reads execute signatures from stdin only, and never automatically retries a mutating request. The signing key never enters the client: approvals are produced by an off-host Ed25519 signer and the client only transports the signature. See [docs/operator-client.md](docs/operator-client.md). Not deployed: the production transport is the `0660` capability-group socket; what remains blocked is deployment and provisioning (users, groups, the root-owned Node 24 runtime, the `/etc/playops` config/credential/anchor and the service unit).
- Production transport/filesystem hardening (source-only). The daemon socket mode is now an exact allow-list `{0600, 0660}` with `0660` as the production capability-group mode, and the bound socket is verified against the daemon's effective uid/gid after bind. The operator trust anchor, the daemon configuration file and the Google credential are read through one fail-closed integrity helper (regular file, not a symlink, trusted owner, no group/other write, trusted parent directory). Secret-file confidentiality and group separation are now enforced: the config and the credential must additionally carry no other read/write/execute, an exact mode of `0640`/`0440`, and a group that equals their trusted secret parent's group and is not the daemon's effective socket capability group (`playops-operator`) — so a `root:playops-operator 0640` misprovisioning fails closed. The operator trust anchor stays a public `root:root 0644` file whose confidentiality is intentionally not required. The repository now owns a systemd unit template and a `tmpfiles.d` template plus a deployment-contract document. This stage installs nothing, provisions no host paths, creates no user or group and starts no service; production deployment is still blocked.
- Production daemon bootstrap (`playopsd`). A production composition and startup validation turn the released core into ONE production process with zero Google calls at startup: every security-sensitive path must be absolute, the operator trust anchor is the pinned `/etc/playops/operator-approval.pub`, exactly one package-operation coordinator is wired, and missing authority (session, journals, pending/claim/write-intent roots) fails closed before the socket is bound. This release also ships a least-secret production configuration example, `config/playops.production.example.yaml` (absolute paths, no `llm` section and no review checkpoint), and adds the exactly-`0700` release-authority directory `/var/lib/playops/release` to the `deploy/tmpfiles.d/playops.conf` provisioning template. The host production prerequisites are documented in [docs/deployment-production.md](docs/deployment-production.md): an independent-administrator handoff, the operator privilege removal, a root-owned Node 24 runtime at `/opt/playops/node24`, and the `/etc/playops` config/credential/anchor. This release installs nothing, provisions no host path, creates no user or group, starts no service and performs no Google mutation.
- Installed version surface: `playops --version` (and `-v`) prints the installed release version and exits 0, mirroring `playopsd --version`. Both read the installed package manifest, never the working directory or the environment, and neither opens a socket nor performs any network call. The flag is advertised in `playops --help`.

### Known limitations

- This is a source/runtime release candidate, **not a deployed production operator path**. No production deployment occurred: no `playops`/`playops-operator` accounts, no `/opt/playops` install, no `/etc/playops` trust material, no installed service unit, and no started daemon.
- Production deployment and R6A remain blocked. Deployment is gated on an independent-administrator handoff and the operator privilege removal; the operator account must not be root-equivalent.
- A **new production credential** is required and the old development credential must not be copied; credential rotation is an administrator prerequisite, and no production secret may be installed before the handoff and privilege removal are complete.
- The production Node 24 runtime must be installed and verified by an **administrator**; PlayOps ships no Node binaries and a user-owned runtime must not be used in production.
- The daemon transport and filesystem hardening have offline/fake-service acceptance only, not live Google mutation validation; existing live-blocked rollout capabilities remain blocked.

## [0.3.0] - 2026-10-09

### Added

- Daemon core protocol and orchestration for status, opening edits, attaching notes, committing, verifying committed releases, and reconciling uncertain commit outcomes. Preparation and execution are separate, with server-owned operation candidates.
- Signed operator approvals for destructive/publish operations, bound to the exact pending request and current operation state. Durable pending records and request claims preserve single-use approval and conservative crash/restart recovery.
- Shared, package-wide execution coordination across edit, notes, commit, verification, and reconciliation operations within one daemon composition.
- Committed-release verification against the exact expected track-state digest, with durable verification evidence that can resume after a crash without blindly repeating the verification lifecycle.
- Local finalization of a verified commit from authoritative persisted evidence, without another Google request. Incomplete or conflicting local state fails closed.
- Signed reconciliation recovery for uncertain and legitimate crash-intermediate commit states. Recovery preserves the existing production reconciliation authority, never retries commit automatically, and keeps unresolved cleanup or consumption uncertainty explicit.

### Changed

- Clean producer builds now remove only the guarded repository-owned `dist` output before compilation, preventing deleted or renamed runtime modules from surviving into an ordinary package.
- Expanded installed-tarball runtime smoke coverage and package reproducibility checks; release preparation documentation derives version/tag identity from the actual manifest.

### Known limitations

- This is the core/runtime release candidate, not a deployed production operator path. No production daemon bootstrap, operator socket client, service launch mechanism, or deployed credential privilege boundary is provided.
- Production deployment and R6A remain blocked. These capabilities have fake-service/offline acceptance, not live Google mutation validation; existing live-blocked rollout capabilities remain blocked.
- Package-wide coordination does not establish a single-daemon deployment or cross-process locking.

## [0.2.0] - 2026-10-05

### Added

- `releases.reconcile_commit`: crash/restart-safe recovery for a commit whose remote outcome is not yet proven. It reads release state back and reports exactly one of CASE 1 (proven committed), CASE 2 (proven not committed) or CASE 3 (still uncertain). It never issues a second commit and never deletes the original edit.
- Durable commit-attempt journal, configured through the optional `release.commit_attempt_journal_path` / `PLAYOPS_RELEASE_COMMIT_ATTEMPT_JOURNAL_PATH`. Existing configuration without it stays loadable; commit and reconcile require it and fail closed without it.
- Production capability maturity gate. Live execution of `releases.update_rollout_fraction`, `releases.halt_rollout` and `releases.resume_rollout` is blocked until each capability is separately hardened. Configuration, environment, model input and approvals cannot override the gate; a blocked tool never reaches the tool registry.

### Changed

- Hardened `releases.commit_edit`:
  - the approved validation expiry must match the validation response exactly, otherwise no commit is attempted;
  - the target track state digest is read and verified again immediately before the commit request;
  - commit intent and outcome are persisted durably before and after commit transport;
  - a commit is never retried automatically.
- `commitAcknowledged` and `liveReleaseVerified` are separate output fields. `commitAcknowledged` reports whether a valid Google commit acknowledgement was durably observed; `liveReleaseVerified` reports whether the committed release was read back and verified. A commit proven committed only by remote verification may legitimately report `commitAcknowledged: false` with `liveReleaseVerified: true`.
- Reconciliation classification is strict: CASE 1 requires proof that the expected state is current, CASE 2 requires proof that the original edit is still active or that commit transport was never attempted, and anything else is CASE 3. State that merely resembles the pre-commit state is reported as CASE 3 with uncertainty, never as a certain CASE 2.

### Known limitations

- If a temporary verification edit insert succeeds remotely but its response identity is lost, PlayOps cannot reconstruct that edit ID and fails conservatively as ambiguous/pending-cleanup instead of guessing.
- Rollout fraction, halt and resume remain live-blocked and are **not** hardened.
- The `releases.commit_edit` hardening has not been exercised against the live Google Play API. It has offline, fake-service acceptance only; live authorization is a separate decision.

## [0.1.1] - 2026-10-05

### Fixed

- Include the fake service-account test fixture in fresh clones so the credential test suite is reproducible.
- Keep real service-account credential files ignored while explicitly allowing only `tests/fixtures/service-account.valid.json`.

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
