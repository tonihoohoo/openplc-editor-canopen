/**
 * The CANopen device editor stays usable in a short window: the hidden tab takes no space, the
 * Network tab scrolls to its last section and a node's PDO list keeps a usable height.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'
import { windowSize } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'

const EDS = join(
  __dirname,
  '..',
  'src',
  'middleware',
  'shared',
  'utils',
  'canopen',
  '__tests__',
  'fixtures',
  'generic-io-module.eds',
)

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program: 'PROGRAM main\n  VAR\n    x : BYTE;\n  END_VAR\n\nx := x;\n\nEND_PROGRAM\n',
}

test('the device editor tabs fit a short window', async () => {
  test.setTimeout(120000)
  const { userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-network-tab'), '', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1280, 640)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })

    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await page.getByRole('tab', { name: /Inputs/ }).click()
    const inputs = page.getByRole('tabpanel', { name: /Inputs/ })
    await inputs.scrollIntoViewIfNeeded()
    expect((await inputs.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(200)

    await page.getByRole('tab', { name: 'Network' }).click()
    await expect(page.getByTestId('canopen-node-panel')).toBeHidden()
    await expect(page.getByRole('heading', { name: 'CAN interface' })).toBeInViewport()
    await expect(page.getByLabel('Interface', { exact: true })).toBeInViewport()

    const sync = page.getByRole('heading', { name: 'SYNC', exact: true })
    await sync.scrollIntoViewIfNeeded()
    await expect(sync).toBeInViewport()
    await shot(page, 'network-tab-short-window')
  } finally {
    await quitApp(app, page)
  }
})
