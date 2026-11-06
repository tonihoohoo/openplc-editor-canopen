// ci-covers:
//   src/middleware/shared/utils/canopen/pdo-layout.ts
//   src/frontend/components/_features/[workspace]/editor/device/canopen/pdo-section.tsx
//   src/frontend/components/_features/[workspace]/editor/device/canopen/sortable-rows.tsx
/**
 * PDO layout in the CANopen device editor: PDOs added beyond the predefined set with a free COB-ID,
 * an entry moved to another PDO, a PDO between two nodes and the mapping choice on Replace, checked
 * in conf/canopen.json.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { keyView, shot } from './helpers/canopen-shots'
import {
  buildFromMenu,
  findFile,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

const EDS = join(__dirname, 'fixtures', 'canopen-pdo-layout', 'multi-pdo-module.eds')

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program:
    'PROGRAM main\n  VAR\n    inputs AT %IB1 : BYTE;\n    outputs AT %QB0 : BYTE;\n  END_VAR\n\noutputs := inputs;\n\nEND_PROGRAM\n',
}

type ConfNode = { node_id: number; tpdos: Array<{ number: number; cob_id: number }>; rpdos: unknown[]; sdo: unknown[] }

test('added PDOs, a moved entry and a PDO between two nodes reach conf/canopen.json', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-pdo-layout'), '', STATION)
  const { app, page } = await launch(userData)
  await expect(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1280, 720)))
  }).toPass({ timeout: 15000 })
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })
    for (const id of [1, 2]) {
      await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
      await page.getByTestId('canopen-file-dialog-confirm').click()
      await expect(page.getByText(`Node ${id}: Generic_I_O_module`)).toBeVisible({ timeout: 15000 })
    }

    // Node 1: TPDO 2 to 5; TPDO 5 has no predefined COB-ID and gets a free one.
    await page.getByLabel('CANopen nodes').getByText('1: Generic_I_O_module', { exact: true }).click()
    await page.getByRole('tab', { name: /Inputs/ }).click()
    for (let k = 0; k < 4; k++) await page.getByRole('button', { name: 'Add TPDO' }).click()
    await expect(page.getByTestId('canopen-pdo-input-5')).toBeVisible()
    await expect(page.getByTestId('canopen-pdo-input-2').getByText(/node ID \+ 0x280 = 0x281/)).toBeVisible()
    await page.getByTestId('canopen-pdo-input-1').getByRole('button', { name: 'Move Input 1 to another PDO' }).click()
    await page.getByRole('menuitem', { name: 'TPDO 2' }).click()
    await expect(page.getByTestId('canopen-pdo-input-2').getByText('Input 1', { exact: true })).toBeVisible()
    await page
      .getByTestId('canopen-pdo-input-1')
      .locator('table')
      .evaluate((e) => e.scrollIntoView({ block: 'start' }))
    await expect(page.getByText('Added node 2', { exact: true })).toBeHidden({ timeout: 15000 })
    await keyView(page, 'pdo-layout-inputs')

    // Node 2: RPDO 1 listens to node 1's TPDO 2 and is not exchanged by the master.
    await page.getByLabel('CANopen nodes').getByText('2: Generic_I_O_module_2', { exact: true }).click()
    await page.getByRole('tab', { name: /Outputs/ }).click()
    const rpdo = page.getByTestId('canopen-pdo-output-1')
    await rpdo.getByLabel('Follow the node ID').uncheck()
    await rpdo.getByLabel('COB-ID').fill('0x281')
    await rpdo.getByLabel('COB-ID').press('Enter')
    await rpdo.getByLabel('Exchanged by the master').uncheck()
    await expect(page.getByTestId('canopen-pdo-link-output-1')).toContainText('node 1 (Generic_I_O_module) TPDO 2')
    await keyView(page, 'pdo-layout-link')

    await page.getByTestId('canopen-replace-input').setInputFiles(EDS)
    await page.getByLabel("Use the new file's default mapping").check()
    await shot(page, 'pdo-layout-replace')
    await page.getByRole('button', { name: 'Cancel' }).click()

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8')) as {
      networks: Array<{ nodes: ConfNode[] }>
    }
    const [one, two] = conf.networks[0].nodes
    expect(one.tpdos.map((p) => [p.number, p.cob_id])).toEqual([
      [1, 0x181],
      [2, 0x281],
    ])
    expect(two.rpdos).toEqual([])
    expect(two.sdo).toEqual(
      expect.arrayContaining([
        { index: 0x1600, subindex: 1, data: '08010062' },
        { index: 0x1400, subindex: 1, data: '81020000' },
      ]),
    )
  } finally {
    await quitApp(app, page)
  }
})

const ONE_NODE = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program: 'PROGRAM main\n  VAR\n    x : BYTE;\n  END_VAR\n\nx := x;\n\nEND_PROGRAM\n',
}

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
] as const) {
  test(`"Exchanged by the master" leaves the PDO card in place at ${width}x${height}`, async () => {
    test.setTimeout(300000)
    const dir = join(tmpdir(), `openplc-e2e-canopen-exchange-toggle-${width}`)
    const { userData } = writeEthercatProject(dir, '', ONE_NODE)
    const { app, page } = await launch(userData)
    await expect(async () => {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(size[0], size[1])),
        [width, height],
      )
    }).toPass({ timeout: 15000 })
    try {
      await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
      await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
      await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })
      await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
      await page.getByTestId('canopen-file-dialog-confirm').click()
      await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })
      await expect(page.getByText('Added node 1', { exact: true })).toBeHidden({ timeout: 15000 })

      // TPDO scrolled to the end of the editor; RPDO at the top, where unticking adds a warning above.
      for (const [tab, direction, scroll] of [
        ['Inputs', 'input', 'end'],
        ['Outputs', 'output', 'top'],
      ] as const) {
        await page.getByRole('tab', { name: new RegExp(tab) }).click()
        const card = page.getByTestId(`canopen-pdo-${direction}-1`)
        await card
          .locator('table')
          .evaluate((e, block) => e.scrollIntoView({ block: block === 'end' ? 'end' : 'start' }), scroll)
        if (scroll === 'top') {
          await page.locator('[data-canopen-scroller]').evaluate((e) => {
            e.scrollTop = 0
          })
        }
        const box = card.getByLabel('Exchanged by the master')
        const type = card.locator('th', { hasText: 'Type' })
        // Hover first: a click on a control under the sticky tab bar would scroll it into view.
        await box.hover()
        const before = { box: await box.boundingBox(), type: await type.boundingBox() }
        await box.click()
        await expect(box).not.toBeChecked()
        await expect(card.getByText('Not exchanged: no PLC value').first()).toBeVisible()
        if (direction === 'output') {
          await expect(page.getByLabel('Network checks')).toContainText('no node sends its COB-ID')
        } else {
          await expect(card.getByLabel('Receive timeout (ms)')).toBeDisabled()
        }
        expect({ box: await box.boundingBox(), type: await type.boundingBox() }).toEqual(before)
        await shot(page, `exchange-toggle-${direction}-off-${width}`)
        await box.click()
        await expect(box).toBeChecked()
        expect(await box.boundingBox()).toEqual(before.box)
      }
    } finally {
      await quitApp(app, page)
    }
  })
}
