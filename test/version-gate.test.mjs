import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  VERSION_MATRIX,
  satisfiesComparator,
  satisfiesRange,
} from '../scripts/_shared.mjs'
import { readPackage, versionMatrixLine } from './_helpers.mjs'

const pkg = readPackage()
const range = pkg.engines?.dsh

test('version gate: four-item matrix with includePrerelease semantics', () => {
  assert.equal(typeof range, 'string')
  const expected = Object.entries(VERSION_MATRIX)
    .map(([version, want]) => `${version}=${want ? 'Y' : 'n'}`)
    .join(' ')
  assert.equal(versionMatrixLine(pkg), expected)
  assert.equal(versionMatrixLine(pkg), '0.2.1-rc.2=Y 0.2.1-rc.5=Y 0.2.2-rc.1=Y 0.3.0-rc.1=n')
})

test('version gate: comparator ordering is prerelease-aware', () => {
  assert.equal(satisfiesRange('0.2.1-rc.2', range), true)
  assert.equal(satisfiesRange('0.2.1-rc.5', range), true)
  assert.equal(satisfiesRange('0.2.2-rc.1', range), true)
  assert.equal(satisfiesRange('0.3.0-rc.1', range), false)
  assert.equal(satisfiesComparator('0.2.1-rc.2', '>=0.2.1-rc.2'), true)
  assert.equal(satisfiesComparator('0.2.1-rc.1', '>=0.2.1-rc.2'), false)
  assert.equal(satisfiesComparator('0.2.1-rc.10', '>=0.2.1-rc.5'), true)
  assert.equal(satisfiesComparator('0.2.1', '>=0.2.1-rc.2'), true)
  assert.equal(satisfiesComparator('0.3.0-rc.1', '<0.3.0-0'), false)
  assert.equal(satisfiesComparator('0.2.9', '<0.3.0-0'), true)
  assert.equal(satisfiesRange('0.3.0', range), false)
})

test('version gate: engines.node, manifestVersion, upper bound, dshReleases', () => {
  assert.equal(pkg.engines.node, '>=24.9.0')
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.equal(range.includes('<0.3.0-0'), true)
  assert.equal(pkg.dsh.compatibility.dsh, range)
  for (const release of ['0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-rc.1']) {
    assert.equal(pkg.dsh.compatibility.dshReleases[release], 'compatible')
  }
})

test('version gate: dropping the upper bound would widen the gate (regression guard)', () => {
  const widened = '>=0.2.1-rc.2'
  assert.equal(satisfiesRange('0.3.0-rc.1', widened), true)
  assert.equal(satisfiesRange('0.3.0-rc.1', range), false,
    'the <0.3.0-0 upper bound must reject 0.3.0 prereleases')
})
