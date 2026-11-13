# Design and Security Contract

**Version:** 0.3.0
**Status:** Web-to-Web primary path verified; Desktop matrix and several Host-management workflows remain incomplete.

## Product behavior

After connecting to target B, supported business operations use B's DSH Host and resources. The Remote Hub control page continues to manage the controller A's inbound guard and outbound target selection. Disconnect returns the Client to A without deleting the saved B pairing; reconnect uses that saved target.

A successful pair, transport install, individual API, or single UI page is not by itself proof of complete takeover. UI must not silently fall back to A when a B operation fails.

## Authorization

The guard always creates a `remote-device` principal. The target Host binds the paired role and each decision to the addressed resource. HTTP, WebSocket mux, approval replies, and streams must not bypass the same policy.

- `read-only`: inspect authorized resources and read-only catalogs; no mutation or execution.
- `control`: perform explicitly listed session/workspace actions on bound resources.
- `full`: additionally perform explicitly listed file/terminal and selected administrative actions — **writing configuration, setting provider API keys, and installing/enabling plugins**.

Unknown endpoints deny by default. `full` is not equivalent to DSH owner.

### Sensitive writes require per-call owner approval (D-16)

Every write to configuration (`settings/{update,replace,mutate}`), credentials (`credentials/{set,unset}`) or plugin lifecycle (`pluginManager/*` writes, `pluginMarket/setIndexes`) is gated a second time by an **owner approval card** raised by the Host before the request reaches the Gateway. An unanswered approval times out to a denial; approvals are cached for 60 s per device and payload, denials never are. Secrets in those payloads are masked (`sk-****abcd`) before they reach the approval card, the audit log or any diagnostic file.

## State ownership

- Controller Client-local: active target selection, theme, onboarding acknowledgement, editor preferences.
- Controller local Host: inbound device administration and encrypted-by-OS-user-boundary outbound pairing archive. POSIX archive uses directory mode `0700` and file mode `0600`; these are not an OS keychain.
- Target Host: sessions, workspaces, files, jobs, plugin inventory, model provider metadata, and target-side configuration.
- Browser carrier hint: mode, target origin, opaque target ID, and display label only; no bearer token.

## Path and file operations

A remote path always belongs to the target OS. The Remote Paths companion uses target-side directory browsing and creation; local file selection/upload remains a separate operation. Cloud-file selection appends target paths as references to the draft and does not send automatically. Host-native OS dialogs are not forwarded across machines.

## Release acceptance

The release is not described as full takeover until each supported Web/Desktop pair has real UI and side-effect evidence, every visible feature is classified by owner and capability, negative write tests pass for lower roles, and disconnect/reconnect and failure recovery are verified. Android is deferred.
