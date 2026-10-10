# Production deployment contract

This document is the deployment contract for the PlayOps release daemon
(`playopsd`) and its operator transport. It describes the intended production
shape of the service, the filesystem permission model, the trust boundaries and
the administrator actions. **This repository installs nothing.** Stage 4C.1 is a
source-only change: it ships templates and this contract, and it never creates a
user, a group, a directory, a service or a socket on any host. Every command in
this document is an administrator action performed outside the repository.

Read it together with the operator guide ([docs/operator-client.md](operator-client.md)),
the permission model ([docs/permissions-and-approvals.md](permissions-and-approvals.md)),
the credential rules ([docs/credentials.md](credentials.md)) and the audit rules
([docs/audit-log.md](audit-log.md)).

## What this is and is not

- It IS the contract a deployment must satisfy before `playopsd` is started as a
  service, and the exact filesystem, ownership and mode expectations the daemon
  validates at startup.
- It is NOT a claim that production deployment has happened or is ready. The host
  prerequisites below are unmet by the current development host, and this stage
  does not attempt to meet them.

## Account and group model

The transport is a Unix-domain socket with exactly one capability group.

| Account / group    | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `playops`          | Service account that runs `playopsd`. Owns the daemon and its state. |
| `playops-operator` | Capability group. Membership grants socket access only.              |
| `playops` (group)  | Group for trusted files the service must read (config, credential).  |

The service runs as `User=playops` with primary group `Group=playops-operator`
and `SupplementaryGroups=playops`, so every inode the daemon creates is owned by
`playops:playops-operator`. The operator account belongs to `playops-operator`
**only**, never to the `playops` group. A separate `playops` secret group keeps
the service-readable trusted files out of reach of the operator account.

## Socket mode and what it grants

The daemon accepts exactly one of two socket modes:

- `0600` — owner-only; used by tests and development.
- `0660` — the production capability-group mode. The socket is owned by
  `playops:playops-operator` and is connectable by members of `playops-operator`.

Any other mode is refused with `DAEMON_SOCKET_MODE_INVALID`. There is no generic
"group bits are acceptable" rule. After binding, the daemon verifies the socket
type, the exact mode, and that the bound inode is owned by its own effective
uid/gid (`DAEMON_SOCKET_OWNERSHIP_INVALID` otherwise).

`0660` membership is a real capability. A group member may call every **unsigned**
operation, and it may submit a signed `execute_*` request:

- query daemon status;
- prepare (but not publish) release operations;
- attach notes to an open, uncommitted Google Play edit (`attach_notes` is the
  only unsigned mutating operation, and it never publishes);
- submit an externally signed publish-class `execute_*` request for the daemon to
  verify and run.

Membership does **not** grant access to the credential, the configuration, the
state tree or the audit log, and it does **not** confer publish authority on its
own: publish-class operations require an off-host Ed25519 signature bound to the
exact human-verifiable statement. Node exposes no `SO_PEERCRED`, so the daemon
cannot attribute a request to a specific user; audit records identify the
request, operation, correlation and approval identity only.

## Runtime directory and the stale-socket contract

`RuntimeDirectory=playops` with `RuntimeDirectoryMode=0750` and the account model
above produce `/run/playops` owned by `playops:playops-operator` with mode
`0750`. The invariant is exact:

> The capability group has read and execute (traverse and connect) and **no write
> bit anywhere** in the mode, so it can neither create, delete, rename nor replace
> entries. The daemon, as the owner, can create its socket.

Traversal needs the `x` bit; connecting additionally needs the socket inode's
group-write bit (`0660`). A setgid bit is unnecessary because the service's
primary GID is already `playops-operator`.

There is deliberately **no unlink code** and no `rm -f` for a stale socket. The
removal guarantee comes from the runtime-directory lifecycle: with the systemd
default `RuntimeDirectoryPreserve=no` (this unit does not set it), `/run/playops`
and therefore the socket pathname are removed when the unit stops, including
before an automatic restart, and `/run` is a tmpfs cleared on reboot. The
daemon's own "refuse a pre-existing path" rule is then satisfied on the next
start. A blind unlink is rejected because `/run/playops` is not operator-writable
and because unlinking a live endpoint would let a second daemon displace the
first.

## State, logs and the honest limit

| Path                             | Owner / group              | Mode   |
| -------------------------------- | -------------------------- | ------ |
| `/var/lib/playops`               | `playops:playops-operator` | `0700` |
| `/var/lib/playops/pending`       | `playops:playops-operator` | `0700` |
| `/var/lib/playops/claims`        | `playops:playops-operator` | `0700` |
| `/var/lib/playops/write-intents` | `playops:playops-operator` | `0700` |
| `/var/lib/playops/release`       | `playops:playops-operator` | `0700` |
| durable state files              | `playops:playops-operator` | `0600` |
| `/var/log/playops`               | `playops:playops-operator` | `0700` |
| audit log file                   | `playops:playops-operator` | `0600` |

Operator and capability group have no access to the state tree or the log
directory. The honest limit: the daemon UID can still rewrite its own audit file;
no immutability is claimed. Monitoring must therefore be admin-side (watch the
state-tree size and the Google quota from the admin path) rather than in-daemon.

## Configuration and credential placement

- Configuration: `/etc/playops/playops.yaml`, owned `root:playops` mode `0640`,
  inside `/etc/playops` owned `root:playops` mode `0750`. The daemon reads it
  through the supplementary `playops` group; the operator cannot read or write it.
  A ready-to-adapt production template ships in the package as
  `config/playops.production.example.yaml`; it declares only absolute paths, omits
  the unused `llm` section and the unused `review.checkpoint_path`, and provisions
  nothing by itself.
- Trust anchor: `/etc/playops/operator-approval.pub`, owned `root:root` mode
  `0644`. It is public key material: anchor confidentiality is intentionally
  **not** required. It is validated as a regular root-owned file with no
  group/other write, inside a trusted parent directory, and read from the
  validated descriptor.
- Credential: `/etc/playops/credentials/google-play.json`, owned `root:playops`
  mode `0640`, inside `/etc/playops/credentials` owned `root:playops` mode `0750`.

Config **and** credential confidentiality from the operator is required and
enforced at startup (the old `root:anygroup 0644` acceptance is gone). For each of
them the daemon requires: owner `root`; a regular file, not a symlink; no other
read, write or execute; an exact mode of `0640` or `0440`; and — the critical group
separation — the file's group must be the trusted secret group (the group of its
parent directory) and must **not** be the daemon's effective socket capability
group (`playops-operator`). When the platform exposes supplementary groups the
secret group must also appear there, proving the daemon reads the file through the
intended `playops` supplementary group rather than through the capability group. A
`root:playops-operator 0640` misprovisioning therefore fails closed. The parent
directory must be a real, root-owned, non-group/other-writable directory whose
group is likewise not the effective capability group. No host gid is hard-coded
and no group name is resolved through a shell.

The production config file is not operator-writable and the developer config that
lives in the checkout is development-only.

## Node runtime and immutable artifacts

- A **root-owned** Node 24 is required (`engines: ">=24 <25"`). The stock
  `/usr/bin/node` (Node 20) is insufficient, and an operator-owned NVM Node is
  development-only and must not be used in production.
- Releases are installed into immutable, root-owned directories:
  `/opt/playops/releases/<release-id>/` (read-only for the service and operator),
  with a root-owned `/opt/playops/current` pointer. Install only from a reviewed
  release artifact with a recorded SHA-256.

## Service unit and its environment

The unit template is `deploy/systemd/playops.service`. Its `ExecStart` is:

```ini
ExecStart=/opt/playops/node24/bin/node /opt/playops/current/dist/daemon/main.js --config /etc/playops/playops.yaml
```

The service owns its environment. The deployment conditions are:

- the unit never sources an operator-writable `EnvironmentFile`, never uses
  `PassEnvironment`, and never sets `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD` or
  `LD_LIBRARY_PATH`;
- there is no manual production `playopsd` start under an operator shell;
- `PLAYOPS_*` environment overrides are development and admin tooling only;
  whoever controls the daemon's environment is trusted configuration input, so
  the service manager must own it.

The unit hardening set (see the template) enables `NoNewPrivileges`,
`PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict`, `ProtectHome`,
`ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`,
`ProtectClock`, `ProtectHostname`, `RestrictSUIDSGID`, `LockPersonality`, an
empty `CapabilityBoundingSet` and `AmbientCapabilities`, and
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`. It deliberately does **not**
enable `MemoryDenyWriteExecute` (incompatible with the V8 JIT), and it keeps the
network available for Google APIs.

## tmpfiles ownership split

`deploy/tmpfiles.d/playops.conf` owns only the nested directories systemd's
directory options do not cover: the three nested `0700` state directories
(`pending`, `claims`, `write-intents`) and the exactly-`0700` release-authority
parent `/var/lib/playops/release` that holds the private release state files
(edit session, edit cleanup journal, commit-attempt journal). Installing it is an
administrator action: copy it into `/etc/tmpfiles.d/` and let
`systemd-tmpfiles-setup.service` create the directories before the unit starts.
`/run/playops`, `/var/lib/playops` and `/var/log/playops` stay owned by systemd
and are intentionally absent from the tmpfiles file.

## Access matrix

`R` = read, `W` = write, `X` = traverse/connect, `-` = none.

| Path                                        | root/admin | `playops` | operator | group `playops` | group `playops-operator` |
| ------------------------------------------- | ---------- | --------- | -------- | --------------- | ------------------------ |
| `/opt/playops` (releases)                   | RWX        | R-X       | R-X      | -               | -                        |
| `/opt/playops/node24`                       | RWX        | R-X       | R-X      | -               | -                        |
| `/etc/playops`                              | RWX        | R-X       | -        | R-X             | -                        |
| `/etc/playops/playops.yaml`                 | RW         | R         | -        | R               | -                        |
| `/etc/playops/operator-approval.pub`        | RW         | R         | -        | R               | -                        |
| `/etc/playops/credentials`                  | RWX        | R-X       | -        | R-X             | -                        |
| `/etc/playops/credentials/google-play.json` | RW         | R         | -        | R               | -                        |
| `/run/playops`                              | RWX        | RWX       | R-X      | -               | R-X                      |
| `/run/playops/playops.sock`                 | RWX        | RWX       | RW       | -               | RW                       |
| `/var/lib/playops` and its four subdirs     | RWX        | RWX       | -        | -               | -                        |
| `/var/log/playops`                          | RWX        | RWX       | -        | -               | -                        |

The operator has no traverse on `/etc/playops` (mode `0750`, group `playops`), so the
public anchor is reachable by root and by the `playops` service group only; the anchor's
own `0644` mode matters for neither integrity nor confidentiality.

## Operator host prerequisites and independent admin

The operator host is **not production-ready** while the operator account is a
member of `sudo` and `disk`: both are escalation-equivalent (full admin and raw
block-device access). Removing those privileges requires an independent
administrator path first — the operator account must not be the only admin.
Adding an account to `playops-operator` is itself a privileged admin action, and
anchor, config, credential, unit, runtime and membership changes are admin-only.

## Anchor rotation

Generate the new key pair off-host. The administrator installs the new public
anchor at `/etc/playops/operator-approval.pub` (`root:root` mode `0644`) and
restarts the daemon. The private key never reaches the host, and the operator
cannot rotate the anchor.

## Verifying a local build

The daemon's own help text is safe to run anywhere and performs no Google call:

```sh
playops --help
```

Deployment itself is out of scope for this repository: Stage 4C.1 installs
nothing, creates no host path and starts no service.
