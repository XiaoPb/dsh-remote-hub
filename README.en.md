# dsh-remote-hub

> [中文版](README.md) ｜ English

[![CI](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/ci.yml)
[![Release](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml/badge.svg)](https://github.com/XiaoPb/dsh-remote-hub/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@xiaopb/dsh-remote-hub?label=npm)](https://www.npmjs.com/package/@xiaopb/dsh-remote-hub)

**Dual-role remote takeover for DSH (v0.3.0)**

Docs: [Deployment](docs/DEPLOY.md) ｜ [Architecture](docs/ARCHITECTURE.md) ｜ [Design contract](docs/DESIGN.md) ｜ [API permission matrix](docs/API-MATRIX.md) ｜ [Doc index](docs/INDEX.md) ｜ [Changelog](CHANGELOG.md) ｜ [中文](README.md)

A Cordis plugin that lets **one DSH instance operate another**. After pairing, supported business views on the controller point to the target Host — sessions, workspaces, files and jobs live remotely, while Remote Hub device management stays local to the controller.

> **Acceptance status**: verified on an isolated Web controller plus a Debian Host — takeover, Full workspace/session creation, disconnect/reconnect, role-scoped read APIs, remote file browsing. The four Web/Desktop combinations, credential writes/login, and Android are **not** claimed as complete.

---

## Features

- **Pair by QR or short code**: a QR ticket and an 8-character Crockford code, both with a **15-second TTL**; a successful pair issues a persistent device token. Headless hosts get a CLI: `dsh-remote-hub-pair`.
- **Three roles enforced by DSH Gateway**: `read-only` / `control` / `full` are bound to endpoints and resources; unknown endpoints **deny by default**; `full` is **not** DSH owner. **`full` may write configuration, set provider API keys, and install/enable/disable plugins** — but every such write **requires the local owner to approve it on an approval card**.
- **Red lines are never delegated**: `account/*` (official login state), `settings/openSettingsDocument`, `directoryPicker/*`, `pluginInventory/*`, `dynamicCordisRunner/*`, `remoteAccess/follow` and `$events` stay host-local for every role; `settings/*`, `credentials/*`, `pluginManager/*` and `pluginMarket/*` are **prefix red lines with named exemptions**, so unregistered methods are always denied. CI re-asserts this on every build.
- **Secrets never travel in the clear**: when writing an API key, the approval card, audit log and diagnostics show only a masked value (`sk-****abcd`); an unanswered approval times out to **deny** (fail-closed), never a silent pass.
- **Official transport takeover**: HTTP RPC (`/remote/rpc`) and the official WebSocket mux (`/remote/ws`) both target the paired Host. The DSH kernel is not replaced.
- **Zero exposure by default**: the guard is an **independent** listener bound to a loopback literal (default `127.0.0.1:8443`). An occupied port fails loudly — it never silently shifts ports — and unpaired devices are fail-closed. Tunnelling defaults to `kind: 'none'`.
- **Credential placement**: outbound tokens are stored by the controller's local Host (`~/.dsh/remote-hub/outbound-targets.json`, POSIX `0600`/`0700`). The browser keeps only an opaque target ID — **no bearer token** — and the target-side device table stores only `sha256(token)`.
- **Disconnect is recoverable**: disconnecting switches back to local but preserves the pairing for one-click reconnect.
- **Cloud path UI (built in)**: remote directory browsing, creating remote folders, and a chat `+` action that appends cloud workspace files to the message. As of 0.3.0 this is **built into this plugin** — no separate companion package. It only registers UI while takeover is active, so local file picking and dsh-hardssh flows are untouched. Browsing requires a `full` pairing.

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

The package is `@xiaopb/dsh-remote-hub@0.3.0` (the cloud path UI is built in — no other package needed). Requires **Node.js ≥ 24.9.0** and **DSH ≥ 0.2.1-rc.2 < 0.3.0-0**.

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
