/**
 * 深色（与浅色）外观下的**全量文字对比度审计**。
 *
 * 为什么单独写：只看 `color` 会不会「接近黑色」是不够的——
 *  - 步骤条当前项的序号是**深色字配浅色底**（`--rh-strong` / `--rh-strong-fg`），
 *    在深色主题下这是正确设计，只看字色会误判成缺陷；
 *  - 反过来，半透明背景（`rgba(16,185,129,.18)`）若直接当纯色算，也会算错。
 *
 * 正确做法：对每个「直接包含文本」的叶子节点，
 *  1. 取文字色（含 alpha）；
 *  2. 沿祖先找第一个**不透明**背景，中间遇到的半透明背景按 over 逐层合成；
 *  3. 用 WCAG 公式算对比度，并按字号判断阈值（普通 4.5、大字 3.0）。
 *
 * @module scripts/ui-acceptance-contrast-audit
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './_shared.mjs'
import { openPage, sleep, contrastRatio } from './ui-acceptance-cdp.mjs'

const OUT = join(ROOT, 'dev', 'ui-acceptance')
mkdirSync(OUT, { recursive: true })

/** 页内执行的审计脚本（纯函数，返回所有文字叶子的对比度记录）。 */
const AUDIT = `(() => {
  const parse = css => {
    const m = /rgba?\\(([^)]+)\\)/.exec(css)
    if (m === null) return [0, 0, 0, 1]
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number)
    return [p[0], p[1], p[2], p[3] ?? 1]
  }
  const over = (top, bottom) => [0,1,2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1)
  const root = document.querySelector('[data-testid="account-page"]')
  if (root === null) return { error: 'no account page' }

  /** 从节点向上合成背景，直到遇到不透明色。 */
  const effectiveBg = el => {
    const layers = []
    let node = el
    let bg = null
    while (node !== null) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (c[3] > 0.99) { bg = c; break }
      if (c[3] > 0.01) layers.push(c)
      node = node.parentElement
    }
    if (bg === null) bg = parse(getComputedStyle(document.documentElement).backgroundColor || 'rgb(255,255,255)')
    if (bg[3] < 0.99) bg = [255, 255, 255, 1]
    // 自下而上合成
    let out = bg
    for (const layer of layers.reverse()) out = over(layer, out)
    return out
  }

  const results = []
  const walk = el => {
    for (const child of el.children) {
      const rect = child.getBoundingClientRect()
      const cs = getComputedStyle(child)
      const visible = rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
      const text = [...child.childNodes]
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join(' ')
        .trim()
      if (visible && text !== '') {
        const bg = effectiveBg(child)
        const fgRaw = parse(cs.color)
        const fg = over(fgRaw, bg)
        const fontSize = Number.parseFloat(cs.fontSize)
        const bold = Number(cs.fontWeight) >= 700
        // WCAG 大字：≥24px，或 ≥18.66px 且加粗
        const large = fontSize >= 24 || (fontSize >= 18.66 && bold)
        results.push({
          tag: child.tagName.toLowerCase(),
          cls: (String(child.className) || '').slice(0, 40),
          testId: child.getAttribute('data-testid'),
          text: text.slice(0, 40),
          color: cs.color,
          bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')',
          fg: fg.slice(0, 3),
          bgc: bg.slice(0, 3),
          fontSize,
          bold,
          large,
          threshold: large ? 3 : 4.5,
          opacity: cs.opacity,
        })
      }
      walk(child)
    }
  }
  walk(root)
  return { results }
})()`

/**
 * 审计某一主题模式。
 * @param {object} page - page 驱动。
 * @param {'light'|'dark'} mode - 主题。
 * @returns {Promise<object>} 汇总。
 */
export async function auditMode(page, mode) {
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode }] })
  // ⚠️ 必须等**这一帧**真的重算完：只 sleep 会在慢机器上读到上一主题的合成值
  // （实测：先跑 dark 再跑 light 时，light 读到的是深色底 → 假失败一大片）。
  // 这里以「页面根的 --rh-bg 已等于该主题的期望底色」为收敛条件。
  const expectedBg = mode === 'dark' ? 'rgb(23, 25, 29)' : null
  const started = Date.now()
  while (Date.now() - started < 15_000) {
    const bg = await page.eval(`(() => {
      const root = document.querySelector('[data-testid="account-page"]')
      return root === null ? null : getComputedStyle(root).backgroundColor
    })()`).catch(() => null)
    // 深色固定检查；浅色则要求与深色不同（宿主可能给别的浅色）
    if (expectedBg !== null ? bg === expectedBg : (bg !== null && bg !== 'rgb(23, 25, 29)' && bg !== 'rgb(35, 35, 36)')) {
      break
    }
    await sleep(200)
  }
  await sleep(600)
  const data = await page.eval(AUDIT)
  if (data?.error !== undefined) return { error: data.error, mode }
  const rows = []
  for (const item of data.results) {
    const ratio = Math.round(contrastRatio(item.fg, item.bgc) * 100) / 100
    rows.push({ ...item, ratio, pass: ratio >= item.threshold })
  }
  const failures = rows.filter(r => r.pass === false).sort((a, b) => a.ratio - b.ratio)
  await page.cdp.send('Emulation.setEmulatedMedia', { features: [] })
  return {
    mode,
    total: rows.length,
    pass: rows.length - failures.length,
    fail: failures.length,
    failures,
    // 最差的 5 个（即使通过，也便于看余量）
    worst: rows.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 5).map(r => ({ ratio: r.ratio, cls: r.cls, text: r.text, color: r.color, bg: r.bg })),
  }
}

const [, , devtoolsPort, pageIdPrefix] = process.argv
if (devtoolsPort !== undefined) {
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()
  const target = targets.find(item => item.type === 'page' && (pageIdPrefix === undefined || item.id.startsWith(pageIdPrefix)))
  const page = await openPage(target.webSocketDebuggerUrl)
  const out = { light: await auditMode(page, 'light'), dark: await auditMode(page, 'dark') }
  writeFileSync(join(OUT, 'contrast-audit.json'), JSON.stringify(out, null, 2))
  for (const mode of ['light', 'dark']) {
    const m = out[mode]
    process.stdout.write(`\n=== ${mode} === total=${m.total} pass=${m.pass} fail=${m.fail}\n`)
    for (const f of m.failures.slice(0, 25)) {
      process.stdout.write(`  ${String(f.ratio).padStart(5)} (<${f.threshold}) ${f.tag}.${f.cls.padEnd(30)} "${f.text}" color=${f.color} bg=${f.bg}\n`)
    }
    process.stdout.write(`  worst: ${JSON.stringify(m.worst.slice(0, 3))}\n`)
  }
  page.close()
}
