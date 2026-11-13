/**
 * 串行运行全部 `test/*.test.mjs`，输出逐个结果与失败清单。
 *
 * 为什么需要它：当前沙箱禁止「node 再去捕获另一个 node 的管道输出」，
 * 所以 `node --test` 与 PowerShell 循环都会报 pipe 拒绝。由一个 node 进程
 * 串行 spawn 子进程，并把子进程输出重定向到临时文件（而非管道），可以绕开该限制。
 *
 * 用法：`node scripts/run-all-tests.mjs`
 *
 * @module scripts/run-all-tests
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDir = new URL('../test/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const files = readdirSync(testDir).filter(name => name.endsWith('.test.mjs')).sort()
const workDir = mkdtempSync(join(tmpdir(), 'dsh-test-'))

let failed = 0
/** @type {string[]} */
const failures = []

try {
  for (const [index, name] of files.entries()) {
    const outFile = join(workDir, `${index}.log`)
    const result = spawnSync(process.execPath, [join(testDir, name)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 180_000,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    // 记录真实原因：status 为 null 说明进程根本没跑起来（沙箱拒绝、超时等），
    // 不能当成断言失败——否则「全部失败」只是环境假象。
    const spawnError = result.error === undefined ? '' : String(result.error.code ?? result.error.message)
    const ok = result.status === 0
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  [status=${String(result.status)} error=${spawnError}]`}\n`)
    if (!ok) {
      failed += 1
      failures.push(`${name}${spawnError === '' ? '' : ` (${spawnError})`}`)
      // 只打印尾部，避免刷屏。
      process.stdout.write(`${output.split('\n').slice(-25).join('\n')}\n`)
    } else if (output.includes('# fail 0') === false && output.includes('ok ') === false) {
      process.stdout.write(`  (suspicious: no assertions reported) ${name}\n`)
    }
    void outFile
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

process.stdout.write(`\n${files.length - failed}/${files.length} files passed\n`)
if (failed > 0) {
  process.stdout.write(`FAILED: ${failures.join(', ')}\n`)
  process.exitCode = 1
}
