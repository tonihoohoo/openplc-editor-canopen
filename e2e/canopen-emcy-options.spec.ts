/**
 * Emergency settings follow the EDS: a node without 0x1014 gets them greyed out and off, a read-only
 * 0x1014 fixes the COB-ID to the EDS value, greyed-out options say why on hover, and the build
 * carries the emergency the node can send.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Locator, test } from '@playwright/test'

import {
  buildFromMenu,
  findFile,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

const EDS_TEXT = readFileSync(
  join(
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
  ),
  'utf8',
)

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program: 'PROGRAM main\n  VAR\n    x : BYTE;\n  END_VAR\n\nx := x;\n\nEND_PROGRAM\n',
}

/** The tooltip of a field: the title of the label that wraps it. */
const tooltip = (field: Locator) => field.locator('xpath=ancestor::label[1]').getAttribute('title')

test('emergency settings follow the EDS and greyed-out options say why', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-emcy'), '', STATION)
  const noEmcy = join(userData, 'no-emcy-module.eds')
  const fixedEmcy = join(userData, 'fixed-emcy-module.eds')
  writeFileSync(noEmcy, EDS_TEXT.replace(/\[1014\][^[]*/g, ''))
  writeFileSync(fixedEmcy, EDS_TEXT.replace(/(\[1014\][^[]*AccessType=)rw/, '$1ro'))
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) })

  const { app, page } = await launch(userData)
  await expect(async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(1280, 720)))
  }).toPass({ timeout: 30000 })
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    await expect(page.getByText('No nodes yet')).toBeVisible({ timeout: 30000 })

    await page.getByTestId('canopen-eds-input').setInputFiles(noEmcy)
    await expect(page.getByText('Node 1: Generic_I_O_module')).toBeVisible({ timeout: 15000 })
    const emcy = page.getByLabel('Emergency messages', { exact: true })
    await expect(emcy).toHaveCount(0)
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await expect(emcy).not.toBeChecked()
    await expect(emcy).toBeDisabled()
    const noReason = 'The device sends no emergency messages: its EDS has no 0x1014'
    expect(await tooltip(emcy)).toBe(noReason)
    await expect(page.getByText(noReason)).toBeVisible()
    await expect(page.getByLabel('Emergency COB-ID', { exact: true })).toHaveCount(0)
    const time = page.getByLabel('Receive TIME', { exact: true })
    await expect(time).toBeDisabled()
    expect(await tooltip(time)).toBe('The device cannot consume TIME: its EDS has no writable 0x1012')
    await emcy.scrollIntoViewIfNeeded()
    await shot('1-no-0x1014')

    await page.getByLabel('No initialization', { exact: true }).check()
    const vendor = page.getByLabel(/^Vendor ID /)
    await expect(vendor).toBeDisabled()
    expect(await tooltip(vendor)).toBe('Not checked with No initialization')
    const restore = page.getByLabel('Restore defaults before configuring', { exact: true })
    await expect(restore).toBeDisabled()
    expect(await tooltip(restore)).toBe('Not with No initialization')
    await vendor.scrollIntoViewIfNeeded()
    await shot('2-no-initialization')
    await page.getByLabel('No initialization', { exact: true }).uncheck()

    await page.getByRole('switch', { name: 'Expert view' }).uncheck()
    await expect(emcy).toHaveCount(0)

    await page.getByTestId('canopen-eds-input').setInputFiles(fixedEmcy)
    await expect(page.getByText('Node 2: Generic_I_O_module')).toBeVisible({ timeout: 15000 })
    await page.getByRole('switch', { name: 'Expert view' }).check()
    await expect(emcy).toBeChecked()
    await expect(emcy).toBeEnabled()
    const cobId = page.getByLabel('Emergency COB-ID', { exact: true })
    await expect(cobId).toHaveValue('0x082')
    await expect(cobId).toBeDisabled()
    expect(await tooltip(cobId)).toBe('Fixed by the device: its EDS marks 0x1014 read-only')
    await cobId.scrollIntoViewIfNeeded()
    await shot('3-read-only-0x1014')

    await page.getByRole('tab', { name: 'Network' }).click()
    await expect(page.getByText('Nodes whose EDS has no 0x1014 get it off')).toBeVisible()
    await shot('4-network-defaults')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      networks: [
        {
          nodes: [
            { node_id: 1, emcy: { enabled: false } },
            { node_id: 2, emcy: { enabled: true, cob_id: 0x82 } },
          ],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
