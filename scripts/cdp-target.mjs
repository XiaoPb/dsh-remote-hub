/** Select exactly one browser page target; never guess when multiple tabs exist. */
export function selectPageTarget(targets, selector) {
  const pages = targets.filter(target => target.type === 'page')
  if (selector !== undefined) {
    const selectorLabel = pages.some(target => target.url === selector)
      || /^https?:\/\//u.test(selector)
      ? safeTargetUrl(selector)
      : selector
    const exact = pages.filter(target => target.id === selector || target.url === selector)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) throw new Error(`CDP target selector is ambiguous: ${selectorLabel}`)
    throw new Error(`CDP target not found: ${selectorLabel}`)
  }
  if (pages.length === 1) return pages[0]
  if (pages.length === 0) throw new Error('no page target; open a tab first')
  const summary = pages.map(target => `${target.id} ${safeTargetUrl(target.url)}`).join('\n')
  throw new Error(`multiple page targets; pass --target <id|exact-url>:\n${summary}`)
}

export function safeTargetUrl(value) {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '<invalid-url>'
  }
}
