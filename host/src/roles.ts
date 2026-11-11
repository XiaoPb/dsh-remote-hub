/**
 * Role policy registration — the bridge between `@core/roles` and the official
 * access-control machinery.
 *
 * ⚠️ VERIFY BEFORE IMPLEMENTING (see docs/DESIGN.md §13):
 * the exact service key and surface of the official policy registry in
 * `@deepseek-ai/dsh-api-remotes` / `dsh-api-remote-access` (role descriptors,
 * `decide()`, `allows()`, `invalidate(principal)`, the `remote-access/denied`
 * error id). Names below mirror the design doc, not yet the installed typings.
 *
 * Non-obvious requirements:
 * - `decide()` runs AFTER endpoint + argument-field checks and Typert type
 *   validation, and BEFORE lookup/Context resolution — so a read-only device
 *   never reaches business code and never activates a Session. It does NOT run
 *   "before argument decoding": the arguments are already validated at that
 *   point (docs/DESIGN.md §13.1 F5, D-15 / C2).
 * - `registerPolicy('remote-device', …)` MUST be registered before the first
 *   `createPeer`: a principal kind with no policy is refused with `no-allow`,
 *   which is a hard failure, not a silent downgrade to read-only (D-13).
 * - Bindings must be laid out per resource KIND (`global` / `session` /
 *   `workspace`), not all on `global`. A method whose `sessionId` resolves to a
 *   `session` resource is refused unless a binding exists on that kind, so an
 *   all-`global` matrix fails closed on every session-scoped call (D-11).
 * - List methods must filter per item, so the client can hide what the host
 *   would refuse instead of showing a button that 403s.
 * - Roles are bound to devices at pairing; there is no "client claims role".
 * - `invalidate(principal)` on grant/revoke/role-change so open snapshots
 *   recompute.
 *
 * @module dsh-remote-hub/host/roles
 */
import type { Context } from '@deepseek-ai/cordis'

import type { DeviceStore } from './devices.ts'

export interface AccessPolicyHandles {
  /** Re-evaluate every cached access snapshot. Call after any role change. */
  invalidate(deviceId: string): void
  dispose(): void
}

/** TODO(M2.1): register one RemoteAccessPolicy per non-owner principal kind. */
export function registerAccessPolicy(_ctx: Context, _devices: DeviceStore): AccessPolicyHandles {
  throw new Error('NOT_IMPLEMENTED: registerAccessPolicy')
}
