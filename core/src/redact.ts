/**
 * 密钥掩码（0.2.6 / D-16）—— 远端写入 API Key 时的唯一脱敏入口。
 *
 * 为什么必须集中在一处：`credentials/set` 与 `settings/update` 的载荷里可能含
 * **明文 API Key**。这份载荷会流向三个不该出现密钥的地方：
 *
 * 1. **审批卡**（投给 owner 的 `hub/stream.*` 帧）—— owner 要看到「改了什么」，
 *    但**不需要**看到密钥全文；
 * 2. **审计日志**（越权尝试、写入成功）—— 日志永远不得含凭据；
 * 3. **诊断文件**（`host-status.json`、错误详情）—— 排障时会被截图外发。
 *
 * 所以规则是：四处都经过 {@link redactSecrets}，且**未知字段也按凭据处理** ——
 * 宁可多掩码一个字段，也不能漏掉一个密钥。掩码形状是
 * `sk-****8f2a`（保留可识别前缀与末 4 位），既能核对是不是同一把 key，
 * 又不足以还原。
 *
 * ## 判定一条「是不是密钥」的启发式
 *
 * - 字段名命中 {@link SECRET_FIELD_PATTERN}（key/token/secret/password/credential/authorization…）；
 * - 或者字段值是**明显的凭据形状**的长字符串（≥ 24 字符且无空白，例如 `sk-…`、`ghp_…`）。
 *
 * 对象/数组递归处理；深度上限 8、节点上限 2 000，防止恶意超大载荷拖垮审批路径。
 *
 * @module @core/redact
 */

/** 字段名命中即视为密钥（大小写不敏感）。 */
const SECRET_FIELD_PATTERN = /(api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|private[_-]?key|access[_-]?key)/iu

/**
 * 命中 {@link SECRET_FIELD_PATTERN} 但**其实是数值/计数**的字段名：不算密钥。
 *
 * 例如 `maxTokens` / `maxOutputTokens` / `tokenCount` 是模型参数，
 * 掩码它们会让审批卡显示成「maxTokens=[redacted]」，owner 反而看不出改了什么。
 */
const NON_SECRET_FIELD_PATTERN = /(max|min|limit|count|length|size|budget|cost|price|usage|total)[_-]?tokens?$/iu

/** 看起来像凭据的值：≥24 字符、无空白、含字母与数字。 */
const CREDENTIAL_SHAPE = /^(?=.*[A-Za-z])(?=.*\d)[\w.:/+=-]{24,}$/u

/** 掩码常量：完全隐藏时使用。 */
export const REDACTED = '[redacted]'

/**
 * 把一个密钥字符串掩码成 `前缀****末4位`。
 *
 * - 长度 < 12：完全隐藏为 `[redacted]`（太短，露出任何片段都可能有帮助）；
 * - 否则保留 `sk-` 这类可识别前缀（首个 `-` 之前，最多 6 字符）与末 4 位。
 *
 * @param value - 原始密钥。
 * @returns 掩码后的字符串。
 */
export function maskSecret(value: string): string {
  if (value.length < 12) return REDACTED
  const dash = value.indexOf('-')
  const prefix = dash > 0 && dash <= 6 ? value.slice(0, dash + 1) : ''
  // 末 4 位用 `slice(-4)` 取，若用 `length - 4` 做起点会退回空串（负起点 → 从头取）。
  const suffix = value.length >= 20 ? value.slice(-4) : ''
  return `${prefix}****${suffix}`
}

/** 判断一个字段名是否表示「密钥」。 */
function isSecretField(key: string): boolean {
  if (NON_SECRET_FIELD_PATTERN.test(key)) return false
  return SECRET_FIELD_PATTERN.test(key)
}

/** 判断一个字符串值是否「看起来就是凭据」。 */
function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_SHAPE.test(value)
}

/**
 * 深度掩码任意载荷。返回**新对象**，不修改入参。
 *
 * @param value - 任意 JSON 兼容载荷。
 * @returns 掩码后的副本。
 */
export function redactSecrets(value: unknown): unknown {
  let budget = 2_000
  const walk = (node: unknown, depth: number): unknown => {
    if (budget-- <= 0) return REDACTED
    if (typeof node === 'string') return looksLikeCredential(node) ? maskSecret(node) : node
    if (node === null || typeof node !== 'object') return node
    if (depth >= 8) return REDACTED
    if (Array.isArray(node)) return node.map(item => walk(item, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (isSecretField(key)) {
        // 字段名已经说明它是密钥：不管值长什么样都掩码（值是字符串才保留片段）。
        out[key] = typeof item === 'string' && item !== '' ? maskSecret(item) : REDACTED
        continue
      }
      out[key] = walk(item, depth + 1)
    }
    return out
  }
  return walk(value, 0)
}

/**
 * 从任意载荷里收集**明文密钥**，用于「下游是否泄露」的回归断言。
 *
 * @param value - 原始载荷。
 * @returns 载荷中出现的全部明文密钥字符串。
 */
export function collectSecretValues(value: unknown): string[] {
  const found: string[] = []
  let budget = 2_000
  const walk = (node: unknown, keyHint: string | null): void => {
    if (budget-- <= 0) return
    if (typeof node === 'string') {
      if ((keyHint !== null && isSecretField(keyHint)) || looksLikeCredential(node)) found.push(node)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyHint)
      return
    }
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) walk(item, key)
  }
  walk(value, null)
  return found
}

/**
 * 断言一段文本不含任何明文密钥（审计日志、诊断文件的最后一道闸）。
 *
 * @param text - 待检查文本。
 * @param secrets - 已知明文密钥。
 * @returns 未泄露时为 true。
 */
export function containsNoSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.every(secret => secret === '' || !text.includes(secret))
}
