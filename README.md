# dsh-remote-hub

**Current release: `0.2.5`**

Let one DSH instance operate another. After pairing, supported business views on the controller point to the target Host. Remote Hub device management remains local to the controller.

> Verified on an isolated Web controller and Debian Host: takeover, Full workspace/session creation, disconnect/reconnect, role-scoped read APIs, and remote file browsing. The four Web/Desktop combinations, credential writes/login, and Android are not claimed as complete.

## Features

- Pair with a QR ticket or 8-character Crockford code. Both expire after 15 seconds; successful pairing issues a persistent device token.
- `read-only`, `control`, and `full` roles are enforced by DSH Gateway endpoint and resource bindings.
- Read-only catalogs are available to every role; writes, execution, credentials, account operations, and Host administration remain capability-controlled.
- HTTP RPC and the official WebSocket mux target the paired Host. Disconnect preserves pairing for one-click reconnect.
- Outbound credentials are stored by the local Host profile in `remote-hub/outbound-targets.json`; the browser carrier hint contains only an opaque target ID.
- The optional Remote Paths companion provides remote directory browsing and a cloud-file action in the chat add menu. Local file picking and dsh-hardssh remain separate.

## Install

```bash
git clone <repository-url> && cd dsh-remote-hub
pnpm install
pnpm run build
```

The main package is `@xiaopb/dsh-remote-hub@0.2.5`. The companion is `@xiaopb/dsh-remote-paths@0.2.5`.

## Enable the Host

Add the package to the DSH profile roster and restart that Host:

```yaml
- id: remote-hub
  name: '@xiaopb/dsh-remote-hub'
```

The guard defaults to loopback. For a trusted LAN test, configure the profile explicitly:

```yaml
network: lan
guardHost: '0.0.0.0'
guardPort: 8443
singleController: true
defaultRole: control
```

Do not expose the DSH Web GUI port (usually `3080`) as the guard upstream. The Remote Hub guard is a separate listener.

## Verify

```bash
pnpm run typecheck
pnpm run build
node scripts/run-all-tests.mjs
node scripts/contract-check.mjs
node scripts/version-gate.mjs
```

## Limits

- Android is deferred.
- Desktop Host combinations have not been tested with an isolated Desktop instance. The user's primary Desktop instance is not modified or restarted during tests.
- Credential writes, account login, and a real model request require a dedicated test credential/account and have not been exercised in the default acceptance.
- `full` does not silently become DSH owner. Plugin lifecycle, dynamic Cordis execution, arbitrary settings, and credential management remain separately controlled and may require Host approval.

Public installation and architecture documents are under [`docs/`](docs/). Internal plans, historical designs, audits, and environment-specific acceptance records are kept locally under `dev/docs/` and are not included in the release package.
