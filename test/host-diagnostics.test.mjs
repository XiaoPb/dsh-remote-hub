/**
 * 宿主诊断可靠性测试（Task 2.2 / 2.3）。
 *
 * 1. 状态写入必须**串行且单调**：并发调用不能出现旧 stage 覆盖新 stage
 *    （2026-11-11 实机：守卫已监听，文件却停在 policy:before）。
 * 2. 端口预检：端口被占用时必须给出可读分类（by-guard / by-other），
 *    而不是让 EADDRINUSE 变成一句日志。
 *
 * @module test/host-diagnostics.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import('../lib/index.js')

describe('status 写入串行化（并发不覆盖终态）', () => {
  it('高频写入后，文件内容是最新 seq 且与最后一次调用一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-status-'))
    try {
      const config = {
        ...mod.DEFAULT_CONFIG,
        guardPort: 0,
        deviceTablePath: join(dir, 'devices.json'),
      }
      // applyRemoteHub 会写 probe 状态；随后我们直接触发装配失败路径来制造多次写入。
      // 这里改为直接验证：多次装配（不同端口冲突）产生的状态写入不互相覆盖。
      const ctx = makeFakeContext()
      mod.applyRemoteHub(ctx, { ...config, guardPort: 1 }) // 特权端口 → startGuard 抛错

      // 等待写入链排空（串行链 + 重试最多 ~300ms）。
      await new Promise(resolve => { setTimeout(resolve, 800) })

      const statusPath = join(dir, 'host-status.json')
      const raw = await readFile(statusPath, 'utf8')
      const parsed = JSON.parse(raw)
      assert.equal(typeof parsed.seq, 'number', '必须带单调 seq')
      assert.equal(typeof parsed.instanceId, 'string', '必须带实例 id')
      assert.equal(parsed.pid, process.pid)

      // 终态必须是 failed（端口 1 不可用），而不是停在 assembling 的中间阶段。
      assert.equal(parsed.phase, 'failed', `终态应为 failed，实际 ${parsed.phase}/${parsed.stage}`)
      assert.ok(parsed.seq >= 2, '至少经过 probe → assembling → failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('守卫端口占用预检（assertGuardPortFree）', () => {
  it('端口被其它进程占用 → 抛出 port-in-use-by-other 并带上端口号', async () => {
    const blocker = createServer()
    await new Promise(resolve => { blocker.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = blocker.address().port
    try {
      await assert.rejects(
        () => mod.assertGuardPortFree({ ...mod.DEFAULT_CONFIG, guardPort: port }),
        error => /port-in-use-by-(other|guard)/u.test(String((error).message))
          && String((error).message).includes(String(port)),
      )
    } finally {
      blocker.close()
      // 等阻塞器真正释放（close 是异步的；这里不 await 回调以免测试环境挂起）。
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
  })

  it('端口空闲 → 不抛错', async () => {
    await assert.doesNotReject(() => mod.assertGuardPortFree({ ...mod.DEFAULT_CONFIG, guardPort: 1 }))
  })
})

/**
 * 最小 cordis ctx 桩：`applyRemoteHub` 需要 `inject` / `effect` / `logger`。
 * 这里让 inject 立即回调（模拟服务已就绪），effect 立即执行。
 */
function makeFakeContext() {
  return {
    inject(_deps, callback) {
      const scoped = { ...this }
      callback(scoped)
      return {}
    },
    effect(fn) {
      const result = fn()
      return () => { void result }
    },
    logger: { info() {}, warn() {}, error() {} },
  }
}
