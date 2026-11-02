/**
 * Node startup and supervision options: the expert view, an optional node, a check with its fix,
 * and the network's error behaviour and TIME, written to canopen.json format version 3.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { windowSize } from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import {
  buildFromMenu,
  findFile,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

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

test('node options, a fix and the network error behaviour reach the build', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-options'), '', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })

    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })

    await expect(page.getByLabel('No initialization', { exact: true })).toHaveCount(0)
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await expect(page.getByLabel('No initialization', { exact: true })).toBeVisible()
    await keyView(page, 'node-expert')
    await expect(page.getByLabel('Emergency messages', { exact: true })).toBeChecked()
    await page.getByLabel('Optional node', { exact: true }).check()

    const timeout = page.getByLabel('Timeout (ms)', { exact: true })
    await timeout.fill('100')
    await timeout.press('Enter')
    const checks = page.getByRole('status', { name: 'Network checks' })
    await expect(checks).toContainText('the heartbeat timeout (100 ms) must be longer')
    await keyView(page, 'network-check-fix')
    await checks.getByRole('button', { name: /^Set to 150 ms/ }).click()
    await expect(checks).toHaveCount(0)
    await expect(timeout).toHaveValue('150')

    await page.getByRole('tab', { name: 'Network' }).click()
    await page.getByLabel('On node error', { exact: true }).selectOption('stop')
    await page.getByLabel('Send TIME', { exact: true }).check()
    const period = page.getByLabel('TIME period (ms)', { exact: true })
    await period.fill('500')
    await period.press('Enter')
    await shot(page, 'node-options-network-time')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      version: 4,
      networks: [
        {
          boot_timeout_ms: 2000,
          on_node_error: 'stop',
          time: { cob_id: 0x100, period_ms: 500 },
          nodes: [
            {
              node_id: 1,
              optional: true,
              configure: true,
              restore_defaults: 0,
              emcy: { enabled: true, cob_id: 0x81 },
              supervision: { type: 'heartbeat', consumer_ms: 150 },
            },
          ],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
