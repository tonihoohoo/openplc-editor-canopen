/**
 * A node whose EDS lets it consume a heartbeat watches the master by default: the editor asks for a
 * master heartbeat, and the build writes 0x1016 and 0x1029 to the node with the bus priority.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { windowSize } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'
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

// The fixture has no bus priority, as a project from before it was added.
const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program: 'PROGRAM main\n  VAR\n    x : BYTE;\n  END_VAR\n\nx := x;\n\nEND_PROGRAM\n',
}

test('a node watches the master and the build configures it', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-watch'), '', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })

    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })
    await expect(page.getByLabel('Watch the master', { exact: true })).toBeChecked()

    await page.getByRole('tab', { name: 'Network' }).click()
    await expect(page.getByLabel('Real-time priority', { exact: true })).toHaveValue('90')
    const heartbeat = page.getByLabel('Heartbeat producer (ms)', { exact: true })
    await heartbeat.fill('0')
    await heartbeat.press('Enter')
    await expect(page.getByText(/the master sends none; set the master heartbeat/).first()).toBeVisible()
    await heartbeat.fill('100')
    await heartbeat.press('Enter')
    await expect(page.getByText(/the master sends none/)).toHaveCount(0)
    await shot(page, 'watch-master-network')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      networks: [
        {
          heartbeat_producer_ms: 100,
          priority: 90,
          nodes: [
            {
              node_id: 1,
              sdo: expect.arrayContaining([
                { index: 0x1016, subindex: 1, data: '2C017F00' },
                { index: 0x1029, subindex: 1, data: '00' },
              ]) as unknown,
            },
          ],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
