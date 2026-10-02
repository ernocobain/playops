# PlayOps

Independent AI agent/harness for **Google Play and Android application operations** — review triage/replies, release lifecycle management for existing `.aab` artifacts, and app health monitoring.

**Status:** Phase 1 — Google Play Connection in progress. See `PLAYOPS_PLAN.md` (source of truth for all work).

## Stack

- **Language:** TypeScript
- **Runtime baseline:** Node.js 24 LTS (`>=24 <25`; local development may use a different Node version)
- **Interface:** CLI-first

## Repository layout

```text
playops/
├── PLAYOPS_PLAN.md        # Source of truth — read before any task
├── package.json           # No dependencies until Phase 0.3
├── tsconfig.json          # Strict TypeScript → ESM, outDir dist/
├── README.md
├── LICENSE                # MIT
├── .gitignore
├── src/
│   ├── index.ts           # Entry placeholder (implementation starts Phase 0.5+)
│   ├── cli/               # CLI commands (Phase 1.4, 3.5, 5.x)
│   ├── runtime/           # Agent runtime core (Phase 2): registry, permissions, approvals, verify, loop
│   ├── googleplay/        # Official Google API clients (Phase 1): publisher, reporting, auth
│   ├── tools/             # Domain tools (Phases 3–5): reviews, releases, health
│   ├── audit/             # Audit log (Phase 0.6)
│   └── config/            # Config loader (Phase 0.5)
├── tests/                 # Test suites + fixtures (runner chosen in Phase 0.4)
│   └── fixtures/
├── docs/
│   ├── architecture.md    # Module map, permission model, approval flow
│   └── decisions.md       # Decision log (license, toolchain, providers…)
└── config/
    └── playops.example.yaml  # Example operator config (no secrets)
```

## Principles (summary)

1. Official Google APIs first; browser automation is a flagged fallback only.
2. AI acts only through explicit tools with permission levels (`read`/`write`/`destructive`/`publish`).
3. `destructive` and `publish` actions require human approval by default.
4. Every mutation is read-back verified and written to a local JSONL audit log.
5. PlayOps accepts an already-built `.aab`; it never compiles Android artifacts.

## Development

Run `npm run build`, `npm run test:run`, `npm run lint`, `npm run typecheck` and `npm run format:check` to verify changes. All acceptance evidence lives in `PLAYOPS_PLAN.md`.

## Read-only connectivity check (`playops doctor`)

1. Configure the target in the **git-ignored** `config/playops.yaml` (copy `config/playops.example.yaml`) or set `PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME` and `PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`. Set the latter to an absolute path to a Google service-account JSON **outside this repository**. Do not paste credentials or tokens into chat, logs, or the plan.
2. In Google Cloud, enable the **Google Play Android Developer API** and **Play Developer Reporting API** for the service account's project. In Play Console → **Users and permissions**, grant the service account only the app and app-quality/reviews read access needed for these checks. Do not grant release/publishing rights for doctor; consult Play Console's effective permission requirements for review reads.
3. Run `npm run build && node dist/cli/index.js doctor` from the repository root. A future installed package exposes the same entrypoint as `playops doctor`. The command checks config → credential shape → OAuth token with both scopes → `reviews.list` (one review maximum) → `vitals.anrrate.get`. No Google-side writes occur. Exit `0` means **READY** only when all five checks pass; exit `1` means **NOT READY**, with later checks skipped when prerequisites fail. Token, private key, raw Google errors and request config are never rendered.

An HTTP 403 does **not** by itself identify an API-disabled condition; check Cloud API enablement, service-account identity, app permissions and package access. An empty review list is a successful read. Without a valid local operator configuration the command exits 1 at CONFIG and makes no network request; this does **not** establish live connectivity.
