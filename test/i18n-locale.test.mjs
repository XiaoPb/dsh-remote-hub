/**
 * i18n 契约测试：文案必须**跟随 DSH 语言**，而不是冻结在模块加载那一刻。
 *
 * 背景（真实缺陷，0.5.1 修复）：
 * - 旧实现只读一次 `document.documentElement.lang` / `navigator.language`，
 *   从不订阅宿主语言变化 → DSH 已切中文，账号页仍整屏英文；
 * - `label: t(...)`、`const ROLE_OPTIONS = [{ label: t(...) }]` 这类**注册期求值**
 *   还会把文案额外冻结一次，切语言后部分文案「半新半旧」。
 *
 * 这些测试锁死三件事：
 *  1. `attachLocaleService` 跟随 `ctx.locale` 快照，并在 subscribe 回调里推进；
 *  2. `setLocale` / `subscribeLocale` 的广播语义（只在真的变化时通知）；
 *  3. 源码里不再出现「模块顶层就把 `t()` 求值成常量」的写法。
 *
 * @module test/i18n-locale.test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'client', 'src')
const BUILD = join(ROOT, '.build', 'client', 'client', 'src')

/**
 * 加载编译后的 i18n 模块（`.build` 由 `pnpm build` 产出）。
 * @returns {Promise<Record<string, any>>} 命名空间。
 */
async function loadI18n() {
  const href = pathToFileURL(join(BUILD, 'rhui', 'i18n.js')).href
  return import(href)
}

/** 收集模块级 `t()` 常量（`const X = ... t(...)` 顶层求值）。 */
function topLevelFTConstants(text) {
  const offenders = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    // 只关心模块顶层（无缩进）的 const 声明。
    if (!/^const\s/u.test(line)) return
    if (!/\bt\(/u.test(line)) return
    offenders.push(`${index + 1}: ${line.trim()}`)
  })
  return offenders
}

describe('i18n：跟随 DSH locale 服务', () => {
  it('attachLocaleService 采纳 active 语言（zh* → zh-CN，其余 → en）', async () => {
    const i18n = await loadI18n()
    const listeners = []
    const service = {
      active: 'zh',
      getLocale() { return { active: this.active } },
      subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1) },
    }
    const dispose = i18n.attachLocaleService(service)
    try {
      assert.equal(i18n.getLocale(), 'zh-CN')
      assert.equal(i18n.t('loginSubmit'), '登录')

      // 宿主切英文：快照 + 通知 → 文案立即跟上。
      service.active = 'en'
      for (const fn of listeners) fn()
      assert.equal(i18n.getLocale(), 'en')
      assert.equal(i18n.t('loginSubmit'), 'Log in')

      // 繁体 / 其它中文变体也走中文。
      service.active = 'zh-Hant-TW'
      for (const fn of listeners) fn()
      assert.equal(i18n.getLocale(), 'zh-CN')

      // 非中文（日语等）走英文兜底。
      service.active = 'ja'
      for (const fn of listeners) fn()
      assert.equal(i18n.getLocale(), 'en')
    } finally {
      dispose()
    }
  })

  it('服务缺失时安静降级（不抛错、保持浏览器兜底）', async () => {
    const i18n = await loadI18n()
    const dispose = i18n.attachLocaleService(undefined)
    assert.equal(typeof dispose, 'function')
    dispose()
    // 仍然可以翻译（浏览器语言兜底，Node 下为 en）。
    assert.equal(typeof i18n.t('loginSubmit'), 'string')
  })

  it('subscribeLocale 只在文案集真的变化时通知', async () => {
    const i18n = await loadI18n()
    const calls = []
    const off = i18n.subscribeLocale(() => calls.push(i18n.getLocale()))
    try {
      i18n.setLocale('zh-CN')
      assert.deepEqual(calls, ['zh-CN'])
      i18n.setLocale('zh-CN') // 同值：不重复通知
      assert.deepEqual(calls, ['zh-CN'])
      i18n.setLocale('en')
      assert.deepEqual(calls, ['zh-CN', 'en'])
    } finally {
      off()
      i18n.setLocale('zh-CN')
    }
  })

  it('卸载后不再通知（无残留订阅）', async () => {
    const i18n = await loadI18n()
    const calls = []
    const off = i18n.subscribeLocale(() => calls.push(1))
    off()
    i18n.setLocale('en')
    i18n.setLocale('zh-CN')
    assert.deepEqual(calls, [])
  })

  it('可编程入口 __DSH_REMOTE_HUB_I18N__ 存在（打包后不被 tree-shake）', async () => {
    const i18n = await loadI18n()
    assert.equal(typeof globalThis.__DSH_REMOTE_HUB_I18N__, 'object')
    assert.equal(typeof i18n.setLocale, 'function')
  })
})

describe('i18n：源码不得冻结文案', () => {
  it('rhui/i18n.ts 与 format.ts 顶层没有 t() 常量', () => {
    for (const file of ['rhui/i18n.ts', 'rhui/format.ts']) {
      const text = readFileSync(join(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
      assert.deepEqual(topLevelFTConstants(text), [], `${file} 顶层出现 t() 常量`)
    }
  })

  it('format.ts 用函数暴露角色/错误文案（切语言不冻结）', () => {
    const text = readFileSync(join(SRC, 'rhui', 'format.ts'), 'utf8')
    assert.match(text, /export function roleOptions\(/u)
    assert.doesNotMatch(text, /export const ROLE_OPTIONS/u)
    assert.doesNotMatch(text, /export const AUTH_ERROR_TEXT/u)
  })

  it('槽位标签用惰性 thunk（label: () => t(...)），不用一次性字符串', () => {
    const text = readFileSync(join(SRC, 'plugin.ts'), 'utf8')
    // 只取 slots.register({...}) 里的 label，避免命中无关的 `label: target.deviceLabel`
    const registerBlocks = [...text.matchAll(/slots\.register\(\s*\{([\s\S]*?)\}/gu)].map(match => match[1])
    assert.ok(registerBlocks.length >= 2, `期望至少 2 个槽位注册，实际 ${registerBlocks.length}`)
    let checked = 0
    for (const block of registerBlocks) {
      const label = /label:\s*([^,\n]+)/u.exec(block)
      if (label === null) continue
      checked += 1
      assert.match(label[1].trim(), /^\(\)\s*=>\s*t\(/u, `槽位 label 必须是惰性 thunk：${label[1]}`)
    }
    assert.ok(checked >= 2, `期望至少 2 个带 label 的槽位，实际 ${checked}`)
  })

  it('i18n 不再把 <html lang> / navigator 当唯一真源', () => {
    const text = readFileSync(join(SRC, 'rhui', 'i18n.ts'), 'utf8')
    // `<html lang>` 只能作为**没有 DSH 服务**时的兜底，不能是主路径。
    assert.match(text, /export function attachLocaleService/u)
    assert.match(text, /ctx\.locale|locale 服务/u)
  })
})
