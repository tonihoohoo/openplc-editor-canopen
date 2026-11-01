/**
 * Boot writes in the CANopen device editor: the "Written at boot" list, a startup SDO that jumps
 * past a line when refused, text and byte values, a gap in an RPDO and an RPDO deadline, checked in
 * conf/canopen.json.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { keyView } from './helpers/canopen-shots'
import {
  buildFromMenu,
  findFile,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

const EDS = join(__dirname, 'fixtures', 'canopen-boot-sdo', 'boot-module.eds')

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program:
    'PROGRAM main\n  VAR\n    inputs AT %IB1 : BYTE;\n    outputs AT %QB0 : BYTE;\n  END_VAR\n\noutputs := inputs;\n\nEND_PROGRAM\n',
}

type ConfNode = {
  rpdos: Array<{ number: number; send_period_ms?: number; entries: Array<Record<string, unknown>> }>
  sdo: Array<{ index: number; subindex: number; data: string; on_abort?: string; jump_to?: number }>
}

async function addSdo(page: Page, search: string): Promise<void> {
  await page.getByRole('button', { name: 'Add an SDO for an object of the device' }).click()
  await page.getByLabel('Search objects').fill(search)
  await page.getByLabel('Search objects').press('Enter')
  await page.getByLabel('Search objects').press('Escape')
}

test('refusal policies, text and byte values, a gap and a deadline reach conf/canopen.json', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-boot-sdo'), '', STATION)
  const { app, page } = await launch(userData)
  await expect(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1280, 720)))
  }).toPass({ timeout: 15000 })
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })
    await page.getByTestId('canopen-eds-input').setInputFiles(EDS)
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Added node 1', { exact: true })).toBeHidden({ timeout: 15000 })

    // RPDO 1: a reserved byte before the outputs, and a deadline of 100 ms.
    await page.getByRole('tab', { name: /Outputs/ }).click()
    const rpdo = page.getByTestId('canopen-pdo-output-1')
    await rpdo.getByRole('button', { name: 'Add gap' }).click()
    await page.getByRole('menuitem', { name: /8 bits/ }).click()
    await rpdo.getByRole('button', { name: 'Move Gap (8 bits) up' }).click()
    await rpdo.getByLabel('Deadline (ms)').fill('100')
    await rpdo.getByLabel('Deadline (ms)').press('Enter')
    await expect(rpdo.getByText(/The master sends it every \d+ ms/)).toBeVisible()
    await rpdo.evaluate((e) => e.scrollIntoView({ block: 'start' }))
    await keyView(page, 'boot-gap-deadline')
    await rpdo.locator('table').evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await expect(rpdo.getByText('A gap: no PLC value')).toBeVisible()
    await keyView(page, 'boot-gap-entry')

    // Startup SDOs: a parameter that jumps past the text when refused, a text and bytes.
    await page.getByRole('tab', { name: /Startup SDOs/ }).click()
    await addSdo(page, 'parameter')
    await addSdo(page, 'station')
    await addSdo(page, 'block')
    const rows = page.getByTestId('canopen-sdo-row')
    await expect(rows).toHaveCount(3)
    await rows.nth(1).getByLabel('Value').fill('Line 3')
    await rows.nth(1).getByLabel('Value').press('Enter')
    await rows.nth(2).getByLabel('Value').fill('01 02 A0')
    await rows.nth(2).getByLabel('Value').press('Enter')
    await rows.nth(0).getByLabel('If 0x2100:00 is refused').selectOption('jump')
    await rows.nth(0).getByLabel('Line 0x2100:00 jumps to').selectOption({ label: 'Line 3: 0x2400:00' })
    await page.getByRole('button', { name: /Written at boot/ }).click()
    await expect(page.getByTestId('canopen-boot-write').filter({ hasText: 'Jump to SDO line 3' })).toBeVisible()
    await rows.nth(0).evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await keyView(page, 'boot-startup-sdos')
    await page.getByTestId('canopen-boot-writes').evaluate((e) => e.scrollIntoView({ block: 'start' }))
    await keyView(page, 'boot-writes')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8')) as {
      version: number
      networks: Array<{ nodes: ConfNode[] }>
    }
    expect(conf.version).toBe(4)
    const node = conf.networks[0].nodes[0]
    expect(node.rpdos[0].entries).toEqual([
      { index: 5, subindex: 0, type: 'UNSIGNED8' },
      expect.objectContaining({ index: 0x6200, subindex: 1, location: '%QB0' }),
    ])
    expect(node.rpdos[0].send_period_ms).toBeGreaterThan(0)
    expect(node.sdo).toEqual(
      expect.arrayContaining([
        { index: 0x1400, subindex: 5, data: '6400' },
        { index: 0x1600, subindex: 1, data: '08000500' },
        { index: 0x1600, subindex: 2, data: '08010062' },
        { index: 0x2300, subindex: 0, data: '4C696E652033' },
        { index: 0x2400, subindex: 0, data: '0102A0' },
      ]),
    )
    const jump = node.sdo.findIndex((s) => s.index === 0x2100)
    const target = node.sdo.findIndex((s) => s.index === 0x2400)
    expect(node.sdo[jump]).toMatchObject({ on_abort: 'jump', jump_to: target })
  } finally {
    await quitApp(app, page)
  }
})
