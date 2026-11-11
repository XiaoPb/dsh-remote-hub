/**
 * Access snapshot: the client's **only** source of truth for "may I show this".
 *
 * v0.2（D-11）：快照不再由插件自算方法表，而是来自 Host 绑定的角色 +
 * `core/capabilities.ts` 的同一张矩阵（`allActionsFor(role)`）。UI 隐藏入口与后端
 * `decide()` 读的是同一份表，所以永远不会显示一个后端一定会拒绝的按钮。
 *
 * 纯内存、零 I/O、零 fetch —— 快照由 transport 收到角色变更后调用 `update()`。
 *
 * @module dsh-remote-hub/client/access
 */
import type { RoleName } from '@core/roles.js'
import { ROLE_NAMES, isRoleName } from '@core/roles.js'
import { allActionsFor } from '@core/capabilities.js'

/** 一份权限快照。 */
export interface AccessSnapshot {
  /** Host 在配对时绑定的角色；客户端不可自称（红线 R5）。 */
  role: RoleName
  /** 该角色当前被允许调用的 endpoint（来自能力矩阵，不是本地硬编码）。 */
  allowed: readonly string[]
  /** 快照版本号；每次更新 +1，便于订阅者判定是否变化。 */
  version: number
}

export interface AccessStore {
  current(): AccessSnapshot | null
  /** 无权时返回 false；调用方据此**不渲染**该 DOM 节点（不是 disabled）。 */
  can(endpoint: string): boolean
  subscribe(listener: (snapshot: AccessSnapshot) => void): () => void
  /** Host 角色变更 / 新配对后调用。 */
  update(input: { role: string }): AccessSnapshot
  /** 清空（401 / 吊销）。 */
  clear(): void
  dispose(): void
}

/**
 * 创建权限快照存储。
 * @returns `AccessStore`。
 */
export function createAccessStore(): AccessStore {
  let snapshot: AccessSnapshot | null = null
  let version = 0
  const listeners = new Set<(snapshot: AccessSnapshot) => void>()

  const emit = (next: AccessSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener(next)
  }

  return {
    current() { return snapshot },
    can(endpoint) {
      return snapshot !== null && snapshot.allowed.includes(endpoint)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(input) {
      if (!isRoleName(input.role)) {
        throw new Error(`access: unknown role ${JSON.stringify(input.role)}`)
      }
      const role: RoleName = input.role
      version += 1
      const next: AccessSnapshot = {
        role,
        allowed: allActionsFor(role),
        version,
      }
      emit(next)
      return next
    },
    clear() {
      snapshot = null
    },
    dispose() {
      listeners.clear()
      snapshot = null
    },
  }
}

/** 三档角色的展示顺序（UI 下拉用）。 */
export { ROLE_NAMES }
