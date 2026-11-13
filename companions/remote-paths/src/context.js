export function cloudPathContext(globalObject = globalThis) {
  const carrier = globalObject.__DSH_REMOTE_HUB_CARRIER__
  const transport = globalObject.__DSH_TRANSPORT__
  if (carrier?.active !== true || typeof transport?.fetch !== 'function' || !transport.streamBaseUrl) return null
  return { origin: transport.streamBaseUrl, fetch: transport.fetch }
}

export async function pathRpc(context, method, args, signal) {
  if (!['directoryPicker/list', 'directoryPicker/createDirectory', 'workspaceFiles/list'].includes(method)) throw new Error('Unsupported remote path operation')
  const response = await context.fetch(`api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ type: 'client-request', rpcId: `paths-${globalThis.crypto.randomUUID()}`, method, payload: { args } }),
  })
  if (!response.ok) throw new Error(`目标主机返回 HTTP ${response.status}`)
  const message = await response.json()
  if (message.result?.ok !== true) {
    const error = message.result?.error
    throw new Error(error?.code === 'remote-access/denied'
      ? '当前配对没有浏览或新建目录权限，请使用完全控制配对。'
      : error?.message ?? '目标主机没有返回有效的目录结果')
  }
  return message.result.value
}
