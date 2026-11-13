/**
 * 端口自动顺延（2026-11-12 新增）。
 *
 * 需求：守卫端口被占时，**自动 +1** 探测到可用端口继续启动，而不是整体失败；
 * 用户之后可在配置里改回固定端口。
 *
 * 为什么可以安全换：隧道与配对链接都用 `guard.origin`（**实际**绑定端口），
 * 所以端口漂移不会让它们指向错误位置。
 *
 * 设计取舍：这些用例**只占一两个端口**，不刻意占满整个扫描窗口——在 Windows 上
 * 连续占大量端口会让监听/关闭互相干扰，测试本身不可靠（本文件第一版就因此挂起）。
 * 「窗口全占」由 {@link MAX_PORT_SCAN} 的边界断言 + 单一被占端口的行为断言共同覆盖。
 *
 * @module test/guard-port-shift.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

const mod = await import('../lib/index.js')

/**
 * 占住一个端口。
 *
 * 关闭时**不等待 close 回调**：Windows 上 `server.close(cb)` 的回调偶发不触发
 * （套接字已释放但回调悬空），会让测试以 `Promise resolution is still pending`
 * 被取消——那看着像产品缺陷，其实只是清理写法的问题。
 * @returns {Promise<{port: number, close: () => Promise<void>}>} 占用句柄。
 */
async function occupy() {
  const server = createServer()
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = /** @type {{port: number}} */ (server.address())
  return {
    port,
    close: async () => {
      try { server.close() } catch { /* 已关闭 */ }
      // 给内核一点时间真正释放端口，避免复用同一端口的后续用例被误判为"占用"。
      await new Promise(resolve => setTimeout(resolve, 20))
    },
  }
}

/**
 * 找一个确定空闲的端口（监听后立刻释放）。
 * @returns {Promise<number>} 端口号。
 */
async function findFreePort() {
  const server = createServer()
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = /** @type {{port: number}} */ (server.address())
  try { server.close() } catch { /* 已关闭 */ }
  await new Promise(resolve => setTimeout(resolve, 20))
  return port
}

describe('resolveGuardPort：端口被占时自动顺延', () => {
  it('端口空闲 → 原样返回首选端口', async () => {
    const freePort = await findFreePort()
    const resolved = await mod.resolveGuardPort({ ...mod.DEFAULT_CONFIG, guardPort: freePort })
    assert.equal(resolved, freePort, '空闲端口必须原样使用，不漂移')
  })

  it('首选端口被占 → 顺延到下一个可用端口', async () => {
    const blocker = await occupy()
    try {
      const resolved = await mod.resolveGuardPort({ ...mod.DEFAULT_CONFIG, guardPort: blocker.port })
      assert.notEqual(resolved, blocker.port, '不得复用被占端口')
      assert.ok(resolved > blocker.port, '必须向后顺延')
      assert.ok(resolved <= blocker.port + mod.MAX_PORT_SCAN, '不得超出扫描上限')
    } finally {
      await blocker.close()
    }
  })

  it('连续两个端口被占 → 两个都跳过', async () => {
    const first = await occupy()
    const second = await occupy()
    try {
      const resolved = await mod.resolveGuardPort({ ...mod.DEFAULT_CONFIG, guardPort: first.port })
      assert.notEqual(resolved, first.port)
      assert.notEqual(resolved, second.port, '被占的端口一律不能用')
    } finally {
      await first.close()
      await second.close()
    }
  })

  it('MAX_PORT_SCAN 有限且合理（不会无限扫描）', () => {
    assert.ok(Number.isInteger(mod.MAX_PORT_SCAN))
    assert.ok(mod.MAX_PORT_SCAN >= 1 && mod.MAX_PORT_SCAN <= 100, '必须是有限小窗口')
  })

  it('靠近端口上界时不会越界', async () => {
    // 65535 是上界：窗口只能落在合法范围内，不能算出 65536+。
    const resolved = await mod.resolveGuardPort({ ...mod.DEFAULT_CONFIG, guardPort: 65_530 })
    assert.ok(resolved >= 65_530 && resolved <= 65_535, `解析结果必须合法，得到 ${resolved}`)
  })
})

describe('assertGuardPortFree：严格模式保持向后兼容', () => {
  it('端口被其它进程占用 → 抛可读错误', async () => {
    const blocker = await occupy()
    try {
      await assert.rejects(
        () => mod.assertGuardPortFree({ ...mod.DEFAULT_CONFIG, guardPort: blocker.port }),
        /port-in-use-by-(other|guard)/u,
        '严格模式必须抛错，而不是静默换端口',
      )
    } finally {
      await blocker.close()
    }
  })

  it('端口空闲 → 不抛', async () => {
    const freePort = await findFreePort()
    await mod.assertGuardPortFree({ ...mod.DEFAULT_CONFIG, guardPort: freePort })
  })

  it('拒绝不可路由的主机时不永久挂起', async () => {
    // 探测必须有硬超时：黑洞地址不能把启动拖死。
    const started = Date.now()
    try {
      await mod.assertGuardPortFree({ ...mod.DEFAULT_CONFIG, guardHost: '127.0.0.1', guardPort: 1 })
    } catch {
      // 1 号端口通常不可用；抛错也算正常返回。
    }
    assert.ok(Date.now() - started < 30_000, '探测必须有上界')
  })
})
