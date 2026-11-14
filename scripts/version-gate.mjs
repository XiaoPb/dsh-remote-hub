/**
 * A0-2 compatibility gate.
 *
 * Implements `semver.satisfies(range, { includePrerelease: true })` for the
 * plugin's AND range with a small self-contained prerelease comparator (no npm
 * dependency). The assertions read ONLY `package.json`; the `lib/index.js`
 * presence check is the uniform acceptance-script precondition.
 *
 * Acceptance (ROADMAP §4.1):
 *   node scripts/version-gate.mjs | grep -qx '0.2.2-rc.1=Y 0.2.2-rc.3=Y 0.3.0-rc.1=n'
 */
import {
  VERSION_MATRIX,
  createReport,
  readPackage,
  requireLibOrExit,
  satisfiesComparator,
  satisfiesRange,
  versionMatrixLine,
} from './_shared.mjs'

// Uniform acceptance-script rule: a missing host artifact is a hard failure
// with the exact diagnostic, not a cryptic ESM resolution error.
// The assertions themselves read package.json only (A0-2: engines.dsh is the
// single field the gate reads).
requireLibOrExit()

const pkg = readPackage()
const report = createReport('version-gate.log')
const range = pkg.engines?.dsh

// The one mandated matrix line. Each verdict is computed, not hard-coded.
const expected = Object.entries(VERSION_MATRIX)
  .map(([version, want]) => `${version}=${want ? 'Y' : 'n'}`)
  .join(' ')
report.check(
  versionMatrixLine(pkg),
  () => {
    if (typeof range !== 'string') return false
    // Independently verify comparator semantics, including the prerelease
    // ordering that a naive string/numeric compare would get wrong.
    for (const [version, want] of Object.entries(VERSION_MATRIX)) {
      if (satisfiesRange(version, range) !== want) return false
    }
    return satisfiesComparator('0.2.2-rc.1', '>=0.2.2-rc.1')
      && !satisfiesComparator('0.2.1-rc.5', '>=0.2.2-rc.1')
      && satisfiesComparator('0.2.2-rc.10', '>=0.2.2-rc.1')
      && !satisfiesComparator('0.3.0-rc.1', '<0.3.0-0')
      && satisfiesComparator('0.2.9', '<0.3.0-0')
  },
  `matrix must be exactly "${expected}"`,
)

report.check('node-engine: ok', () => pkg.engines?.node === '>=24.9.0', 'engines.node must be >=24.9.0')
report.check('manifest-version: 1', () => pkg.dsh?.manifestVersion === 1, 'dsh.manifestVersion must be 1')
report.check(
  'upper-bound: present',
  () => typeof range === 'string'
    && range.includes('<0.3.0-0')
    && !satisfiesRange('0.3.0-rc.1', range)
    && pkg.dsh?.compatibility?.dsh === range
    && Object.prototype.hasOwnProperty.call(pkg.dsh?.compatibility?.dshReleases ?? {}, '0.2.2-rc.1'),
  'engines.dsh must carry the <0.3.0-0 upper bound; compatibility.dsh must match; dshReleases must include 0.2.2-rc.1',
)

report.finish()
