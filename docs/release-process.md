# Release process

This document is the maintainer workflow for a PlayOps release. It is a process
description, not an automated release platform: every step below is performed by
a human maintainer on an explicit decision. No release automation, publishing
job, or version bot exists in this repository.

PlayOps ships as a **local npm tarball** produced by `npm pack`. Publication to
the public npm registry (`npm publish`), pushing to a remote, and creating GitHub
releases are all outside this process and require separate explicit
authorization.

## 1. Versioning model

- PlayOps uses **Semantic Versioning**: `MAJOR.MINOR.PATCH`.
- `CURRENT_VERSION` is the version actually recorded in `package.json`, not a
  hardcoded value in this procedure. Read it from the repository:

  ```sh
  CURRENT_VERSION="$(node -p "require('./package.json').version")"
  ```

- `NEXT_VERSION` is a proposed `MAJOR.MINOR.PATCH` selected by the operator for
  a future release. Selecting it does not change the repository, create a tag,
  or authorize a release. Version preparation requires separate authorization.
- `VERSION` below is re-read from the prepared manifest after that authorized
  preparation; the corresponding annotated Git tag is `v${VERSION}`.
- PlayOps stays **pre-1.0** for now. A prepared release is **not** a claim of production certification,
  stable 1.0 API compatibility, or verified live Google mutation authorization.

### Pre-1.0 change policy

Before `1.0`, while the version is `0.x.y`:

- **PATCH** (`0.1.1`) — bug fixes, security fixes, documentation corrections,
  and narrowly compatible internal improvements.
- **MINOR** (`0.2.0`) — new operator-visible capabilities, new CLI
  functionality, and meaningful behavior additions. Under `0.x` a minor release
  may still change behavior that operators depend on; each such change is
  recorded in `CHANGELOG.md`.
- **MAJOR** (`1.0.0`) — requires an explicit maintainer decision. Completing a
  roadmap phase, including Phase 6, is **not** by itself a reason to declare
  `1.0`.

After `1.0`, normal Semantic Versioning compatibility rules apply: `MAJOR` for
breaking changes, `MINOR` for backward-compatible additions, `PATCH` for
backward-compatible fixes.

A confirmed security fix may justify an immediate patch release ahead of other
planned work. Do not promise stronger compatibility guarantees than PlayOps
actually implements: the pre-1.0 line has known functional gaps and unverified
live mutation paths (see `CHANGELOG.md` → Known limitations).

## 2. Version identity: one prepared version

A release has **one** version, and everything that names it must agree:

| Artifact                  | Must contain                                                    |
| ------------------------- | --------------------------------------------------------------- |
| `package.json`            | `"version": "<version>"`                                        |
| `package-lock.json`       | the same version (root and `packages[""]`)                      |
| `CHANGELOG.md`            | a `## [<version>] - <date>` entry with an ISO `YYYY-MM-DD` date |
| Git tag (at release time) | `v<version>`                                                    |

A release is **not** considered tagged if only `package.json` changed. The
version bump, the lockfile update, the changelog entry, and the release
documentation belong to the same commit that the annotated tag points at. The
current prepared version in `package.json`, `package-lock.json` (root and
`packages[""]`), and `CHANGELOG.md` is `0.4.3` (`v0.4.3` includes the PR-first
release procedure documentation).

Verify consistency before tagging:

```sh
node --test scripts/release-version.test.mjs
```

That native check reads `package.json`, `package-lock.json`, and `CHANGELOG.md`
and fails if the three disagree, if the changelog has no `## [Unreleased]`
section, if a release date is not `YYYY-MM-DD`, or if the changelog contains a
machine-specific path or credential material. The same invariants are asserted
in the normal test suite.

## 3. Release order

The intended PR-first release order is fixed:

```text
prepare version + changelog (on a release branch)
  → verification
  → commit (release branch)
  → push branch + open pull request
  → GitHub Actions `verify` PASS
  → operator merge approval
  → merge commit to master
  → master CI PASS
  → operator tag authorization
  → annotated tag on the master merge commit
  → (optional) GitHub Release (separate authorization)
```

`CHANGELOG.md` must be finalized **before** verification, because the prepared
release branch commit, the `master` merge commit, the published local tarball
artifact, and the annotated tag on the `master` merge commit all require the
consistent version, lockfile, changelog, and release documentation snapshot.

## 4. Maintainer release checklist

1. Start from a clean `main`/`master` branch (`git status --short` must be
   empty) and confirm no release work is half-applied.
2. Fetch/pull and confirm the **intended release commit**: record
   `git rev-parse HEAD` before preparing anything.
3. Ensure Node **24** is the active runtime for every command below
   (`node --version` → `v24.x`).
4. `NODE_ENV=development npm ci` — install exactly the locked dependencies.
5. Run all five gates: `NODE_ENV=development npm run build`,
   `npm run test:run`, `npm run lint`, `npm run typecheck`, and
   `npm run format:check`.
6. Run the producer clean-build, mode-normalization, package, and documentation checks:
   `node --test scripts/clean-dist.test.mjs`,
   `node --test scripts/normalize-package-modes.test.mjs`,
   `node --test scripts/package-content.test.mjs`,
   `node --test scripts/documentation-checks.test.mjs`, and
   `node --test scripts/release-version.test.mjs`.
7. Run `npm run test:package` (real isolated tarball → production-only consumer
   install → installed `playops` bin and installed-module checks).
8. Verify version consistency for the prepared release (section 2).
9. Verify the `CHANGELOG.md` entry for the prepared version exists, is accurate
   for what ships, and lists the known limitations that still apply.
10. Produce the tarball:
    `NODE_ENV=development npm pack --pack-destination ./artifacts`.
11. Record the artifact SHA-256:
    `sha256sum artifacts/playops-<version>.tgz` — write the **observed** value
    into the release notes or evidence record. Do not copy a hash from an older
    release, and do not hardcode a hash into this document.
12. Install that tarball into a clean, production-only consumer:
    `npm init -y` in an empty directory, then
    `npm install --omit=dev /absolute/path/to/playops-<version>.tgz`.
13. Run the installed CLI smoke from an unrelated working directory:
    `playops --help` (safe, offline, no configuration or credentials needed).
14. Review `git status` and `git diff` one final time; confirm the change set is
    exactly the prepared release (version, changelog, release documentation, and
    any intended source changes) and contains no credentials, state files, or
    scratch artifacts.
15. Commit the prepared release on a release branch (never directly on `master`)
    with a conventional commit message.
16. Push the release branch to the remote and open a pull request to `master`
    when authorized.
17. Let the GitHub Actions `CI` workflow (`verify` job) run on the pull request
    and confirm `verify` reaches `PASS`.
18. After `verify` `PASS` and explicit operator merge approval, merge the pull
    request into `master` with a **merge commit**.
19. Verify that the post-merge GitHub Actions `CI` run (`verify` job) on `master`
    reaches `PASS`, and check out the exact `master` merge commit locally.
20. After separate explicit operator tag authorization, create the **annotated**
    tag `v${VERSION}` on the exact `master` merge commit and verify the tag
    points at that `master` merge commit (section 5). Push the tag only when
    explicitly authorized.
21. Distribute the approved artifact to its intended consumers, together with the
    recorded SHA-256 (and, only if separately authorized by the operator, create
    an optional GitHub Release).

Do not automate publication: no script in this repository publishes, pushes, or
tags on its own.

### Clean-build and package-content contract

`npm run build` (`node scripts/clean-dist.mjs && tsc -p tsconfig.json`) removes
only this repository's generated `dist` directory through `scripts/clean-dist.mjs`,
then regenerates it from the current `src` tree using the installed TypeScript
compiler. The cleaner resolves the repository from its own script location, not
the caller's working directory. It validates the PlayOps package and the exact
`dist` compiler output, refuses filesystem-root boundaries, links or ordinary
files at the output path, and accepts no configurable deletion target. A missing
`dist` is a no-op.

The `prepack` hook (`npm run build && node scripts/normalize-package-modes.mjs`)
runs that clean build and then normalizes package payload file modes before
ordinary `npm pack`, so deleted or renamed modules cannot survive as stale
compiled package entries and restrictive caller `umask` values (such as `0077`)
do not leak into packed file permissions. `scripts/normalize-package-modes.mjs`
validates the repository root, ancestor directories, regular-file descriptor
identity (`nlink === 1`, no symlinks), package metadata, the actual on-disk
`deploy/` directory inventory (`discoverDeploymentTemplateFiles`, rejecting any
unapproved direct or nested files, directories, symlinks, hardlinks, or special
entries and requiring both `deploy/systemd/playops.service` and
`deploy/tmpfiles.d/playops.conf`), and the allowlisted payload (while
permitting verified paired `.d.ts` and `.js.map` compiler byproducts in `dist/`
that do not ship), then sets declared `package.bin` entrypoints
(`dist/cli/index.js`, `dist/daemon/main.js`) to exact mode `0755` and all other
shipped payload files (compiled `dist/**/*.js`, root payload files, operator
guides, and `deploy/**` templates) to exact mode `0644`. The manifest keeps the
no-`prepare`/no-`preinstall`/no-`install`/no-`postinstall` contract. Do not
disable lifecycle scripts for release packaging. A pack with `--ignore-scripts`
is only a diagnostic of already-built output, not the release build procedure.

Compare normalized relative package entry lists, normalized file modes (`0755`
for declared `bin` entrypoints and `0644` for all other shipped files), and
per-entry content hashes across repeat clean builds and the isolated
`test:package` artifact. Counts alone do not prove equal payloads. When a
release gate requires byte-for-byte `.tgz` reproducibility across independent
clean builds, the raw `.tgz` SHA-256 hashes must also match byte-for-byte;
archive-metadata or file-mode differences do **not** waive an explicitly
required byte-reproducibility check. Record each observed archive hash
separately rather than substituting a hash from another build.

For PlayOps `v0.4.2` (`0.4.2` release-status documentation and
version-consistency update) and the tagged `v0.4.1` release:

- Historical preparation milestones include E1 synthetic credential fixture mode
  normalization (`0640` under restrictive umask), initial E2-A normalizer
  implementation (historically verified at E2-A by 39 unit tests plus one frozen
  smoke probe with 10 cases, runtime-JS regression, and 3 diagnostics), E2-B
  `prepack` wiring with synthetic dry-run lifecycle witnesses
  (`clean -> compile -> normalize`, failure propagation, and no install hooks;
  `E2_B_TECHNICALLY_VERIFIED` and accepted as
  `E2_B_ACCEPTED_WITH_DOCUMENTED_EXCEPTION` with prior `RUNNER_BLOCKED` receipts
  unchanged), the P3 exact two-file delta in `scripts/package-content.mjs` and
  `scripts/package-content.test.mjs` enforcing the shared deployment-template
  allowlist (F1/F2), and the initial `0.4.1` metadata/documentation preparation
  committed and pushed for review as `095fc3f551e37f84ad96ef2296cbf159583f07f5`
  on `2026-10-30` (after its initial staged/uncommitted preparation state).
- Following focused Codex packaging/preparation review of commit
  `095fc3f551e37f84ad96ef2296cbf159583f07f5` (which is a scoped
  packaging/preparation review, not a full-repository audit), `v0.4.1` added
  live on-disk `deploy/` inventory discovery and validation in
  `scripts/normalize-package-modes.mjs` (`discoverDeploymentTemplateFiles`)
  together with unit refusal/guard coverage in
  `scripts/normalize-package-modes.test.mjs` and ordinary `npm pack` lifecycle
  regression tests in `scripts/clean-dist.test.mjs` (verifying real tarball
  creation for valid `deploy/` inventory and refusal with no `.tgz` output for
  direct or nested unapproved `deploy/` files).
- Earlier verification counts, artifacts, and audit classifications — specifically
  the 327-file P3 snapshot outcomes (`lint`, `test:run` with `3271` executed
  tests in `145` files, `typecheck`, `format:check`, `build`, `test:package`
  with `123` checks, zero failures, and `networkCallsObserved` empty; the five
  native script suites at `13`, `39`, `87`, `15`, and `22` tests on that
  snapshot; two byte-reproducible `148`-entry ordinary lifecycle `npm pack`
  runs; separate production-only consumer install and `playops --help` smoke;
  scoped F1/F2-only Kiro review; and the `2026-10-30` postcheck closed under
  `P3_WORKFLOW_CLOSED_WITH_DOCUMENTED_EXCEPTIONS`, preserving the explicitly
  accepted historical FAIL/BLOCKED AGY lookup, runner, consumer, and
  final-continuation process exceptions rather than a clean exception-free run
  or blanket whole-repository Kiro audit) — are historical records for their
  respective earlier snapshots and do not serve as verification proof for
  modified source.
- Final release-gate, native-script, rebuilt `playops-0.4.2.tgz` artifact-hash,
  consumer-smoke, and review/audit outcomes for `v0.4.2` (`0.4.2`, and any
  subsequent snapshot) are supplied by external snapshot-bound receipts
  generated by Hermes for that exact snapshot rather than self-certifying or
  perpetually pending claims in tracked repository files. `v0.4.1` is committed
  (`622986f5c41a481d6e7b98992ce8fea8edd9a100`), annotated-tagged (tag `v0.4.1`,
  tag object `6b43504e46268a01e815fe898f6a545a5f2fd7bd`, tag time
  `2026-10-31T23:36:53Z`), and pushed to GitHub `master` on `2026-10-31`
  (distinct from the `2026-10-24` historical preparation heading date in
  `CHANGELOG.md`), while a GitHub Release, npm registry publication
  (`package.json` remains `"private": true`), official distribution of the
  `v0.4.1` local tarball (SHA-256
  `98a7fcec8ffaeaa3ffdcd40d74297a9b76602c19447411babfd64441e220f401`), and
  production deployment, provisioning, daemon rollout, R6A, and live Google
  mutations remain not performed / blocked (the Git tag is distinct from npm
  publication and deployment). PlayOps `v0.4.2` includes this release-status
  documentation correction and version-consistency update to `0.4.2`, and
  frozen `v0.4.0` policy and tag remain unchanged.

## 5. Tag contract and tag safety

Releases use **annotated** tags created on the exact `master` **merge commit**
(the commit on `master` whose tree contains the consistent `package.json`
version, `package-lock.json`, `CHANGELOG.md`, and release documentation
snapshot), only **after** the pull request has been merged to `master`, the
`master` CI run (`verify` job) has passed, and the operator has given explicit
tag authorization:

```sh
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${VERSION}" -m "PlayOps v${VERSION}"
```

`package.json` version `${VERSION}` corresponds to Git tag `v${VERSION}`. A version bump
without that tag is not a release, and a tag without the matching manifest,
lockfile, and changelog entry is not a release either.

Tag safety rules:

- **Do not tag the release branch commit by default:** the annotated tag goes on
  the exact `master` merge commit after `master` CI passes and after explicit
  operator tag authorization, not on the release branch commit.
- **Never tag automatically:** no script, bot, or GitHub Actions workflow may
  create or push a tag automatically.
- **Never `git tag -f`:** never force-create or move a release tag.
- **Never push a tag without authorization:** pushing `v${VERSION}` to the remote
  requires separate explicit operator tag authorization.

Before tagging, check out the verified `master` merge commit, verify all three
of the following, and require a clean tree:

```sh
git status --short
git rev-parse HEAD
git tag --list "v${VERSION}"
```

- `git status --short` must print nothing.
- `git rev-parse HEAD` must be the intended `master` merge commit (whose tree
  contains the consistent version, lockfile, changelog, and release
  documentation snapshot, after `master` CI has passed).
- `git tag --list "v${VERSION}"` must print nothing. If the tag already exists, **stop
  and review**: an existing release tag is never silently moved or overwritten.

Never use `git tag -f` for a normal release. If a tag was created in error and
has not been distributed, delete it deliberately and re-tag the correct commit;
if it has been distributed, publish a new version instead.

After tagging, confirm the tag resolves to the intended `master` merge commit:

```sh
git rev-parse "v${VERSION}^{commit}"
git show --stat "v${VERSION}"
```

## 6. Release artifact

- The Phase 6 release artifact is the npm tarball, conceptually
  `playops-${VERSION}.tgz`. Its precise name follows the package version.
- The tarball payload is governed by the `files` allowlist in `package.json`:
  compiled runtime JavaScript, the operator-safe example configuration,
  `README.md`, `CHANGELOG.md`, `LICENSE`, and the operator guides under `docs/`.
  Repository-internal documents, sources, tests, development scripts, operator
  configuration, credentials, state, and reports never ship.
- `CHANGELOG.md` ships intentionally: it is release-consumer-relevant. Any
  document linked from the installed `README.md` must also ship, or the link
  must be removed — the documentation checks enforce this.
- `private: true` stays in place for this release line. No registry credentials
  are added to the repository, and no `publishConfig` is added for hypothetical
  future publishing.

## 7. Explicitly out of scope

A verify-only GitHub Actions CI workflow (`.github/workflows/ci.yml`, workflow
name `CI`, single job `verify`) now exists in the repository to verify `push`
and `pull_request` events targeting `master` (see "PR-first release workflow and
GitHub CI integration" below), but automated release, publish, tag, or deploy
workflows remain out of scope. The following are **not** part of this release
process and must not be added without a separate, explicit decision:

- Automated GitHub Actions release, publish, tag, or deploy workflows (any
  workflow beyond verify-only CI).
- An automation release job, auto-version bot, `semantic-release`, `changesets`,
  or `release-please`.
- Code signing, provenance attestation, or an update checker.
- Public registry publication (`npm publish`), GitHub releases automation,
  binaries, containers, and installers.
- Removing `private: true`.

## 8. PR-first release workflow and GitHub CI integration

### Verify-only CI triggers and the `verify` check

The repository defines a verify-only GitHub Actions workflow at
`.github/workflows/ci.yml` with workflow name `CI` and a single job named
`verify` (`runs-on: ubuntu-latest`, `permissions: contents: read`,
`timeout-minutes: 30`). It triggers on:

- `pull_request` targeting branch `master`.
- `push` to branch `master`.

On Node.js 24, the `verify` job runs:

1. `npm ci`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run format:check`
5. `npm run build`
6. `npm run test:run` (Vitest unit and integration suite)
7. `npm run test:package` (isolated package acceptance)
8. Five native `node --test` suites: `scripts/clean-dist.test.mjs`,
   `scripts/normalize-package-modes.test.mjs`,
   `scripts/package-content.test.mjs`, `scripts/documentation-checks.test.mjs`,
   and `scripts/release-version.test.mjs`
9. `npm audit --omit=dev` (production dependency audit; the `minimatch` advisory
   `GHSA-g3hv-75wg-m249` remains an accepted temporary risk affecting dev lint
   tooling only)
10. A two-`npm pack` reproducibility check confirming both packed tarballs yield
    identical non-empty SHA-256 digests

The `CI` workflow is strictly **verify-only**: it does **not** publish packages,
create or push Git tags, push commits, create GitHub Releases, or deploy.

### Required status check posture and emergency admin bypass rule

- The intended required status check name is `verify` (the job in workflow `CI`,
  provider GitHub Actions).
- `verify` is **not yet enabled** as an enforced required status check in GitHub
  branch protection (branch protection on `master` currently enforces only
  force-push disabled and branch deletion disabled).
- Because branch protection does not yet enforce `verify` automatically, the
  maintainer must manually confirm that the GitHub Actions `verify` check has
  completed with `PASS` on the pull request before merging and on `master` after
  merging.
- Administrator bypass of a failing or unverified check is an **emergency-only
  documented path** requiring an explicit operator decision and recorded
  justification; it is never a normal release procedure.

### Operator approval boundaries

Each external or irreversible release action has a separate operator boundary:

- **Merge approval:** Opening a release pull request does not authorize merging.
  Merging the release branch into `master` (using a merge commit) requires both
  GitHub Actions `verify` `PASS` on the pull request and explicit operator merge
  approval.
- **Tag authorization:** Merging to `master` does not authorize tagging.
  Creating and pushing the annotated tag `v${VERSION}` requires both the
  post-merge `master` CI `verify` `PASS` and separate explicit operator tag
  authorization. The annotated tag is placed on the exact `master` merge commit,
  not on the release branch commit.
- **GitHub Release authorization:** Creating a GitHub Release is optional and
  requires separate explicit operator authorization distinct from merge approval
  and tag authorization.
- **Public npm registry publication out of scope:** `npm publish` remains out of
  scope (`"private": true` remains in `package.json`).

### Recovery when GitHub Actions billing or runner execution fails

If a GitHub Actions `verify` run fails to start or aborts because of a GitHub
Actions billing, quota, or runner availability failure:

- **Do not retry automatically**, do not loop-poll or spam re-pushes, and do not
  treat a billing or runner block as `verify` `PASS`.
- Stop the release progression at the blocked gate, resolve the GitHub Actions
  billing or runner issue first, and then manually re-run the failed workflow
  job (or re-push once runner availability is restored) and wait for `verify` to
  reach `PASS` before merging or tagging.

## 9. Release rehearsal

Before a first-time release, rehearse the process in an **isolated copy** rather
than in the working repository:

1. Copy the tracked sources (plus the prepared, not-yet-committed release files)
   into a temporary directory, and initialize a throwaway Git repository there.
2. Run the same Node 24 commands from section 4 inside that copy.
3. Build and pack the tarball, compute its SHA-256, and install it into a clean
   production-only consumer.
4. Run the installed `playops --help` smoke, and confirm the tarball contains
   `CHANGELOG.md` and ships no credentials, state, scratch files, sources, or
   tests, and that no application network call is required.
5. Exercise the release branch, merge-commit, and tag commands (section 5)
   **only** in the throwaway repository.

The rehearsal also rehearses the `branch → PR → merge → tag-on-merge-commit`
flow inside the throwaway repository: commit the prepared release on a throwaway
release branch, simulate the pull request and `verify` check against the
throwaway `master` branch, merge the release branch into `master` with an
explicit merge commit (`git merge --no-ff`), and create and verify the annotated
tag `v${VERSION}` on that throwaway `master` merge commit rather than on the
release branch commit, without touching the real repository.

The rehearsal proves the documented process is executable. It does not replace
the checks in section 4 for the real repository, and it never tags, commits, or
pushes the real repository.

## 10. Limitations of this process

- The process is manual by design. Nothing in the repository enforces that a
  release was rehearsed, verified, or tagged correctly; the checks in section 2
  and the test suite only enforce that the version identity and changelog are
  internally consistent.
- Version consistency is enforced against the repository working tree. A release
  produced from a differently patched checkout is out of contract.
- `tests/fixtures/service-account.valid.json` is a tracked synthetic fixture
  for fresh-clone tests. The explicit `.gitignore` exception retains it in
  source checkouts while real credential files remain excluded. Separately, the
  E1 setup in `tests/daemon-production-composition.test.ts` generates a
  temporary synthetic `service-account.json` inside a `mkdtempSync` root and
  explicitly normalizes and asserts the required `0640` mode on that temporary
  file under a restrictive umask (`0077`) without changing production credential
  authorization or secret-file security policy. The tracked fixture is
  deliberately not shipped in the npm tarball, and the consumer does not depend
  on it. Do not replace it with real service-account material.
- The dependency audit (`npm audit --omit=dev`, `npm audit`) reports the state of
  the recorded versions at release time; it is not a guarantee about future
  advisories. The `minimatch` advisory `GHSA-g3hv-75wg-m249` remains an accepted
  temporary risk (dev lint tooling only).
- Production deployment, host provisioning, daemon service installation, and
  R6A remain blocked. Live Google mutation authorization is not established by
  any release step and requires separate, explicitly authorized operational
  evidence for each release.
