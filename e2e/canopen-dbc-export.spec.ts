/**
 * DBC export: a network of three nodes exported as one DBC at 1280x720 without scrolling, the frame
 * options changing only texts and counts, Show all, the options kept for the next export, and a
 * node exported as DBC.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ElectronApplication, expect, type Locator, test } from '@playwright/test'

import { addNode, EDS, EMPTY_STATION, openNetwork, windowSize } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'
import { launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

/** Answers the save dialog in the main process and keeps what the editor saves. */
async function captureSaves(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const saved: Array<{ name: string; extensions: string[]; text: string }> = []
    Reflect.set(globalThis, '__dbcSaved', saved)
    ipcMain.removeHandler('project:export-file')
    ipcMain.handle(
      'project:export-file',
      (_event, name: string, bytes: Uint8Array, filter: { name: string; extensions: string[] }) => {
        saved.push({ name, extensions: filter.extensions, text: Buffer.from(bytes).toString('utf-8') })
        return { success: true }
      },
    )
  })
}

async function savedFile(app: ElectronApplication, index: number): Promise<{ name: string; text: string }> {
  const json = await app.evaluate((_electron, i) => {
    const saved: unknown = Reflect.get(globalThis, '__dbcSaved')
    return JSON.stringify(Array.isArray(saved) ? (saved[i] ?? null) : null)
  }, index)
  const file: unknown = JSON.parse(json)
  if (typeof file !== 'object' || file === null || !('name' in file) || !('text' in file)) return { name: '', text: '' }
  return { name: String(file.name), text: String(file.text) }
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

const count = async (locator: Locator, pattern: RegExp): Promise<number> =>
  Number(pattern.exec((await locator.textContent()) ?? '')?.[1])

test('the network and a node export as DBC with frame options', async () => {
  test.setTimeout(240000)
  const root = join(tmpdir(), 'openplc-e2e-canopen-dbc')
  const { userData } = writeEthercatProject(root, '', EMPTY_STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1280, 720)
  try {
    await openNetwork(page)
    await addNode(page, EDS, 'Node 1: Generic_I_O_module')
    await addNode(page, EDS, 'Node 2: Generic_I_O_module')
    await addNode(page, EDS, 'Node 3: Generic_I_O_module')

    await captureSaves(app)
    await page.getByRole('tab', { name: 'Network' }).click()
    await page.getByRole('button', { name: 'Export network...' }).click()
    const dialog = page.getByTestId('canopen-export-dialog')
    const formatHeight = (await box(dialog)).height
    await dialog.getByRole('radio', { name: 'DBC' }).check()
    expect((await box(dialog)).height).toBe(formatHeight)
    await expect(dialog.getByTestId('canopen-export-format-description')).toContainText('CAN analysers')
    await expect(dialog.getByTestId('canopen-export-dbc-time')).toBeDisabled()
    await expect(dialog.getByTestId('canopen-export-dbc-time')).toContainText('off in network')
    const check = dialog.getByTestId('canopen-export-check')
    await expect(check).toContainText('canopen_1.dbc')
    await expect(check).toContainText('passes the DBC check')
    await expect(dialog.getByTestId('canopen-export-losses').locator('li')).toHaveCount(3)
    for (const id of [
      'canopen-export-format',
      'canopen-export-dbc-options',
      'canopen-export-losses',
      'canopen-export-save',
    ])
      await expect(dialog.getByTestId(id)).toBeInViewport({ ratio: 1 })
    await expect(dialog.getByTestId('canopen-export-save')).toHaveText('Save canopen_1.dbc...')
    await shot(page, 'dbc-export-network')

    const toggle = dialog.getByTestId('canopen-export-losses-toggle')
    const losses = await count(toggle, /Show all (\d+)/)
    const frames = await count(check, /(\d+) frames/)
    const select = dialog.getByTestId('canopen-export-dbc-sdo-values')
    const selectBox = await box(select)
    const saveBox = await box(dialog.getByTestId('canopen-export-save'))
    await dialog.getByTestId('canopen-export-dbc-heartbeat').click()
    await dialog.getByTestId('canopen-export-dbc-sdo').click()
    await expect(select).toBeDisabled()
    expect(await box(select)).toEqual(selectBox)
    expect(await box(dialog.getByTestId('canopen-export-save'))).toEqual(saveBox)
    await expect(toggle).toHaveText(`Show all ${losses + 2}`)
    expect(await count(check, /(\d+) frames/)).toBe(frames - 10)
    await shot(page, 'dbc-export-options-off')

    await toggle.click()
    await expect(dialog.getByTestId('canopen-export-losses').locator('li')).toHaveCount(losses + 2)
    await expect(dialog.getByTestId('canopen-export-losses')).toContainText('left out above: heartbeat')
    await expect(dialog.getByTestId('canopen-export-save')).toBeInViewport({ ratio: 1 })
    expect((await box(dialog)).height).toBe(formatHeight)
    await shot(page, 'dbc-export-show-all')

    await dialog.getByTestId('canopen-export-save').click()
    await expect(dialog).toHaveCount(0)
    const network = await savedFile(app, 0)
    expect(network.name).toBe('canopen_1.dbc')
    expect(network.text).toContain('BU_: PLC')
    expect(network.text).not.toContain('_SDO_Rx')
    expect(network.text).not.toMatch(/^BO_ 1793 /m)

    await page.getByRole('button', { name: 'Export network...' }).click()
    await expect(dialog.getByRole('radio', { name: 'DBC' })).toBeChecked()
    await expect(dialog.getByTestId('canopen-export-dbc-heartbeat')).toHaveAttribute('aria-checked', 'false')
    await dialog.getByTestId('canopen-export-dbc-heartbeat').click()
    await dialog.getByTestId('canopen-export-dbc-sdo').click()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByRole('tab', { name: 'Nodes' }).click()
    await page.getByRole('list', { name: 'CANopen nodes' }).getByRole('button', { name: /^2: / }).click()
    await page.getByRole('button', { name: 'Export...' }).click()
    await dialog.getByRole('radio', { name: 'DBC' }).check()
    await expect(check).toContainText('node_2.dbc')
    await shot(page, 'dbc-export-node')
    await dialog.getByTestId('canopen-export-save').click()
    await expect(dialog).toHaveCount(0)
    const node = await savedFile(app, 1)
    expect(node.name).toBe('node_2.dbc')
    expect(node.text).toMatch(/^BO_ 1538 /m)
    expect(node.text).not.toMatch(/^BO_ 1539 /m)
  } finally {
    await quitApp(app, page)
  }
})
