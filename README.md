# PlayOps

PlayOps is an independent, **CLI-first** agent/harness for Google Play operations: review triage and human-approved public replies, a Release Agent runtime for existing `.aab` artifacts, and app-health reporting. It does **not** build Android apps and does **not** require Hermes at runtime.

**Supported runtime: Node.js 24 LTS (`>=24 <25`).** Current distribution is a local npm tarball, `playops-0.1.0.tgz`, installed as an npm CLI. It is **not published to the public npm registry**, a standalone binary, or a container. The supported entry point is `playops`, not a public JavaScript library API. PlayOps uses Semantic Versioning and stays **pre-1.0**: the prepared release is `0.1.0`, whose Git tag would be `v0.1.0`. See the [release process](docs/release-process.md) and the [changelog](CHANGELOG.md).

## Quickstart: install a local tarball

Prerequisite: Node **24** and npm. Obtain the actual tarball from your trusted package producer. The path below is a **placeholder**, not a download URL or registry package:

```sh
node --version
mkdir -p playops-operator
cd playops-operator
npm init -y
npm install --omit=dev /path/to/playops-0.1.0.tgz
export PATH="$PWD/node_modules/.bin:$PATH"
playops --help
```

`playops --help` is the **safe first command**: no credentials/config required and no Google, LLM, or browser call. The local bin path above applies in this shell; run from your operator directory. Installing the tarball can retrieve its runtime dependencies from npm; this is **not an offline-install guarantee**. No PlayOps compilation, repository source, TypeScript, devDependencies, or Hermes is needed on the consumer machine.

The package ships `README.md`, `CHANGELOG.md`, `LICENSE`, `config/playops.example.yaml` and the five operator guides linked below, alongside compiled runtime JavaScript. After local installation the guides are available under `node_modules/playops/docs/`.

### Configure deliberately; keep credentials external

```sh
mkdir -p config
cp node_modules/playops/config/playops.example.yaml config/playops.yaml
```

Edit **your** `config/playops.yaml` to set the approved package and path to an external service-account JSON. The shipped example uses a fake app and an empty credential path; copying it alone does not establish connectivity. Never commit credential JSON/private keys or store them inside the package.

Configuration is loaded from **`config/playops.yaml` relative to cwd**, with **environment > YAML > defaults** precedence. Relative credential paths also resolve against cwd, not the YAML or install directory; absolute paths work. There is **no `--config` option, automatic XDG/home discovery, or tilde expansion**. See the [credential/configuration guide](docs/credentials.md) for actual environment names, required settings, file validation and disabled-by-default exact reported-scale health thresholds.

After credential/API/app-access setup and an explicit decision to make live read-only requests:

```sh
playops doctor
```

Doctor checks config → credential shape → OAuth → `reviews.list` → `vitals.anrrate.get`. It performs no Google mutation, but **does contact Google** when prerequisites pass. Exit 0 / READY proves these checks only; exit 1 / NOT READY skips checks whose prerequisites failed. Prior read/connectivity evidence does **not** prove reply/upload/track-update/commit/rollout authorization. Read the [authorization limitations](docs/credentials.md#connectivity-is-not-mutation-authorization) before any mutation.

## Operator guides

All five guides **ship in the npm tarball**; their relative links work in the installed package:

- [Credentials and configuration](docs/credentials.md) — Google setup, external files, cwd/env semantics, health threshold migration, live-authorization limits.
- [Permissions and approvals](docs/permissions-and-approvals.md) — exact `read` / `write` / `destructive` / `publish` policy, operation binding, interactive/token architecture and limitations.
- [Audit log, diagnostic logging and safe errors](docs/audit-log.md) — actual JSONL schema, synthetic examples, required writes versus best-effort stderr, redaction limits.
- [Release pipeline walkthrough](docs/release-pipeline.md) — implemented runtime sequence, prebuilt AAB, exact approvals, independent verification, rollout and edit hygiene; **current CLI limitations**.
- [Release process](docs/release-process.md) — Semantic Versioning policy, prepared version identity, maintainer release checklist, annotated-tag contract and safety, artifact hashing, and what is explicitly out of scope.

The [changelog](CHANGELOG.md) ships too: it records operator-visible changes and the known limitations of the prepared release line. This repository has **no release automation** — no publish workflow, version bot, or tag automation — and `private: true` stays in place.

## Current command quick reference

### Reviews

```sh
playops reviews --help
playops reviews triage --help
playops reviews reply --help
```

With approved Google access plus review checkpoint/audit and 9Router settings:

```sh
playops reviews triage
playops reviews reply example-review-id
```

`triage` reads new/updated reviews, persists ingestion state and classifies them; **no draft or publish**. `reply` fetches a review, classifies, drafts, displays the **exact public draft**, then requires explicit human approval before one publish attempt and read-back verification. It may **replace an existing public reply**, with a warning. The ID above is fake, not a real review target. These commands can contact Google/9Router and are not offline examples.

No auto-publish, `--yes`, `--force`, or `--approve` shortcut exists. Publishing requires stdin **and** stdout TTYs; noninteractive/denied approval yields exit 2 and no publish, though draft/read work may already have happened. Changed review/developer-reply state blocks a stale draft. Failure/uncertain publish needs state inspection, **not blind retry**.

### Health

```sh
playops health report --help
```

The following **illustrative live-read command** requires configured Reporting access and an existing output directory. Dates are explicit sample windows, not a recommendation:

```sh
mkdir -p reports
playops health report \
  --current-start 2026-01-08T08:00:00Z --current-end 2026-01-15T08:00:00Z \
  --baseline-start 2026-01-01T08:00:00Z --baseline-end 2026-01-08T08:00:00Z \
  --granularity DAILY --output-dir ./reports
```

All six flags are **required**. Timestamps are `YYYY-MM-DDTHH:MM:SSZ`, start-inclusive/end-exclusive; windows need equal period counts. DAILY boundaries are Los Angeles midnight expressed in UTC (**DST-aware**); HOURLY uses UTC hours. Default kinds are `crash_rate,anr_rate,excessive_wakeup_rate`; excessive wakeups is DAILY-only. Optional `--kinds`, `--dimensions`, `--metrics` accept comma-separated lists; each flag may appear once, as `--name VALUE` or `--name=VALUE`. Explicit metrics must be valid for **every** selected kind; defaults use each kind's primary metric.

Health needs no LLM provider or approval. It saves a dated UTF-8/LF report exclusively, never overwrites a target, then writes **exactly the saved bytes to stdout**. Diagnostics/errors go to stderr. Exit 0 can include descriptive degradation/unavailable data; it is not a threshold-alert verdict. `health.check_thresholds` is a **separate runtime capability**, **not a CLI command**, scheduler or human-notification system; `health report` does not invoke it. Thresholds are disabled unless explicitly configured, use quoted exact reported-scale strings, and perform no percentage conversion.

### Releases

The implemented syntax is `playops releases --dry-run <mutating-release-tool>`, but the installed entrypoint supplies **no trusted composition-bound operation factory**. It currently refuses safely with exit 1; it does **not** open an edit or provide an end-to-end live release command. The pure runtime dry-run planner is side-effect-free; a dry-run is never authorization/publication proof. There is no `releases --help` implementation. See the [walkthrough](docs/release-pipeline.md) before confusing runtime tool names with operator commands.

## Safety, diagnostics and evidence boundaries

- Permission, human approval and post-action verification are separate. Ordinary `write` needs verification, **not interactive approval**; `destructive`/`publish` need both.
- Append-only **audit JSONL is operation evidence**; structured logging is separate, best-effort diagnostics on **stderr**. Minimum level is `info` by default; YAML `logging.level` / `PLAYOPS_LOGGING_LEVEL` accepts `debug`, `info`, `warn`, `error`.
- Safe unexpected-error output uses stable category/code, deterministic message and optional guidance, never raw stack/cause; existing command-specific safe messages remain. `externalStateUncertain=true` means **inspect before acting; no automatic retry**. Debug does not permit secret output.
- Redaction protects known key families; **arbitrary free-form strings are not universally scanned**. Never pass credentials, headers, SDK bodies or environment/config dumps to log messages.
- Runtime/tool safety and local-tarball installation have fake/mock/network-isolated acceptance on Node 24. Prior specific live reads and the narrow cleanup observation are separately scoped; **Google mutation authorization remains unverified**. The Phase 6 packaging, structured-logging, error-taxonomy, operator-documentation, security-review and versioning/release-process milestones are complete for the prepared `0.1.0` local tarball; that is **not** a public-registry release, a production certification, or 1.0 API stability.
- Known limitations include single-process token/state-file coordination, no cross-process locking, no enforced interactive prompt timer, and the unrecoverable insert-response edit-identity window. See the guides for the exact boundaries.

## Producer/contributor workflow (source checkout only)

This section is **not required on an installed consumer**. From a clean trusted source checkout on Node 24, install development dependencies, then build the local artifact via the existing producer-side `prepack` hook:

```sh
NODE_ENV=development npm ci
mkdir -p artifacts
NODE_ENV=development npm pack --pack-destination ./artifacts
```

This creates `artifacts/playops-0.1.0.tgz`; there is no install-time TypeScript build on the consumer. Do **not** substitute a public-registry install or `npm publish` for this local flow. The full maintainer checklist — version identity, changelog, annotated tag, artifact hash, and rehearsal in an isolated copy — is in [the release process](docs/release-process.md).

For source-change verification:

```sh
NODE_ENV=development npm run build
NODE_ENV=development npm run test:run
NODE_ENV=development npm run lint
NODE_ENV=development npm run typecheck
NODE_ENV=development npm run format:check
npm run test:package
```

Package acceptance performs a real isolated producer/production-only consumer install, installed-bin and fake state/audit/approval checks. Dependency retrieval is separate from network-blocked application checks: no live Google/9Router or real credentials are needed. The repository-only `PLAYOPS_PLAN.md` tracks milestone/evidence history; it and internal architecture/decision/probe documents **do not ship** in the consumer tarball.

One repository-only detail: `tests/fixtures/service-account.valid.json` is a **fake** fixture that `.gitignore` excludes by name (credential-shaped filename), so a freshly cloned working copy must recreate it locally before `npm run test:run` can pass. The consumer install path and the published tarball are unaffected.
