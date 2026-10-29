/**
 * PDO and startup SDO editing in the CANopen device editor: an entry moved up, a synchronous
 * transmission type and a startup SDO added by search all reach conf/canopen.json.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

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
  program:
    'PROGRAM main\n  VAR\n    inputs AT %IB1 : BYTE;\n    outputs AT %QB0 : BYTE;\n  END_VAR\n\noutputs := inputs;\n\nEND_PROGRAM\n',
}

test('reordered entries, transmission type and startup SDOs reach conf/canopen.json', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-editing'), '', STATION)
  const { app, page } = await launch(userData)
  // Below a desktop size the app shows its mobile notice instead; 1280x720 is the smallest layout checked.
  await expect(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1280, 720)))
  }).toPass({ timeout: 15000 })
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })
    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })

    await page.getByRole('tab', { name: /Inputs/ }).click()
    const input = page.getByTestId('canopen-pdo-input-1')
    await expect(input.getByText('0x1800:05')).toBeVisible()
    await input.getByRole('button', { name: 'Move Input 1 up' }).click()
    await input.getByLabel('Transmission type').selectOption('sync_cyclic')
    await input.getByLabel('Every N SYNC').fill('4')
    await input.getByLabel('Every N SYNC').press('Enter')
    await expect(input.getByText('Needs SYNC, which is off for this network')).toBeVisible()

    await page.getByRole('tab', { name: /Startup SDOs/ }).click()
    await page.getByRole('button', { name: 'Add an SDO for an object of the device' }).click()
    await page.getByLabel('Search objects').fill('parameter')
    await page.getByLabel('Search objects').press('Enter')
    await page.getByLabel('Search objects').press('Escape')
    const row = page.getByTestId('canopen-sdo-row')
    await expect(row.getByText('Parameter', { exact: true })).toBeVisible()
    await row.getByLabel('Value').fill('0x10')
    await row.getByLabel('Value').press('Enter')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      networks: [
        {
          nodes: [
            {
              tpdos: [
                {
                  entries: [
                    { index: 0x6401, subindex: 1 },
                    { index: 0x6000, subindex: 1 },
                  ],
                },
              ],
              sdo: expect.arrayContaining([
                { index: 0x1800, subindex: 2, data: '04' },
                { index: 0x1800, subindex: 1, data: '810100C0' },
                { index: 0x2100, subindex: 0, data: '10000000' },
              ]),
            },
          ],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
