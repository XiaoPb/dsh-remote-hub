/**
 * 测试进程级 `@core/*` 别名解析（由测试文件的 module.register 装载，
 * 亦可直接 import 后调用 registerAlias()）。
 * @module test/panel-alias-loader.mjs
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@core/')) {
    // host 侧构建产物在 .build/host/core；client 侧在 .build/client/core。
    // 两者内容一致（同一 core 源），任选其一即可——按调用方 URL 就近解析。
    const base = context.parentURL?.includes('/.build/host/') ?? false
      ? '../.build/host/core/src/'
      : '../.build/client/core/src/'
    return next(new URL(`${base}${specifier.slice(6)}`, import.meta.url).href, context)
  }
  return next(specifier, context)
}

/** 在当前进程注册本 loader（测试文件顶层 await 调用）。 */
export async function registerAlias() {
  try {
    const { register } = await import('node:module')
    register('./panel-alias-loader.mjs', import.meta.url)
  } catch { /* 无 register 环境跳过 */ }
}
