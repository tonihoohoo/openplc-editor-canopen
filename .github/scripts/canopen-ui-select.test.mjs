// node --test .github/scripts/canopen-ui-select.test.mjs (from the repository root)
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { choose, readSpecs } from './canopen-ui-select.mjs'

const C = 'src/frontend/components/_features/[workspace]/editor/device/canopen/'
const S = 'src/frontend/components/_features/[workspace]/editor/server/canopen-slave/'
const spec = (name, covers, helpers = [], text = '') => ({
  spec: `e2e/canopen-${name}.spec.ts`,
  covers,
  helpers: ['e2e/helpers/canopen-project', ...helpers],
  text,
})
const SPECS = [
  spec('online', [`${C}online-tab.tsx`], ['e2e/helpers/canopen-runtime']),
  spec('lss', [`${C}lss-panel.tsx`, 'src/middleware/shared/utils/canopen/diagnostics/**'], [], "'canopen-lss'"),
  spec('offline-build', []),
  spec('slave-build', [`${S}data-tab.tsx`], [], "'generic-io-module.eds'"),
  spec('slave-online', [], ['e2e/helpers/canopen-runtime']),
]
const names = (set) => [...set].map((s) => s.replace(/^e2e\/canopen-|\.spec\.ts$/g, '')).sort()
const run = (files, shared = new Set()) => names(choose(files, SPECS, shared))

test('a listed master file runs only the specs that list it', () => {
  assert.deepEqual(run([`${C}lss-panel.tsx`]), ['lss'])
})

test('a folder pattern covers the files under it', () => {
  assert.deepEqual(run(['src/middleware/shared/utils/canopen/diagnostics/texts.ts']), ['lss'])
})

test('an unlisted master file runs every master spec', () => {
  assert.deepEqual(run([`${C}node-panel.tsx`]), ['lss', 'offline-build', 'online'])
})

test('a slave page file runs the slave specs that list it', () => {
  assert.deepEqual(run([`${S}data-tab.tsx`]), ['slave-build'])
})

test('a file the slave code imports and only a master spec lists runs that spec and every slave spec', () => {
  assert.deepEqual(run([`${C}online-tab.tsx`], new Set([`${C}online-tab.tsx`])), [
    'online',
    'slave-build',
    'slave-online',
  ])
})

test('a baseline image runs its spec', () => {
  assert.deepEqual(run(['e2e/canopen-slave-build.spec.ts-snapshots/slave-data-chromium-linux.png']), ['slave-build'])
})

test('a helper runs the specs that import it', () => {
  assert.deepEqual(run(['e2e/helpers/canopen-runtime.ts']), ['online', 'slave-online'])
})

test('a helper no spec imports by name runs everything', () => {
  assert.equal(run(['e2e/helpers/canopen-shots.css']).length, SPECS.length)
})

test('fixtures run the specs that name them', () => {
  assert.deepEqual(run(['e2e/fixtures/canopen-lss/project/project.json']), ['lss'])
  assert.deepEqual(run(['src/middleware/shared/utils/canopen/__tests__/fixtures/generic-io-module.eds']), [
    'slave-build',
  ])
})

test('unit tests and files outside CANopen run no spec', () => {
  assert.deepEqual(run(['src/middleware/shared/utils/canopen/__tests__/slave.test.ts']), [])
  assert.deepEqual(run(['src/frontend/store/slices/project/slice.ts', 'README.md']), [])
})

test('dependencies and the workflow run everything', () => {
  assert.equal(run(['package-lock.json']).length, SPECS.length)
  assert.equal(run(['.github/workflows/canopen-ui.yml']).length, SPECS.length)
})

test('every spec in the repository has a valid covers block', () => {
  assert.ok(readSpecs().length > 20)
})
