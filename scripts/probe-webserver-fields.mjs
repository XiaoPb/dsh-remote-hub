/**
 * 探测官方 webServer 暴露的字段，找出自启动令牌放在哪。
 *
 * @module scripts/probe-webserver-fields
 */
import { readFileSync } from 'node:fs'

// 从浏览器端口拿不到，只能看 DSH 自己打印的 URL 与配置文件。
const log = readFileSync('dev/sandbox-webX.log', 'utf8')
const match = /token=([\w-]+)/u.exec(log)
console.log(JSON.stringify({
  tokenFound: match !== null,
  tokenPrefix: match === null ? null : `${match[1].slice(0, 6)}…`,
  tokenLength: match === null ? null : match[1].length,
}, null, 2))
