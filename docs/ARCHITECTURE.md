# Architecture

`@xiaopb/dsh-remote-hub` is one DSH package with a Host half and a browser Client half, sharing protocol, identity, and capability contracts from `core/`.

## Data path

- The target Host runs an independent HTTP guard (default `127.0.0.1:8443`). The guard authenticates a paired device, creates a `remote-device` Peer, and forwards official Typert RPCs through DSH Gateway.
- The controller Client installs its carrier before DSH connection captures the transport. `/api/*` requests are sent to the target guard; WebSocket mux traffic uses the target guard's authenticated WS route.
- Pairing issue and device administration remain on the local Host owner channel. They are not forwarded through the remote carrier.

## Identity and authorization

Pairing binds an immutable device ID and one of `read-only`, `control`, or `full` to a bearer whose target-side record stores only a SHA-256 hash. Each RPC/stream is authorized by the official Gateway policy and the resource it addresses. Read-only catalogs are shared across roles; writes and execution are explicitly assigned. Unknown endpoints deny by default.

Full is not DSH owner. Host plugin lifecycle, dynamic Cordis execution, account operations, credential mutation, and arbitrary settings are not implicitly granted. Native directory pickers are not forwarded; the optional Remote Paths companion uses target-side browse APIs instead.

## Persistence

The target Host stores inbound device hashes under `DSH_HOME/remote-hub/devices.json`. The controller's local Host stores outbound bearer credentials in `DSH_HOME/remote-hub/outbound-targets.json`; directory and file permissions are `0700` and `0600` on POSIX. The browser stores only an opaque target ID in its carrier hint. Disconnect changes the active target to local but preserves the pairing archive for reconnect.

## Optional Remote Paths companion

`companions/remote-paths` is a separate package. It registers cloud directory UI only when the Remote Hub carrier is active, leaving local native and dsh-hardssh flows untouched. Its chat `+` menu action browses the target session workspace and appends selected paths as references to the draft; it does not upload a local file or send the message.

## Verification status

Web-to-Web takeover, workspace/session creation, read-only candidate discovery, plugin/task catalog reads, disconnect/reconnect, and target-side persistence have real Edge/CDP and SSH evidence. Desktop four-way combinations, credential writes/login, and model requests are not yet accepted as complete. See README for release limitations; internal evidence and plans remain outside the public `docs/` tree.
