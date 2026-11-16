/**
 * P0 可行性探针：证明官方 Web 能在 `remote-device` 身份下渲染与取数。
 *
 * 这是方案 A（守卫托管浏览器）的**证伪闸门**。在真正实现反代之前，先用
 * 最小代价回答三个问题：
 *
 * 1. 官方 index + 静态资源能否被独立托管（不经 `:3080`）？
 * 2. `createPeer(remote-device)` 派发 `/api/*` 能否拿到真实数据？
 * 3. 官方客户端在非 `owner` 身份下有哪些 UI 会崩？
 *
 * 做法：本脚本起一个**独立探针端口**，把官方静态面反代出来，
 * 并把 `/api/*` 以 `remote-device` 身份派发，然后用真实浏览器打开看结果。
 *
 * 用法：`node scripts/probe-browser-mode.mjs [--port 8455]`
 *
 * @module scripts/probe-browser-mode
 */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const PROBE_PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 8455
const HOST_ORIGIN = process.env.HOST_ORIGIN ?? 'http://127.0.0.1:3091'

/** 远程浏览器标记（守卫正式实现时会注入同一份形状）。 */
const REMOTE_MARKER = '{"mode":"remote-browser"}'

/**
 * 反代一次请求到官方 Web 并原样回传。
 *
 * @param {import('node:http').IncomingMessage} req - 客户端请求。
 * @param {import('node:http').ServerResponse} res - 客户端响应。
 * @param {string} path - 上游路径（含 query）。
 */
function proxy(req, res, path) {
  const upstream = new URL(path, HOST_ORIGIN)
  const request = httpRequest(upstream, {
    method: req.method,
    headers: { ...req.headers, host: upstream.host },
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(res)
  })
  request.on('error', () => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('upstream unavailable')
  })
  req.pipe(request)
}

import { request as httpRequest } from 'node:http'

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PROBE_PORT}`)
  const path = url.pathname

  // 静态面：index 需要注入远程标记，其余原样反代。
  if (path === '/') {
    proxy(req, res, '/')
    return
  }
  if (path.startsWith('/assets/') || path.startsWith('/plugins/')
    || path === '/manifest.webmanifest' || path.startsWith('/favicon')) {
    proxy(req, res, `${path}${url.search}`)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('probe: not handled')
})

server.listen(PROBE_PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({
    probe: `http://127.0.0.1:${PROBE_PORT}`,
    hostOrigin: HOST_ORIGIN,
    marker: REMOTE_MARKER,
    note: '静态面探针；/api/* 需要走 createPeer 派发，见 probe-api-dispatch',
  }, null, 2))
})

process.on('SIGINT', () => { server.close(() => process.exit(0)) })
