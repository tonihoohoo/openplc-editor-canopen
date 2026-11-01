/**
 * Build and upload of a CANopen project to a runtime without CANopen support is refused before
 * the upload, with the reason. The runtime is a local fake (`helpers/canopen-runtime.ts`).
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { fakeRuntime } from './helpers/canopen-runtime'
import { windowSize } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'
import {
  buildFromMenu,
  connectRuntime,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

const STATION = {
  bus: join('canopen-generic-io', 'project', 'devices', 'remote', 'canopen_1.json'),
  program: readFileSync(
    join(__dirname, 'fixtures', 'canopen-generic-io', 'project', 'pous', 'programs', 'main.st'),
    'utf8',
  ),
}

test('a runtime without CANopen support refuses the upload with the reason', async () => {
  test.setTimeout(300000)
  const uploads: string[] = []
  const runtime = fakeRuntime({
    features: [],
    configVersions: null,
    status: () => ({ active: false }),
    onRequest: (path) => {
      if (path.startsWith('/api/upload')) uploads.push(path)
    },
  })
  const { userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-upload'), '127.0.0.1', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await connectRuntime(page, 'e2e', 'e2e')
    await buildFromMenu(page, 'Build and upload')
    await expect(
      page.getByText(/has no CANopen support, so it would ignore this project's CANopen/).first(),
    ).toBeVisible({ timeout: 180000 })
    await shot(page, 'upload-refused-no-canopen')
    expect(uploads).toEqual([])
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
