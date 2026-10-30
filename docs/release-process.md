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
documentation belong to the same commit that the annotated tag points at.

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

The intended order is fixed:

```text
prepare version + changelog
  → verification
  → commit
  → annotated tag
```

`CHANGELOG.md` must be finalized **before** verification, because the published
artifact and the tag both belong to the commit that contains it.

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
15. Commit the release preparation with a conventional commit message.
16. Create the **annotated** tag on that commit (section 5).
17. Verify the tag points at the intended commit (section 5).
18. Distribute the approved artifact to its intended consumers, together with the
    recorded SHA-256.
19. Push commits and tags **only when explicitly authorized**. Pushing is not
    part of preparing a release.

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
identity (`nlink === 1`, no symlinks), package metadata, and the allowlisted
payload (while permitting verified paired `.d.ts` and `.js.map` compiler
byproducts in `dist/` that do not ship), then sets declared `package.bin`
entrypoints (`dist/cli/index.js`, `dist/daemon/main.js`) to exact mode `0755`
and all other shipped payload files (compiled `dist/**/*.js`, root payload
files, operator guides, and `deploy/**` templates) to exact mode `0644`. The
manifest keeps the no-`prepare`/no-`preinstall`/no-`install`/no-`postinstall`
contract. Do not disable lifecycle scripts for release packaging. A pack with
`--ignore-scripts` is only a diagnostic of already-built output, not the release
build procedure.

Compare normalized relative package entry lists, normalized file modes (`0755`
for declared `bin` entrypoints and `0644` for all other shipped files), and
per-entry content hashes across repeat clean builds and the isolated
`test:package` artifact. Counts alone do not prove equal payloads. When a
release gate requires byte-for-byte `.tgz` reproducibility across independent
clean builds, the raw `.tgz` SHA-256 hashes must also match byte-for-byte;
archive-metadata or file-mode differences do **not** waive an explicitly
required byte-reproducibility check. Record each observed archive hash
separately rather than substituting a hash from another build.

For the `0.4.1` unreleased development candidate currently in preparation:

- E1 synthetic credential fixture mode normalization (`0640` under restrictive
  umask), E2-A normalizer implementation and 39 unit tests (plus one frozen
  smoke probe with 10 cases, runtime-JS regression, and 3 diagnostics), E2-B
  `prepack` wiring with synthetic dry-run lifecycle witnesses
  (`clean -> compile -> normalize`, failure propagation, and no install hooks;
  `E2_B_TECHNICALLY_VERIFIED` and accepted as
  `E2_B_ACCEPTED_WITH_DOCUMENTED_EXCEPTION`), and the P3 exact two-file delta
  in `scripts/package-content.mjs` and `scripts/package-content.test.mjs`
  where the shared package-content validator enforces the exact
  deployment-template allowlist (rejecting extra files under `deploy/` in shared
  `findPathViolations` for F1 and adding `DEPLOYMENT_TEMPLATE_FILES` to
  `REQUIRED_PAYLOAD_FILES`/`REQUIRED_FILES` so both
  `deploy/systemd/playops.service` and `deploy/tmpfiles.d/playops.conf` are
  required for F2) are complete.
- On the 327-file P3 candidate snapshot, all six release gates (`lint`,
  `test:run` with `3271` executed tests in `145` files, `typecheck`,
  `format:check`, `build`, and `test:package` with `123` checks, zero failures,
  and `networkCallsObserved` empty), all five native script suites (`13`, `39`,
  `87`, `15`, and `22` tests respectively), two byte-reproducible ordinary
  lifecycle `npm pack` runs (`148` entries), separate production-only consumer
  install and `playops --help` smoke, the scoped F1/F2-only Kiro review, and
  the `2026-10-30` final post-audit source/protected-state/security postcheck
  completed under `P3_WORKFLOW_CLOSED_WITH_DOCUMENTED_EXCEPTIONS`, preserving
  the explicitly accepted historical AGY lookup, runner, consumer, and
  final-continuation exceptions (not a clean exception-free run or blanket
  whole-repository Kiro audit).
- Reconciling the release documentation in `README.md`, `CHANGELOG.md`, and
  `docs/release-process.md` creates a new working-tree snapshot that is not yet
  verified as a current tree or rebuilt `playops-0.4.1.tgz` artifact and
  requires its own applicable release-process verification, rebuilt artifact
  identity, and relevant review; `0.4.1` remains uncommitted, untagged, and
  unpublished, and frozen `v0.4.0` is unchanged.

## 5. Tag contract and tag safety

Releases use **annotated** tags:

```sh
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v${VERSION}" -m "PlayOps v${VERSION}"
```

`package.json` version `${VERSION}` corresponds to Git tag `v${VERSION}`. A version bump
without that tag is not a release, and a tag without the matching manifest,
lockfile, and changelog entry is not a release either.

Before tagging, verify all three of the following and require a clean tree:

```sh
git status --short
git rev-parse HEAD
git tag --list "v${VERSION}"
```

- `git status --short` must print nothing.
- `git rev-parse HEAD` must be the intended release commit.
- `git tag --list "v${VERSION}"` must print nothing. If the tag already exists, **stop
  and review**: an existing release tag is never silently moved or overwritten.

Never use `git tag -f` for a normal release. If a tag was created in error and
has not been distributed, delete it deliberately and re-tag the correct commit;
if it has been distributed, publish a new version instead.

After tagging, confirm the tag resolves to the release commit:

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

The following are **not** part of this release process and must not be added
without a separate, explicit decision:

- GitHub Actions or any other release/publish workflow.
- An automation release job, auto-version bot, `semantic-release`, `changesets`,
  or `release-please`.
- Code signing, provenance attestation, or an update checker.
- Public registry publication, GitHub releases, binaries, containers, and
  installers.
- Removing `private: true`.

## 8. Release rehearsal

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
5. Exercise the tag commands (section 5) **only** in the throwaway repository.

The rehearsal proves the documented process is executable. It does not replace
the checks in section 4 for the real repository, and it never tags, commits, or
pushes the real repository.

## 9. Limitations of this process

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
  advisories.
- Production deployment, host provisioning, daemon service installation, and
  R6A remain blocked. Live Google mutation authorization is not established by
  any release step and requires separate, explicitly authorized operational
  evidence for each release.
