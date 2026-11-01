/**
 * XDD labels: objects are named by the file's label, with the object dictionary name on hover and in
 * the details pane, and the device card counts the labels.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { EMPTY_STATION, openNetwork, windowSize, writeEds } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'
import { launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const FIXTURES = join(__dirname, '..', 'src', 'middleware', 'shared', 'utils', 'canopen', '__tests__', 'fixtures')
const XDD_TEXT = readFileSync(join(FIXTURES, 'cia311', 'generic-io-module-full.xdd'), 'utf8')
  .replace('subIndex="01" name="Inputs 1-8"', 'subIndex="01" name="Read_Input_8Bit_1"')
  .replace('<label lang="en">Inputs 1-8</label>', '<label lang="en">Digital input 1 to 8</label>')
  .replace('index="2004" name="Output fault reaction"', 'index="2004" name="FaultReaction"')

test('objects are named by their XDD labels', async () => {
  test.setTimeout(180000)
  const root = join(tmpdir(), 'openplc-e2e-canopen-xdd-labels')
  const { userData } = writeEthercatProject(root, '', EMPTY_STATION)
  const xdd = writeEds(join(userData, 'labelled-io-module.xdd'), XDD_TEXT)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    const dialog = page.getByTestId('canopen-file-dialog')
    await page.getByTestId('canopen-eds-input').setInputFiles(xdd)
    await expect(dialog.getByTestId('canopen-file-details')).toContainText(/Labels\s*\d+ of 257 objects/)
    await shot(page, 'xdd-labels-import-dialog')
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText(/^Node 1: /)).toBeVisible({ timeout: 15000 })

    await page.getByRole('tab', { name: /Inputs/ }).click()
    const cell = page.getByTestId('canopen-pdo-input-1').getByText('Digital input 1 to 8')
    await expect(cell).toHaveAttribute('title', 'Name in the device file: Read_Input_8Bit_1')
    await shot(page, 'xdd-labels-inputs')

    await page.getByRole('tab', { name: /Startup SDOs/ }).click()
    await page.getByRole('button', { name: 'Add an SDO for an object of the device' }).click()
    await page.getByLabel('Search objects').fill('faultreaction')
    await expect(page.getByText('Output fault reaction')).toHaveAttribute(
      'title',
      'Name in the device file: FaultReaction',
    )
    await page.getByRole('button', { name: 'Details' }).click()
    await expect(page.getByTestId('canopen-object-details-0x2004:00')).toContainText('FaultReaction')
    await shot(page, 'xdd-labels-picker-details')
  } finally {
    await quitApp(app, page)
  }
})
