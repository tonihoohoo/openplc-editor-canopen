/**
 * XDD and XDC files: a node from an XDC with its settings and the device card, the network
 * exported as XDC files, and an exported XDC added again.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ElectronApplication, expect, test } from '@playwright/test'

import { EMPTY_STATION, openNetwork, windowSize, writeEds } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'
import { launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const FIXTURES = join(__dirname, '..', 'src', 'middleware', 'shared', 'utils', 'canopen', '__tests__', 'fixtures')
const XDC_TEXT = readFileSync(join(FIXTURES, 'cia311', 'settings.xdc'), 'utf8')
const XDD_TEXT = readFileSync(join(FIXTURES, 'cia311', 'generic-io-module-full.xdd'), 'utf8')

type SavedFile = { name: string; extensions: string[]; text: string; zip: boolean }

/** Answers the save dialog in the main process and keeps what the editor saves. */
async function captureSaves(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const saved: Array<{ name: string; extensions: string[]; bytes: number[] }> = []
    Reflect.set(globalThis, '__xddSaved', saved)
    ipcMain.removeHandler('project:export-file')
    ipcMain.handle(
      'project:export-file',
      (_event, name: string, bytes: Uint8Array, filter: { name: string; extensions: string[] }) => {
        saved.push({ name, extensions: filter.extensions, bytes: Array.from(bytes) })
        return { success: true }
      },
    )
  })
}

function isSaved(v: unknown): v is { name: string; extensions: string[]; bytes: number[] } {
  return typeof v === 'object' && v !== null && 'name' in v && 'extensions' in v && 'bytes' in v
}

async function savedFile(app: ElectronApplication, index: number): Promise<SavedFile> {
  const json = await app.evaluate((_electron, i) => {
    const saved: unknown = Reflect.get(globalThis, '__xddSaved')
    return JSON.stringify(Array.isArray(saved) ? (saved[i] ?? null) : null)
  }, index)
  const file: unknown = JSON.parse(json)
  if (!isSaved(file)) return { name: '', extensions: [], text: '', zip: false }
  const bytes = Buffer.from(file.bytes)
  return {
    name: file.name,
    extensions: file.extensions,
    text: bytes.toString('utf-8'),
    zip: bytes.subarray(0, 2).toString('latin1') === 'PK',
  }
}

test('XDD and XDC files are checked, imported and exported', async () => {
  test.setTimeout(240000)
  const root = join(tmpdir(), 'openplc-e2e-canopen-xdd')
  const { userData } = writeEthercatProject(root, '', EMPTY_STATION)
  const xdc = writeEds(join(userData, 'tank-io.xdc'), XDC_TEXT)
  const xdd = writeEds(join(userData, 'generic-io-module-full.xdd'), XDD_TEXT)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    const dialog = page.getByTestId('canopen-file-dialog')

    await page.getByTestId('canopen-eds-input').setInputFiles(xdd)
    await expect(dialog).toContainText('File check (CiA 311)')
    await expect(dialog.getByTestId('canopen-file-details')).toContainText('IO-8822-A')
    await shot(page, 'xdd-import-dialog')
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText(/^Node 1: /)).toBeVisible({ timeout: 15000 })

    await page.getByRole('tab', { name: /Startup SDOs/ }).click()
    await page.getByRole('button', { name: 'Add an SDO for an object of the device' }).click()
    await page.getByLabel('Search objects').fill('fault reaction')
    await expect(page.getByTestId('canopen-object-details-0x2004:00')).toHaveCount(0)
    await shot(page, 'xdd-picker')
    await page.getByRole('button', { name: 'Details' }).click()
    await expect(page.getByTestId('canopen-object-details-0x2004:00')).toContainText('Use the substitute value')
    await shot(page, 'xdd-picker-details')
    await page.keyboard.press('Escape')

    await page.getByTestId('canopen-eds-input').setInputFiles(xdc)
    await expect(dialog).toContainText('Add node from tank-io.xdc')
    await expect(dialog.getByRole('radio', { name: /Take its settings/ })).toBeChecked()
    await shot(page, 'xdc-import-dialog')
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText('Node 5: tank_io')).toBeVisible({ timeout: 15000 })

    await captureSaves(app)
    await page.getByRole('tab', { name: 'Network' }).click()
    await page.getByRole('button', { name: 'Export network...' }).click()
    const exportDialog = page.getByTestId('canopen-export-dialog')
    await exportDialog.getByRole('radio', { name: /^XDC/ }).check()
    await expect(exportDialog).toContainText('Check of the files (CiA 311)')
    await expect(exportDialog.getByTestId('canopen-export-results')).toContainText('node_5.xdc')
    await expect(exportDialog.getByTestId('canopen-export-save')).toHaveText('Save canopen_1-xdc.zip...')
    await shot(page, 'xdc-export-network')
    await exportDialog.getByTestId('canopen-export-save').click()
    await expect(exportDialog).toHaveCount(0)
    const zip = await savedFile(app, 0)
    expect(zip).toMatchObject({ name: 'canopen_1-xdc.zip', extensions: ['zip'], zip: true })

    await page.getByRole('tab', { name: 'Nodes' }).click()
    await page.getByText('Node 5: tank_io').click()
    await page.getByRole('button', { name: 'Export...' }).click()
    await exportDialog.getByRole('radio', { name: /^XDC/ }).check()
    await exportDialog.getByTestId('canopen-export-save').click()
    await expect(exportDialog).toHaveCount(0)
    const exported = await savedFile(app, 1)
    expect(exported.name).toBe('node_5.xdc')
    expect(exported.text).toContain('nodeID="5"')

    const again = writeEds(join(userData, 'node_5.xdc'), exported.text)
    await page.getByTestId('canopen-eds-input').setInputFiles(again)
    await expect(dialog).toContainText('node ID 5 is in use, so the node gets')
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByRole('heading', { name: /: tank_io_2$/ })).toBeVisible({ timeout: 15000 })
  } finally {
    await quitApp(app, page)
  }
})
