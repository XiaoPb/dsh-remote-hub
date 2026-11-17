/**
 * 验证：DSH「设置 → 通用 → 语言」切换**驱动账号页文案**（i18n 接入的核心验收）。
 *
 * 步骤：
 *  1. 记录当前（zh）账号页文案；
 *  2. 在 DSH 设置里把语言切成 English；
 *  3. **不刷新页面**回到账号页，看文案是否变英文；
 *  4. 切回中文，再看是否变回中文；
 *  5. 额外记录 `__DSH_REMOTE_HUB_I18N__` 是否暴露（可编程切换入口）。
 *
 * @module scripts/ui-acceptance-locale
 */
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { ROOT } from './_shared.mjs'
import { launchBrowser, attachFirstPage } from './ui-acceptance-boot.mjs'
import { sleep } from './ui-acceptance-cdp.mjs'

const OUT = join(ROOT, 'dev', 'ui-acceptance')
const token = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(join(OUT, 'sandbox.log'), 'utf8'))[1]
await launchBrowser(`http://127.0.0.1:13091/?token=${token}`)
const page = await attachFirstPage()
await page.waitFor('document.querySelector(\'button[aria-label="账号菜单"],button[aria-label="Account menu"]\') !== null', { timeout: 60_000 })

/** 打开设置（兼容中英两种界面文案）。 */
async function openSettings() {
  await page.call(async () => {
    const sleepMs = ms => new Promise(r => setTimeout(r, ms))
    const menu = [...document.querySelectorAll('button')]
      .find(b => /账号菜单|Account menu/.test(b.getAttribute('aria-label') ?? ''))
    menu?.click(); await sleepMs(800)
    const entries = [...document.querySelectorAll('[role=menuitem],button,a')]
    const settings = entries.find(e => /^(设置|Settings)$/.test(
      ((e.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0]) ?? ''))
    settings?.click(); await sleepMs(2000)
  })
}

/** 打开「通用设置 / General」tab。 */
async function openGeneral() {
  await page.call(async () => {
    const sleepMs = ms => new Promise(r => setTimeout(r, ms))
    const tab = [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
      .find(e => /^(通用设置|General)$/i.test(((e.innerText || '').split('\n')[0] ?? '').trim()))
    tab?.click(); await sleepMs(1600)
  })
}

/** 打开账号页 tab（不刷新页面）。 */
async function openAccountTab() {
  const clicked = await page.call(async () => {
    const sleepMs = ms => new Promise(r => setTimeout(r, ms))
    const tab = [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
      .find(e => /登录与账号|Login & Account/i.test((e.innerText || '').trim()))
    if (tab === undefined) return false
    tab.click(); await sleepMs(1500)
    return true
  })
  if (!clicked) throw new Error('account settings tab not found')
  await sleep(600)
}

/** 读账号页文案快照（含槽位标签：侧栏行 + 设置导航）。 */
function readAccount() {
  return page.eval(`(() => {
    const root = document.querySelector('[data-testid="account-page"]')
    if (root === null) return null
    const tabTexts = [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
      .map(e => (e.innerText || '').trim().split('\\n')[0]).filter(Boolean)
    return {
      htmlLang: document.documentElement.lang,
      phase: root.getAttribute('data-phase'),
      title: (document.querySelector('[data-testid=account-title]')?.innerText || '').trim(),
      submit: (document.querySelector('[data-testid=login-submit]')?.innerText || '').trim(),
      labels: [...root.querySelectorAll('.rh-field-label')].map(e => (e.innerText || '').trim()),
      eye: document.querySelector('.rh-eye')?.getAttribute('aria-label') ?? null,
      steps: (document.querySelector('[data-testid=account-steps]')?.innerText || '').replace(/\\s+/g, ' ').trim(),
      sidebarHub: [...document.querySelectorAll('[data-slot="sidebar.panellist"] *')]
        .map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 4),
      settingsTab: tabTexts.find(t => /登录与账号|Login & account/i.test(t)) ?? null,
    }
  })()`)
}

/**
 * 在「语言」行里选出目标语言。
 *
 * ⚠️ 语言行是官方 settings 的 `[aria-haspopup="menu"]` 按钮，**紧跟在「语言」
 * 标签之后**。不能靠「往上找祖先再 querySelectorAll」——向上 2–3 层会罩住整块
 * 通用设置表单，第一个命中的是上一行「权限」的下拉框（实测踩过）。
 * 正确做法：从标签出发取它的行容器，再按文档顺序取**该行之后第一个**
 * `[aria-haspopup]` 控件。
 * @param {string} wanted - 目标显示名（如 `English` / `中文`）。
 * @returns {Promise<{switched: boolean, options: string[], comboText?: string}>}
 */
function pickLanguage(wanted) {
  return page.eval(`(async () => {
    const sleepMs = ms => new Promise(r => setTimeout(r, ms))
    const wanted = ${JSON.stringify(wanted)}
    const label = [...document.querySelectorAll('*')]
      .find(e => e.children.length === 0 && /^(语言|Language)$/u.test((e.textContent ?? '').trim()))
    if (label === undefined) return { switched: false, options: [], why: 'no language label' }

    // 标签自身所在行：取「不越出行」的最小容器。
    const labelRow = label.parentElement ?? label
    // 按文档顺序，找标签行内 / 紧随其后的第一个下拉控件。
    const all = [...document.querySelectorAll('[aria-haspopup],[role=combobox],select')]
    const following = all.filter(el => labelRow.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    const combo = following[0]
    if (combo === undefined) return { switched: false, options: [], why: 'no combo after label' }
    const comboText = (combo.innerText || '').trim()
    combo.click(); await sleepMs(1000)

    // 菜单项：浮层里精确文本匹配（菜单项常带 role=menuitem）。
    const items = [...document.querySelectorAll('[role=menuitem],[role=option],[role=menuitemradio],li,button')]
      .filter(el => (el.innerText || '').trim() === wanted && el.getClientRects().length > 0)
    const seen = [...new Set([...document.querySelectorAll('[role=menuitem],[role=option]')]
      .map(el => (el.innerText || '').trim()).filter(Boolean))]
    if (items.length === 0) {
      // 收起菜单，避免残留浮层影响后续步骤。
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return { switched: false, options: seen, why: 'option not found', comboText }
    }
    items.at(-1).click(); await sleepMs(2400)
    return { switched: true, options: seen, comboText }
  })()`)
}

const report = {}

await openSettings()
await openGeneral()
await openAccountTab()
report.zhBefore = await readAccount()

// 切英文
await openGeneral()
report.englishPick = await pickLanguage('English')
await sleep(1200)
await openAccountTab()
report.afterEnglish = await readAccount()
await page.screenshot(join(OUT, 'locale-02-en.png'))

// 切回中文（先回通用设置再切，避免在账号页上读标签时设置导航还没刷新）
await openGeneral()
report.chinesePick = await pickLanguage('中文')
await sleep(1500)
await openAccountTab()
await sleep(1200)
report.afterChinese = await readAccount()
// 槽位标签由 subscribeLocale 重建导航槽位（React 调度是异步的）：
// 明确等「标签真的变了」再记账，而不是当场读一次就下结论。
for (let i = 0; i < 20; i += 1) {
  const tab = await page.eval(`(() => {
    const t = [...document.querySelectorAll('[role=tab],button,a,[role=menuitem]')]
      .map(e => (e.innerText || '').trim().split('\\n')[0])
    return t.find(x => /登录与账号|Login & account/i.test(x)) ?? null
  })()`)
  if (tab === '登录与账号') break
  await sleep(400)
}
report.afterChineseStable = await readAccount()
await page.screenshot(join(OUT, 'locale-03-zh.png'))

// 可编程入口是否存在（验收文档 I-2 依赖它）
report.programmaticHook = await page.eval(`typeof globalThis.__DSH_REMOTE_HUB_I18N__`)

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
writeFileSync(join(OUT, 'locale-report.json'), JSON.stringify(report, null, 2))
page.close()
