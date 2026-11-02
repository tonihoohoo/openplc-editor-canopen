import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { shot } from './helpers/canopen-shots'
import { launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const EDS = join(__dirname, 'fixtures', 'canopen-boot-sdo', 'boot-module.eds')
const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program: 'PROGRAM main\n  VAR\n    x : BYTE;\n  END_VAR\nEND_PROGRAM\n',
}

async function addSdo(page: Page, search: string): Promise<void> {
  await page.getByRole('button', { name: 'Add an SDO for an object of the device' }).click()
  await page.getByLabel('Search objects').fill(search)
  await page.getByLabel('Search objects').press('Enter')
  await page.getByLabel('Search objects').press('Escape')
}

async function useVariant(page: Page, v: string): Promise<void> {
  await page.evaluate((x) => window.localStorage.setItem('canopen-sdo-refusal-mockup', x), v)
  await page.getByRole('tab', { name: /General/ }).click()
  await page.getByRole('tab', { name: /Startup SDOs/ }).click()
}

test('sdo refusal mockups', async () => {
  test.setTimeout(300000)
  const { userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-sdo-refusal-mockup'), '', STATION)
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
    await page.getByRole('tab', { name: /Startup SDOs/ }).click()
    await addSdo(page, 'parameter')
    await addSdo(page, 'station')
    await addSdo(page, 'block')
    await addSdo(page, 'communication error')
    const rows = page.getByTestId('canopen-sdo-row')
    await rows.nth(1).getByLabel('Value').fill('Line 3')
    await rows.nth(1).getByLabel('Value').press('Enter')
    await rows.nth(2).getByLabel('Value').fill('01 02 A0')
    await rows.nth(2).getByLabel('Value').press('Enter')
    await rows.nth(0).getByLabel('If 0x2100:00 is refused').selectOption('jump')
    await rows.nth(0).getByLabel('Line 0x2100:00 jumps to').selectOption({ index: 1 })
    await rows.nth(1).getByLabel('If 0x2300:00 is refused').selectOption('continue')
    const top = async () => {
      await page.getByRole('button', { name: 'Add by index' }).evaluate((e) => e.scrollIntoView({ block: 'start' }))
    }
    await top()
    await shot(page, 'mock-0-current')
    for (const v of ['a', 'b', 'c']) {
      await useVariant(page, v)
      await top()
      await shot(page, `mock-${v}-1-table`)
      await rows.nth(2).evaluate((e) => e.scrollIntoView({ block: 'end' }))
      await shot(page, `mock-${v}-1b-scrolled`)
    }
    await useVariant(page, 'current')
    await rows.nth(2).evaluate((e) => e.scrollIntoView({ block: 'end' }))
    await shot(page, 'mock-0-current-scrolled')
    // B: popover from the gear of line 1, then from the chip of line 1 to show the jump picker
    await useVariant(page, 'b')
    await top()
    await rows.nth(2).getByRole('button', { name: 'If 0x2400:00 is refused' }).click()
    await page.waitForTimeout(300)
    await shot(page, 'mock-b-2-popover-default')
    await page.keyboard.press('Escape')
    await rows
      .nth(0)
      .getByRole('button', { name: /If refused: jump/ })
      .click()
    await page.waitForTimeout(300)
    await shot(page, 'mock-b-3-popover-jump')
    await page.keyboard.press('Escape')
    // C: row menu of line 1
    await useVariant(page, 'c')
    await top()
    await rows.nth(2).getByRole('button', { name: 'More for SDO 0x2400:00' }).click()
    await page.waitForTimeout(300)
    await shot(page, 'mock-c-2-menu-default')
    await page.keyboard.press('Escape')
    await rows
      .nth(0)
      .getByRole('button', { name: /If refused: jump/ })
      .click()
    await page.waitForTimeout(300)
    await shot(page, 'mock-c-3-chip-menu')
    await page.keyboard.press('Escape')
  } finally {
    await quitApp(app, page)
  }
})
