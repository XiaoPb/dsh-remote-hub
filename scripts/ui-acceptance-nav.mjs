/**
 * 导航到「登录与账号」页并等待指定 phase。
 *
 * @module scripts/ui-acceptance-nav
 */
import { sleep } from './ui-acceptance-cdp.mjs'

/**
 * 打开设置 → 登录与账号，等到 `data-testid="account-page"` 出现。
 *
 * @param {object} page - page 驱动。
 * @param {{timeout?: number}} [options] - 选项。
 * @returns {Promise<{phase: string|null}>} 当前 phase。
 */
export async function gotoAccountPage(page, { timeout = 40_000 } = {}) {
  const started = Date.now()
  // 1) 打开设置（账号菜单 → 设置）。若设置已开着就跳过。
  const settingsOpen = await page.eval('document.querySelector(\'[data-testid="account-page"]\') !== null')
  if (!settingsOpen) {
    await page.call(async () => {
      const sleepMs = ms => new Promise(r => setTimeout(r, ms))
      const menu = [...document.querySelectorAll('button')].find(b => /账号菜单|account menu/i.test(b.getAttribute('aria-label') ?? ''))
      menu?.click()
      await sleepMs(700)
      const entries = [...document.querySelectorAll('[role=menuitem],button,a')]
      const settings = entries.find(e => /^设置$|^Settings$/i.test((e.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] ?? ''))
      settings?.click()
      await sleepMs(1800)
    })
  }

  // 2) 点开「登录与账号」tab。
  const tabClicked = await page.call(async () => {
    const sleepMs = ms => new Promise(r => setTimeout(r, ms))
    const find = () => [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
      .find(e => /登录与账号/.test((e.innerText || '').trim()))
    let tab = find()
    if (tab === undefined) {
      // 设置弹窗有时以左侧分组列表呈现：先尝试点「账号」分组。
      const group = [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
        .find(e => /^账号$|^Account$/i.test((e.innerText || '').trim()))
      group?.click()
      await sleepMs(800)
      tab = find()
    }
    if (tab === undefined) return false
    tab.click()
    await sleepMs(1200)
    return true
  })

  if (!tabClicked) throw new Error('settings tab 「登录与账号」not found')

  // 3) 等页面出现。
  while (Date.now() - started < timeout) {
    const phase = await page.eval('document.querySelector(\'[data-testid="account-page"]\')?.getAttribute("data-phase") ?? null')
    if (phase !== null) return { phase }
    await sleep(300)
  }
  throw new Error('account page did not appear')
}

/**
 * 等 phase 变成期望值。
 * @param {object} page - page 驱动。
 * @param {string} phase - 期望 phase。
 * @param {number} [timeout] - 超时。
 */
export async function waitPhase(page, phase, timeout = 40_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const current = await page.eval('document.querySelector(\'[data-testid="account-page"]\')?.getAttribute("data-phase") ?? null')
    if (current === phase) return current
    await sleep(300)
  }
  const current = await page.eval('document.querySelector(\'[data-testid="account-page"]\')?.getAttribute("data-phase") ?? null')
  throw new Error(`phase did not become "${phase}" (now "${current}")`)
}
