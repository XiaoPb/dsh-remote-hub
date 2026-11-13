# dsh-remote-hub

> [中文版](README.md) ｜ English

[![CI](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml)
[![Release](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@xiaopb/dsh-remote-hub?label=npm)](https://www.npmjs.com/package/@xiaopb/dsh-remote-hub)

**Dual-role remote takeover for DSH (v0.3.2)**

Docs: [Deployment](docs/DEPLOY.md) ｜ [Architecture](docs/ARCHITECTURE.md) ｜ [Design contract](docs/DESIGN.md) ｜ [API permission matrix](docs/API-MATRIX.md) ｜ [Doc index](docs/INDEX.md) ｜ [Changelog](CHANGELOG.md) ｜ [中文](README.md)

> **⚠️ Security warning**: a `full` pairing means remote code execution plus the ability to rewrite host configuration and API keys — and since 0.3.1 there is **no approval step**. Grant `full` only to fully trusted devices. See the security notice below.

A Cordis plugin that lets **one DSH instance operate another**. After pairing, supported business views on the controller point to the target Host — sessions, workspaces, files and jobs live remotely, while Remote Hub device management stays local to the controller.

> **Acceptance status**: verified on an isolated Web controller plus a Debian Host — takeover, Full workspace/session creation, disconnect/reconnect, role-scoped read APIs, remote file browsing. The four Web/Desktop combinations, credential writes/login, and Android are **not** claimed as complete.

---

## ⚠️ Security notice (read this first)

This plugin hands one machine to another. **Pairing is authorisation.** Understand these facts before use.

### 1. A `full` pairing means remote code execution (no approval step since 0.3.1)

| Capability | `read-only` | `control` | `full` |
| --- | :---: | :---: | :---: |
| View sessions / workspaces / files / plugin inventory | yes | yes | yes |
| Drive sessions (prompt, cancel, answer approvals) | no | yes | yes |
| Upload files, open terminals, browse remote directories | no | no | yes |
| **Rewrite host configuration / write API keys** | no | no | yes |
| **Install / remove / enable plugins** | no | no | yes |

Writes from `full` **take effect immediately; the local owner is no longer asked.** That means the paired device can:

- **install arbitrary plugins**, whose code then runs on your machine — equivalent to code execution under your account;
- **rewrite provider settings and API keys**, pointing your model calls at an endpoint of their choosing or installing their own key;
- change other host settings and thereby influence every later session.

> **Grant `full` only to fully trusted devices.** When unsure, use `control` (drives sessions, cannot touch configuration or plugins).
> Outside single-operator or "my own other machine" scenarios, think twice about `full`.

### 2. The token is the identity; a leak is replayable

- Pairing issues a **long-lived device token** (bearer) that can be replayed until revoked;
- Never screenshot or forward the pairing QR code or short code — the 15-second TTL and single use are mitigations, not screenshot protection;
- If you suspect a leak, **revoke that device immediately** in "Connected devices" and review the audit log.

### 3. Loopback by default; tunnels must be declared

- The guard binds `127.0.0.1:8443` and denies unpaired devices (fail-closed);
- Crossing a network requires a tunnel **plus** an explicit `publicAuthorities` entry, otherwise the origin fence rejects every tunnelled request;
- **Never point a tunnel at `:3080`** (the DSH Web GUI) — that exposes owner-level access publicly. The plugin asserts this while assembling tunnel arguments and refuses to start.

### 4. Secrets and logs

- Audit logs, diagnostics and `host-status.json` **never contain tokens or API keys**; payloads for secret-bearing endpoints are masked (`sk-****abcd`) first;
- The token files under `~/.dsh/remote-hub/` are **plaintext at rest**, protected only by OS permissions (`0600`/`0700`) — not an OS keychain;
- While taking over, the **browser** holds the token for the target host. Do not take over from an untrusted machine.

### 5. What is deliberately out of reach

- `account/*` (official login state and balance), `dynamicCordisRunner/*` (dynamic execution),
  `directoryPicker/pick` (host-native dialog) and `settings/openSettingsDocument` stay **closed to every role**;
- `full` is **not** DSH owner: host-side plugin lifecycle and credential management remain governed by DSH's own policy and host approval.

The complete per-endpoint matrix is in [API permission matrix](docs/API-MATRIX.md).

---

## Features

- **Pair by QR or short code**: a QR ticket and an 8-character Crockford code, both with a **15-second TTL**; a successful pair issues a persistent device token. Headless hosts get a CLI: `dsh-remote-hub-pair`.
- **Three roles enforced by DSH Gateway**: `read-only` / `control` / `full` are bound to endpoints and resources; unknown endpoints **deny by default**; `full` is **not** DSH owner. **`full` is fully opened up**: writing configuration, setting provider API keys and installing/removing/enabling plugins all take effect immediately, with no approval card.
- **Red lines are never delegated**: `account/*` (official login state), `settings/openSettingsDocument`, `directoryPicker/*`, `pluginInventory/*`, `dynamicCordisRunner/*`, `remoteAccess/follow` and `$events` stay host-local for every role; `settings/*`, `credentials/*`, `pluginManager/*` and `pluginMarket/*` are **prefix red lines with named exemptions**, so unregistered methods are always denied. CI re-asserts this on every build.
- **Plugins stay readable on every pairing**: the installed-plugin inventory, plugin/market catalogs, versions and details are open to `read-only`, `control` and `full`.
- **Secrets never travel in the clear**: when writing an API key, the audit log and diagnostics still show only a masked value (`sk-****abcd`) — dropping the approval step does not weaken redaction.
- **Official transport takeover**: HTTP RPC (`/remote/rpc`) and the official WebSocket mux (`/remote/ws`) both target the paired Host. The DSH kernel is not replaced.
- **Zero exposure by default**: the guard is an **independent** listener bound to a loopback literal (default `127.0.0.1:8443`). An occupied port fails loudly — it never silently shifts ports — and unpaired devices are fail-closed. Tunnelling defaults to `kind: 'none'`.
- **Credential placement**: outbound tokens are stored by the controller's local Host (`~/.dsh/remote-hub/outbound-targets.json`, POSIX `0600`/`0700`). The browser keeps only an opaque target ID — **no bearer token** — and the target-side device table stores only `sha256(token)`.
- **Disconnect is recoverable**: disconnecting switches back to local but preserves the pairing for one-click reconnect.
- **Cloud path UI (built in)**: remote directory browsing, creating remote folders, and a chat `+` action that appends cloud workspace files to the message. As of 0.3.1 this is **built into this plugin** — no separate companion package. It only registers UI while takeover is active, so local file picking and dsh-hardssh flows are untouched. Browsing requires a `full` pairing.

---

## Install

### From npm (recommended)

```bash
dsh plugin --profile web add @xiaopb/dsh-remote-hub
# a Host restart is required after upgrading: the guard listener and tunnel child
# process are not hot-replaced
```

### From source

```bash
git clone https://github.com/XiaoPb/dsh-remote-hub.git
cd dsh-remote-hub
pnpm install
pnpm run build
dsh plugin --profile web add link:$PWD
```

The package is `@xiaopb/dsh-remote-hub@0.3.2` (the cloud path UI is built in — no other package needed). Requires **Node.js ≥ 24.9.0** and **DSH ≥ 0.2.1-rc.2 < 0.3.0-0**.

---

## Enable the Host

Add the package to the DSH profile roster and restart that Host:

```yaml
- id: remote-hub
  name: '@xiaopb/dsh-remote-hub'
```

The roster id is fixed to `remote-hub` and never changes across versions. The guard defaults to loopback; a trusted LAN test needs an explicit profile:

```yaml
network: lan
guardHost: '0.0.0.0'
guardPort: 8443
singleController: true
defaultRole: control
```

> **Red line**: never point a tunnel at the DSH Web GUI port (usually `:3080`). The Remote Hub guard is a **separate** listener, and exposing it exposes owner-equivalent access. `startTunnel()` asserts while assembling argv that the upstream is `http://127.0.0.1:<port>` and contains no `:3080`; violating it fails plugin load.

Full config reference, tunnel provider selection, health checks and troubleshooting: [Deployment](docs/DEPLOY.md).

---

## Pairing (operator view)

1. On the local DSH page, choose **Add device** and pick a role (`read-only` / `control` / `full`).
2. The page renders a QR code; the device scans it, or you type the 8-character code (valid 15 seconds, at most 5 wrong attempts).
3. The device redeems the ticket and receives `{ deviceId, token, role }` once; every later request carries `Authorization: Bearer <token>`.

Headless hosts:

```bash
dsh-remote-hub-pair --code --role control --label edge-server
```

**Do not screenshot and share the pairing QR code**: short TTL plus single use is a mitigation, not a guarantee against screenshots. A leaked token is replayable until revoked — revoke and audit.

---

## Verify

```bash
pnpm run typecheck        # both host and client tsconfigs
pnpm run build            # tsc → tsdown (host / carrier-boot / client, fixed order)
node scripts/run-all-tests.mjs   # runs every test/*.test.mjs serially
node scripts/version-gate.mjs    # compatibility matrix
node scripts/contract-check.mjs  # protocol contract reconciliation
node scripts/fence.mjs           # origin-fence cases
node scripts/redlines.mjs        # red lines are never delegated
```

CI runs exactly these. Releases go through CI/CD only — **no manual local `npm publish`**; see [Release process](docs/RELEASE.md).

---

## Limits

- **Android is deferred** and not part of this release.
- **Desktop Host combinations have not been verified** against an isolated desktop instance; tests never modify or restart the Desktop instance you use daily.
- **Credential writes, account login and real model requests** need a dedicated test credential/account and are not covered by default acceptance.
- `full` does **not** silently become DSH owner: plugin lifecycle, dynamic Cordis execution, arbitrary settings and credential management stay independently controlled and may require Host approval.
- The guard binds loopback only by default; before crossing a network you must configure `publicAuthorities`, otherwise every tunnelled request is denied by the origin fence (correct fail-closed behaviour).

---

## Documentation

| Document | Contents |
| --- | --- |
| [README.md](README.md) | 中文版 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deployment, configuration, tunnel choice, health checks, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data paths, identity, authorization, persistence |
| [docs/DESIGN.md](docs/DESIGN.md) | Role semantics, state ownership, supported boundaries |
| [docs/API-MATRIX.md](docs/API-MATRIX.md) | **Every endpoint × role permission table** (generated) |
| [docs/RELEASE.md](docs/RELEASE.md) | CI/CD release process and controls |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

Internal plans, historical designs, audits and environment-specific acceptance records stay in the ignored `dev/docs/` tree and are never shipped in the release package.

## License

[MIT](LICENSE) © 2026 XiaoPb
