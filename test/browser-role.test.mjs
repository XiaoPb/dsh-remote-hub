/**
 * 浏览器身份的角色映射。
 *
 * 曾经的缺陷：`browserAuthRoleOf` 写死 `accountId === 'acc_admin'`，
 * 于是**任何非内置账号**（子账号、自建管理员）在浏览器里都退化成
 * `read-only` —— `full` 专属能力（`directoryPicker/list` 等）被 policy
 * 以 `no-allow` 拒绝。用户看到的是「新建工作区」弹出
 * `remote access: directoryPicker/list: access denied (no-allow)`。
 *
 * 现在按账号自身的管理员标记判定。这里锁住该行为。
 *
 * @module test/browser-role.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const plugin = readFileSync(new URL('../host/src/plugin.ts', import.meta.url), 'utf8')

test('角色按账号的管理员标记判定，而不是硬编码 acc_admin', () => {
  const start = plugin.indexOf('const browserAuthRoleOf')
  assert.ok(start > 0, '必须存在 browserAuthRoleOf')

  const body = plugin.slice(start, start + 600)
  assert.match(body, /isAdminAccount/u, '必须查询账号的管理员标记')
  assert.match(body, /'full'/u, '管理员映射为 full')
  assert.match(body, /'read-only'/u, '非管理员映射为 read-only')

  // 反例：不能再只按 id 字面量判断。保留 acc_admin 只作为 auth 不可用时的
  // 兜底，且必须出现在 `??` 之后。
  assert.match(
    body,
    /isAdminAccount\?\.\(accountId\) \?\?/u,
    'acc_admin 只能作为兜底，不能作为唯一判据',
  )
})

test('认证服务提供同步的管理员查询', () => {
  const service = readFileSync(new URL('../host/src/auth/service.ts', import.meta.url), 'utf8')
  assert.match(service, /isAdminAccount\(accountId\)\s*\{/u, '实现必须存在')
  assert.match(service, /isAdminAccount\(accountId: string\): boolean/u, '接口必须声明')
  // fail-closed：账号不存在时不能当成管理员。
  const impl = service.slice(service.indexOf('isAdminAccount(accountId) {'))
  assert.match(impl.slice(0, 400), /account !== null/u, '账号不存在时必须显式排除')
})
