/**
 * Shared helpers for dsh-remote-hub acceptance scripts and node:test suites.
 *
 * Rules this file exists to enforce (see ROADMAP §4 and the team contract):
 *  - Every script that makes dynamic assertions must load `lib/index.js`
 *    (the built host entry). A missing artifact is a hard failure with the exact
 *    text `run pnpm build first` on stdout and a non-zero exit code.
 *  - A missing *individual* export is NOT a hard failure: scripts degrade to a
 *    static source-text assertion but STILL print the acceptance line.
 *  - No non-builtin npm packages, no real DSH runtime, no sockets.
 *  - Every script writes a grep-friendly `.log` file next to itself.
 *
 * @module scripts/_shared.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute repository root (two levels up from scripts/). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Paths that acceptance scripts read statically. */
export const PATHS = Object.freeze({
  lib: join(ROOT, 'lib', 'index.js'),
  packageJson: join(ROOT, 'package.json'),
  contractJson: join(ROOT, 'out', 'contract.json'),
  coreSrc: join(ROOT, 'core', 'src'),
  hostSrc: join(ROOT, 'host', 'src'),
  clientSrc: join(ROOT, 'client', 'src'),
  fenceSrc: join(ROOT, 'host', 'src', 'fence.ts'),
  approvalSrc: join(ROOT, 'host', 'src', 'approval-bridge.ts'),
  filesSrc: join(ROOT, 'host', 'src', 'files.ts'),
  guardSrc: join(ROOT, 'host', 'src', 'guard.ts'),
  streamsSrc: join(ROOT, 'host', 'src', 'streams.ts'),
  configSrc: join(ROOT, 'host', 'src', 'config.ts'),
  tokenSrc: join(ROOT, 'host', 'src', 'token.ts'),
  pairingSrc: join(ROOT, 'host', 'src', 'pairing.ts'),
  devicesSrc: join(ROOT, 'host', 'src', 'devices.ts'),
  capabilitiesSrc: join(ROOT, 'core', 'src', 'capabilities.ts'),
  redlinesSrc: join(ROOT, 'core', 'src', 'capabilities-redlines.ts'),
  protocolSrc: join(ROOT, 'core', 'src', 'protocol.ts'),
})

/** Read a UTF-8 text file, or '' when absent (static assertions degrade, never crash). */
export function readText(absPath) {
  try {
    return readFileSync(absPath, 'utf8')
  } catch {
    return ''
  }
}

/** Parsed package.json (always present in this repository). */
export function readPackage() {
  return JSON.parse(readText(PATHS.packageJson))
}

/** Recursively list files under a directory matching a suffix; [] when absent. */
export function listFiles(root, suffix = '.ts') {
  if (!existsSync(root)) return []
  const out = []
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (name.endsWith(suffix)) out.push(full)
    }
  }
  walk(root)
  return out
}

/** All first-party TypeScript source files (core + host + client). */
export function allSourceFiles() {
  return [
    ...listFiles(PATHS.coreSrc),
    ...listFiles(PATHS.hostSrc),
    ...listFiles(PATHS.clientSrc),
  ]
}

/** Concatenation of all first-party TypeScript sources, with relative path labels. */
export function allSourceText() {
  return allSourceFiles()
    .map(file => `// @file ${relative(ROOT, file)}\n${readText(file)}`)
    .join('\n')
}

/** True when the built host artifact is importable. */
export function hasLib() {
  return existsSync(PATHS.lib)
}

/**
 * Require the built host artifact or die with the exact mandated diagnostic.
 * Exits with code 1 — never throws a stack trace at the operator.
 */
export function requireLibOrExit() {
  if (hasLib()) return
  process.stdout.write('run pnpm build first\n')
  process.exit(1)
}

/**
 * Load `lib/index.js` as an ESM namespace.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadLib() {
  requireLibOrExit()
  // Relative to scripts/: ../lib/index.js. ESM memoises the namespace inside
  // one process; separate script processes each get their own import.
  return import('../lib/index.js')
}

/** Guard a callable export, returning undefined when the build lacks it. */
export function fn(mod, name) {
  return typeof mod?.[name] === 'function' ? mod[name] : undefined
}

/** Guard a constant export, returning `fallback` when the build lacks it. */
export function val(mod, name, fallback) {
  return mod?.[name] === undefined ? fallback : mod[name]
}

/**
 * Load lib when present, otherwise an empty object so scripts can degrade.
 * Note: this does NOT replace requireLibOrExit() for scripts that must fail
 * when the artifact is missing; those call it explicitly first.
 */
export async function tryLoadLib() {
  if (!hasLib()) return {}
  try {
    return await import('../lib/index.js')
  } catch {
    return {}
  }
}

/**
 * A tiny assertion collector: every printed `key: value` line must be backed
 * by at least one real check. `check(name, fn)` records pass/fail; `finish()`
 * prints collected lines and throws (exit 1) on the first failure.
 */
export function createReport(logFileName) {
  const lines = []
  const failures = []
  const logPath = logFileName ? join(ROOT, 'scripts', logFileName) : null

  return {
    /** Assert `condition` (or run `fn`); record the exact acceptance line. */
    check(line, conditionOrFn, detail = line) {
      let ok
      try {
        ok = typeof conditionOrFn === 'function' ? conditionOrFn() : conditionOrFn
      } catch (error) {
        ok = false
        detail = `${detail} :: ${error instanceof Error ? error.message : String(error)}`
      }
      if (!ok) failures.push(detail)
      lines.push(line)
      return Boolean(ok)
    },
    /** Add a line that has already been asserted via report.check(). */
    line(text) {
      lines.push(text)
    },
    /** Emit all lines to stdout and (optionally) the .log file. */
    finish() {
      const text = `${lines.join('\n')}\n`
      process.stdout.write(text)
      if (logPath) {
        mkdirSync(dirname(logPath), { recursive: true })
        writeFileSync(logPath, text, 'utf8')
      }
      if (failures.length > 0) {
        for (const failure of failures) {
          process.stderr.write(`assertion failed: ${failure}\n`)
        }
        process.exit(1)
      }
      return text
    },
    get lines() {
      return lines.slice()
    },
    get failures() {
      return failures.slice()
    },
  }
}

/**
 * Try importing a package by exact specifier. Returns the namespace or null.
 * Used to check whether `"ws"` is actually resolvable (a declared dependency
 * can still be missing from the install tree), without ever requiring it.
 */
export async function tryImport(specifier) {
  try {
    return await import(specifier)
  } catch {
    return null
  }
}

/** Write one JSON deliverable, creating parent directories. */
export function writeJson(absPath, value) {
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** sha256 hex of a string; used by purely-static fallback checks. */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Version gate: a minimal, self-contained `includePrerelease` semver comparator.
// ---------------------------------------------------------------------------

/**
 * Parse `major.minor.patch[-pre.identifiers]`.
 * @returns {{ nums: number[], pre: Array<string|number> } | null}
 */
export function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version)
  if (!match) return null
  const nums = [Number(match[1]), Number(match[2]), Number(match[3])]
  const pre = match[4] === undefined
    ? []
    : match[4].split('.').map(part => (/^\d+$/u.test(part) ? Number(part) : part))
  return { nums, pre }
}

/** Compare two parsed versions per semver §11 (prerelease < release). */
export function compareSemver(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.nums[index] !== b.nums[index]) return a.nums[index] < b.nums[index] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = typeof left === 'number'
    const rightNumeric = typeof right === 'number'
    if (leftNumeric && rightNumeric) return left < right ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return String(left) < String(right) ? -1 : 1
  }
  return 0
}

/**
 * Evaluate one comparator (`>=`, `>`, `<`, `<=`, `=`) with prerelease-aware
 * semantics. This is the `includePrerelease: true` behaviour: a prerelease is
 * compared against a prerelease bound from the same [major,minor,patch] tuple.
 */
export function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(comparator.trim())
  if (!match) throw new Error(`unsupported comparator: ${comparator}`)
  const left = parseSemver(version)
  const right = parseSemver(match[2])
  if (!left || !right) throw new Error(`unsupported version: ${version} / ${comparator}`)
  const cmp = compareSemver(left, right)
  switch (match[1] ?? '=') {
    case '>=': return cmp >= 0
    case '<=': return cmp <= 0
    case '>': return cmp > 0
    case '<': return cmp < 0
    default: return cmp === 0
  }
}

/** `semver.satisfies(range, { includePrerelease: true })` for a simple AND range. */
export function satisfiesRange(version, range) {
  return range.trim().split(/\s+/u).every(part => satisfiesComparator(version, part))
}

/** The exact four-item matrix from ROADMAP A0-2, as data (no hard-coded verdicts). */
export const VERSION_MATRIX = Object.freeze({
  '0.2.1-rc.2': true,
  '0.2.1-rc.5': true,
  '0.2.2-rc.1': true,
  '0.3.0-rc.1': false,
})

/** Compute the matrix line from `engines.dsh`; used by both the script and tests. */
export function versionMatrixLine(pkg = readPackage()) {
  const range = pkg?.engines?.dsh
  if (typeof range !== 'string') throw new Error('engines.dsh is missing')
  return Object.entries(VERSION_MATRIX)
    .map(([version]) => `${version}=${satisfiesRange(version, range) ? 'Y' : 'n'}`)
    .join(' ')
}
