/**
 * 最小 store 引擎：替代 `@deepseek-ai/dsh-client-store` 的 `defineStore` / `createSnapshotStore`。
 *
 * ## 为什么自实现（依赖最小化，ADR-008）
 *
 * 官方 `ui-plugin-manager` 用这个包做了三件事：
 * 1. `createSnapshotStore(initial, { persist })` —— 快照源（控制器状态、详情、导航、registry 记忆）；
 * 2. `defineStore({ init, actions })` —— 导航 store（`view` / `tab`）；
 * 3. `bindSnapshotSelector(handle)` —— 把快照源绑成 `useX(selector)` 给渲染层。
 *
 * 这三件事的语义都很窄（快照引用稳定、`set` 通知、`act` 批量），本文件用 ~120 行给出**行为等价**实现，
 * 从而不必把整个 `dsh-client-store`（及其宿主侧装配）声明进 `dsh.client.inject`。
 *
 * ## 语义对齐要点
 *
 * - `getSnapshot()` 返回的引用**只在状态变化时**换新（`useSyncExternalStore` 的硬要求）；
 * - `subscribe()` 立刻不影响调用方，只登记；`set` 后同步通知所有订阅者；
 * - `defineStore` 的 actions 是「草稿可变」的纯写入函数，`create()` 后由 baked actions 包裹：
 *   先浅拷贝 + 结构共享（保留未改动字段的引用），再执行 action，再通知。
 * - `persist: { name }` 与官方 `StoreSpec.persist` 同义：读写 `localStorage[name]`。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/store
 */

/** 一个可订阅的只读快照源（与官方 `HostObservable` 同形）。 */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 可变快照源（额外带 `set`）。 */
export interface SnapshotStore<T> extends HostObservable<T> {
  set(next: T): void
}

/** `defineStore` 的 action 声明：草稿可变。 */
export type ActionsDecl<T> = Record<string, (draft: T, ...args: any[]) => void>

/** baked action 的形状：草稿参数被剥掉。 */
export type BakedActions<A extends Record<string, (...args: any[]) => void>> = {
  readonly [K in keyof A]: A[K] extends (draft: never, ...rest: infer P) => void ? (...args: P) => void : never
}

/** store 实例（渲染层与测试消费的对象）。 */
export interface StoreInstance<T, A extends ActionsDecl<T> = ActionsDecl<T>> {
  readonly actions: BakedActions<A>
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** store 句柄（注册货币；`create()` 产出实例）。 */
export interface StoreHandle<T, A extends ActionsDecl<T> = ActionsDecl<T>> {
  readonly spec: { init: () => T; persist?: string; actions: A }
  create(scopeKey?: string): StoreInstance<T, A>
}

/** 选择器绑定（渲染层 `useX(selector)`）。 */
export type SelectorHook<T> = <R>(selector: (snapshot: T) => R) => R

/** 与官方 `SnapshotSelectorHook` 同名的别名（vendored 代码用这个名字导入）。 */
export type SnapshotSelectorHook<T> = SelectorHook<T>

/**
 * 创建一个快照源。
 * @param initial - 初始快照。
 * @param options - 持久化键（与官方 `{ persist: { name } }` 同义）。
 * @returns 快照源。
 */
export function createSnapshotStore<T>(
  initial: T,
  options: { readonly persist?: { readonly name: string } } = {},
): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const key = options.persist?.name
  if (key !== undefined) {
    try {
      const stored = globalThis.localStorage?.getItem(key)
      if (typeof stored === 'string' && stored !== '') snapshot = JSON.parse(stored) as T
    } catch {
      // 无痕模式 / 损坏数据：保留初始值。
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      snapshot = next
      if (key !== undefined) {
        try {
          globalThis.localStorage?.setItem(key, JSON.stringify(next))
        } catch {
          // 配额/无痕：忽略持久化失败（与官方一致，不阻断状态流转）。
        }
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * 声明一个 store。
 * @param spec - 初始状态、actions 与可选持久化键。
 * @returns store 句柄。
 */
export function defineStore<T, A extends ActionsDecl<T>>(spec: {
  init: () => T
  persist?: string
  actions: A
}): StoreHandle<T, A> {
  return {
    spec,
    create: (scopeKey?: string) => {
      const persistKey = spec.persist === undefined
        ? undefined
        : scopeKey === undefined ? spec.persist : `${spec.persist}:${scopeKey}`
      const source = createSnapshotStore<T>(spec.init(), persistKey === undefined ? {} : { persist: { name: persistKey } })
      const actions = Object.create(null) as Record<string, (...args: unknown[]) => void>
      for (const [name, action] of Object.entries(spec.actions)) {
        actions[name] = (...args: unknown[]) => {
          // 结构共享：未改动字段保留原引用，便于选择器浅比较。
          const draft = { ...(source.getSnapshot() as object) } as T
          ;(action as (draft: T, ...rest: unknown[]) => void)(draft, ...args)
          source.set(draft)
        }
      }
      return {
        actions: actions as BakedActions<A>,
        getSnapshot: source.getSnapshot,
        subscribe: source.subscribe,
      }
    },
  }
}

/**
 * 把快照源绑定成选择器 hook。
 *
 * 渲染层的真实 hook 由宿主槽位渲染器建立；这里提供**同一个函数签名**，
 * 使得 vendored 代码（`props.useX(selector => …)` 的类型与调用点）无需改动。
 * @param source - 快照源。
 * @returns 选择器 hook。
 */
export function bindSnapshotSelector<T>(source: HostObservable<T>): SelectorHook<T> {
  return selector => selector(source.getSnapshot())
}
