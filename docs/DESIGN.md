# Design and Security Contract

**Version:** 0.3.2
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

### Full writes take effect directly (0.3.1, D-16 retired)

Configuration (`settings/{update,replace,mutate}`), credentials (`credentials/{set,unset}`) and plugin lifecycle (`pluginManager/*` writes, `pluginMarket/setIndexes`) are **Full-only and take effect immediately**. The per-call owner approval card was removed at the operator's request: `APPROVAL_REQUIRED_ENDPOINTS` is empty and the Host no longer blocks these writes.

The cost is explicit: a `full` pairing is remote code execution plus the ability to rewrite host configuration and provider API keys. Grant `full` only to trusted devices; use `control` otherwise.

Redaction is **not** retired: payloads for secret-bearing endpoints still pass through `core/src/redact.ts` before they reach the audit log or any diagnostic file, so plaintext API keys never appear in logs. The approval machinery remains in `host/src/sensitive-approval.ts`; re-enabling it means adding endpoints back to `APPROVAL_REQUIRED_ENDPOINTS`.

Plugin surfaces are readable on every pairing: `pluginInventory/list` plus the plugin/market catalogs are shared read endpoints, so a `read-only` or `control` device can render the plugin pages.

## State ownership

- Controller Client-local: active target selection, theme, onboarding acknowledgement, editor preferences.
- Controller local Host: inbound device administration and encrypted-by-OS-user-boundary outbound pairing archive. POSIX archive uses directory mode `0700` and file mode `0600`; these are not an OS keychain.
- Target Host: sessions, workspaces, files, jobs, plugin inventory, model provider metadata, and target-side configuration.
- Browser carrier hint: mode, target origin, opaque target ID, and display label only; no bearer token.

## Path and file operations

A remote path always belongs to the target OS. The Remote Paths companion uses target-side directory browsing and creation; local file selection/upload remains a separate operation. Cloud-file selection appends target paths as references to the draft and does not send automatically. Host-native OS dialogs are not forwarded across machines.

## Release acceptance

The release is not described as full takeover until each supported Web/Desktop pair has real UI and side-effect evidence, every visible feature is classified by owner and capability, negative write tests pass for lower roles, and disconnect/reconnect and failure recovery are verified. Android is deferred.
