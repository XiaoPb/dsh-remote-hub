/**
 * 按正确顺序构建全部产物。
 *
 * 顺序很重要：`lib/client.js` 的 banner 会内联 `lib/carrier-boot.js` 的内容，
 * 所以 carrier-boot 必须**先**产出，client 最后。
 *
 * 用法：`node scripts/build.mjs`
 *
 * @module scripts/build
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * 跑一条命令。
 * @param {string} label - 日志标签。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 */
function run(label, command, args) {
  process.stdout.write(`== ${label} ==\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stderr.write(`FAILED: ${label} (exit ${String(result.status)})\n`)
    process.exit(result.status ?? 1)
  }
}

const tsc = 'node_modules/typescript/bin/tsc'
const tsdown = 'node_modules/tsdown/dist/run.mjs'

run('clean', process.execPath, ['-e', "const fs=require('node:fs');for(const p of ['lib','.build'])fs.rmSync(p,{recursive:true,force:true})"])
run('tsc host', process.execPath, [tsc, '-p', 'tsconfig.build.host.json'])
run('tsc client', process.execPath, [tsc, '-p', 'tsconfig.build.client.json'])
run('tsc types', process.execPath, [tsc, '-p', 'tsconfig.types.json'])
run('tsdown host', process.execPath, [tsdown, '--filter', 'dsh-remote-hub/lib'])
run('tsdown carrier-boot', process.execPath, [tsdown, '--filter', 'dsh-remote-hub/carrier-boot'])
if (!existsSync(`${root}lib/carrier-boot.js`)) {
  process.stderr.write('FAILED: lib/carrier-boot.js missing after carrier build\n')
  process.exit(1)
}
run('tsdown client', process.execPath, [tsdown, '--filter', 'dsh-remote-hub/client'])

process.stdout.write('build complete\n')
