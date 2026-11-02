/**
 * A CANopen node added from an EDS file in the device editor builds offline into
 * conf/canopen.json, with its PDOs mapped to the addresses the program uses.
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
  program:
    'PROGRAM main\n  VAR\n    inputs AT %IB1 : BYTE;\n    outputs AT %QB0 : BYTE;\n  END_VAR\n\noutputs := inputs;\n\nEND_PROGRAM\n',
}

test('a node added from an EDS file builds into conf/canopen.json', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-offline'), '', STATION)
  const { app, page } = await launch(userData)
  // Below a desktop size the app shows its mobile notice instead (a virtual display opens it at 800x600).
  await windowSize(app, 1600, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })
    await keyView(page, 'network-empty')

    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })
    const nodeId = page.getByLabel('Node ID', { exact: true })
    await nodeId.fill('2')
    await nodeId.press('Enter')
    await expect(page.getByText('Node 2: Generic_I_O_module')).toBeVisible()
    await keyView(page, 'node-basic')

    await page.getByRole('tab', { name: /Outputs/ }).click()
    const output = page.getByTestId('canopen-pdo-output-1')
    await expect(output.getByText('%QB0')).toBeVisible()
    await output.getByLabel('Alias of Outputs 1-8').fill('io_outputs')
    await output.getByLabel('Alias of Outputs 1-8').press('Enter')
    await keyView(page, 'node-outputs')

    // Aliases are unique across all I/O: an input cannot take the outputs' alias.
    await page.getByRole('tab', { name: /Inputs/ }).click()
    const inputAlias = page
      .getByTestId('canopen-pdo-input-1')
      .getByLabel(/^Alias of /)
      .first()
    await inputAlias.fill('io_outputs')
    await inputAlias.press('Enter')
    await expect(page.getByText(/"io_outputs" is already assigned to/)).toBeInViewport()
    await shot(page, 'offline-build-alias-in-use')
    await inputAlias.fill('')
    await inputAlias.press('Enter')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      version: 4,
      networks: [
        {
          interface: 'can0',
          nodes: [
            {
              node_id: 2,
              identity: { vendor_id: 1, product_code: 2 },
              state_location: '%IB0',
              tpdos: [
                {
                  cob_id: 0x182,
                  entries: [
                    { index: 0x6000, subindex: 1, location: '%IB1' },
                    { index: 0x6401, subindex: 1, location: '%IW0' },
                  ],
                },
              ],
              rpdos: [{ cob_id: 0x202, entries: [{ index: 0x6200, subindex: 1, location: '%QB0' }] }],
            },
          ],
        },
      ],
    })
    await shot(page, 'offline-build-done')
    const program = readFileSync(findFile(build, 'program.st') ?? '', 'utf-8')
    expect(program).toMatch(/outputs\s+AT\s+%QB0/i)
  } finally {
    await quitApp(app, page)
  }
})
