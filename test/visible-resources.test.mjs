/**
 * 回归：可见资源真源必须包含**持久化**会话，不能只看 live 会话。
 *
 * 真实缺陷（2026-11-12 两机实测）：
 *   被控端磁盘上有会话，`session/list` 却返回 `items: []`。
 *   原因：`visibleResourceIdsFromContext` 只读 `ctx.sessions.list()`（live），
 *   而官方 `session/list` 的过滤依据是持久化全集（`listState.list()`）。
 *   持久化会话不在 live 集合里 → 我们的 binding 不含它 → `allows()` 判否 → 空列表。
 *
 * 修复：`createVisibleResourceTracker` 合并 `sessionQuery.listSessions()`（持久化）
 * 与 live 集合，并缓存给同步的 `bindings()` 使用。
 *
 * @module test/visible-resources.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../lib/index.js')

/**
 * 造一个最小 ctx：可控的 live 会话、持久化会话与事件订阅。
 * @param {object} options - 初始状态。
 * @returns {{ctx: any, emit: (event: string) => void, setPersisted: (ids: string[]) => void}} 环境。
 */
function makeCtx(options = {}) {
  let liveSessions = options.live ?? []
  let persisted = options.persisted ?? []
  let liveWorkspaces = options.workspaces ?? []
  const listeners = new Map()
  const ctx = {
    get sessions() {
      return { list: () => liveSessions.map(id => ({ id })) }
    },
    get sessionQuery() {
      if (options.noSessionQuery === true) return undefined
      // 真实形状：SessionRecord = { header: { id }, live, ... }。
      // 曾经按 `row.sessionId` 映射，导致持久化全集恒为空（两机实测踩过）。
      return {
        listSessions: async () => persisted.map(id => ({
          header: { version: 4, id, cwd: '/home/xiaopb' },
          live: false,
        })),
      }
    },
    get workspaceRegistry() {
      return { list: () => liveWorkspaces }
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
  }
  return {
    ctx,
    emit(event) { for (const listener of listeners.get(event) ?? []) listener() },
    setPersisted(ids) { persisted = ids },
    setLive(ids) { liveSessions = ids },
    setWorkspaces(rows) { liveWorkspaces = rows },
  }
}

/** 等一次微任务 + 落定（tracker 的预热是异步的）。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('可见资源真源：持久化 ∪ live', () => {
  it('只有持久化会话（无 live）时也必须可见——真实的「空列表」缺陷', async () => {
    const env = makeCtx({ live: [], persisted: ['session-aaaa', 'session-bbbb'] })
    const tracker = mod.createVisibleResourceTracker({ ctx: env.ctx, refreshIntervalMs: 0 })
    await settle()
    const ids = tracker.resourceIds()
    assert.deepEqual([...ids.session].sort(), ['session-aaaa', 'session-bbbb'],
      '持久化会话必须在可见集合里，否则官方 session/list 会被过滤成空')
    tracker.dispose()
  })

  it('新建 workspace 在默认刷新窗口内进入可见绑定', async () => {
    const env = makeCtx()
    const tracker = mod.createVisibleResourceTracker({ ctx: env.ctx })
    try {
      await settle()
      env.setWorkspaces([{ id: 'workspace-created' }])
      await new Promise(resolve => setTimeout(resolve, 1_100))
      assert.ok(tracker.resourceIds().workspace.includes('workspace-created'))
    } finally { tracker.dispose() }
  })
  it('live 会话与持久化会话取并集，不重复', async () => {
    const env = makeCtx({ live: ['session-live'], persisted: ['session-live', 'session-disk'] })
    const tracker = mod.createVisibleResourceTracker({ ctx: env.ctx, refreshIntervalMs: 0 })
    await settle()
    const ids = tracker.resourceIds().session
    assert.equal(ids.filter(id => id === 'session-live').length, 1, '不能重复')
    assert.deepEqual([...ids].sort(), ['session-disk', 'session-live'])
    tracker.dispose()
  })

  it('真实 SessionRecord 形状（header.id）必须被正确取出', async () => {
    // 单独固定这条：`listSessions()` 返回的是 `{ header: { id } }`，
    // 不是 `{ sessionId }`。字段取错会让持久化全集恒为 0。
    const env = makeCtx({ live: [], persisted: ['session-real-1', 'session-real-2'] })
    const tracker = mod.createVisibleResourceTracker({ ctx: env.ctx, refreshIntervalMs: 0 })
    await settle()
    assert.deepEqual([...tracker.resourceIds().session].sort(), ['session-real-1', 'session-real-2'])
    tracker.dispose()
  })

  it('sessionQuery 缺席时退回 live 集合（不崩溃、不空转）', async () => {
    const env = makeCtx({ live: ['session-live'], noSessionQuery: true })
    const tracker = mod.createVisibleResourceTracker({ ctx: env.ctx, refreshIntervalMs: 0 })
    await settle()
    assert.deepEqual([...tracker.resourceIds().session], ['session-live'])
    tracker.dispose()
  })

  it('会话新增事件触发刷新（新会话立即可见）', async () => {
    const env = makeCtx({ live: [], persisted: [] })
    const tracker = mod.createVisibleResourceTracker({ ctx: env.ctx, refreshIntervalMs: 0 })
    await settle()
    assert.deepEqual([...tracker.resourceIds().session], [])

    env.setPersisted(['session-new'])
    env.emit('api-session/added')
    await settle()
    assert.deepEqual([...tracker.resourceIds().session], ['session-new'])
    tracker.dispose()
  })

  it('刷新失败保留上一次成功结果（不把设备踢成什么都看不见）', async () => {
    let fail = false
    const listeners = new Map()
    const ctx = {
      sessions: { list: () => [] },
      get sessionQuery() {
        return {
          listSessions: async () => {
            if (fail) throw new Error('disk gone')
            return [{ sessionId: 'session-kept' }]
          },
        }
      },
      workspaceRegistry: { list: () => [] },
      on(event, listener) {
        const set = listeners.get(event) ?? new Set()
        set.add(listener)
        listeners.set(event, set)
        return () => set.delete(listener)
      },
    }
    const errors = []
    const tracker = mod.createVisibleResourceTracker({
      ctx,
      refreshIntervalMs: 0,
      onError: message => errors.push(message),
    })
    await settle()
    assert.deepEqual([...tracker.resourceIds().session], ['session-kept'])

    fail = true
    await tracker.refresh()
    assert.deepEqual([...tracker.resourceIds().session], ['session-kept'], '失败时保留旧缓存')
    assert.ok(errors.length > 0, '失败必须被记录')
    tracker.dispose()
  })

  it('dispose 后停止刷新', async () => {
    const env = makeCtx({ live: [], persisted: ['session-a'] })
    const tracker = mod.createVisibleResourceTracker({ ctx: env.ctx, refreshIntervalMs: 0 })
    await settle()
    tracker.dispose()
    env.setPersisted(['session-changed'])
    await tracker.refresh()
    assert.deepEqual([...tracker.resourceIds().session], ['session-a'], 'dispose 后不再更新')
  })
})
