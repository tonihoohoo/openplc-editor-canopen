/**
 * EDS and DCF files: the CiA 306 check dialog, a node from a DCF with its settings, a refused file,
 * a node and the network exported as DCF files, and an exported DCF added again.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { EDS_TEXT, EMPTY_STATION, openNetwork, windowSize, writeEds } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'
import { launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const DCF_TEXT = EDS_TEXT.replace(
  /(\[1800sub5\][^[]*DefaultValue=20)/,
  '$1\nParameterValue=100',
)
  .replace('[2100]\nParameterName=Parameter', '[2100]\nParameterName=Parameter\nParameterValue=7')
  .concat('\n[DeviceComissioning]\nNodeID=5\nNodeName=io5\nBaudrate=250\nNetNumber=1\nCANopenManager=0\n')

const BROKEN_TEXT = EDS_TEXT.replace(
  /(\[1A00sub0\][^[]*DataType=)0x0005/,
  '$10x0007',
)

/** Keeps the files the editor saves in the page instead of downloading them. */
async function captureSaves(page: Page): Promise<void> {
  await page.evaluate(() => {
    const saved: Blob[] = []
    Reflect.set(window, '__dcfSaved', saved)
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (blob instanceof Blob) saved.push(blob)
      return 'blob:dcf'
    }
    HTMLAnchorElement.prototype.click = () => undefined
  })
}

async function savedFile(page: Page, index: number): Promise<{ type: string; text: string }> {
  return page.evaluate(async (i) => {
    const saved: unknown = Reflect.get(window, '__dcfSaved')
    const blob = Array.isArray(saved) ? saved[i] : undefined
    if (!(blob instanceof Blob)) return { type: '', text: '' }
    return { type: blob.type, text: await blob.text() }
  }, index)
}

test('EDS and DCF files are checked, imported and exported', async () => {
  test.setTimeout(240000)
  const root = join(tmpdir(), 'openplc-e2e-canopen-dcf')
  const { userData } = writeEthercatProject(root, '', EMPTY_STATION)
  const dcf = writeEds(join(userData, 'io5.dcf'), DCF_TEXT)
  const broken = writeEds(join(userData, 'broken-module.eds'), BROKEN_TEXT)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page)
    await expect(page.getByRole('button', { name: 'Add node from EDS or DCF...' })).toBeVisible()

    await page.getByTestId('canopen-eds-input').setInputFiles(dcf)
    const dialog = page.getByTestId('canopen-file-dialog')
    await expect(dialog).toContainText('Add node from io5.dcf')
    await expect(dialog.getByRole('radio', { name: /Take its settings/ })).toBeChecked()
    await expect(dialog).toContainText('The file is for 250 kbit/s and the network runs 500 kbit/s')
    await expect(dialog.getByTestId('canopen-file-settings')).toContainText('startup SDO 7')
    await shot(page, 'dcf-import-dialog')
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText('Node 5: io5')).toBeVisible({ timeout: 15000 })

    await page.getByTestId('canopen-eds-input').setInputFiles(broken)
    await expect(dialog).toContainText('Cannot add a node from broken-module.eds')
    await expect(dialog.getByTestId('canopen-file-findings')).toContainText('[1A00sub0] DataType line')
    await expect(page.getByTestId('canopen-file-dialog-confirm')).toHaveCount(0)
    await shot(page, 'dcf-import-refused')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    await expect(page.getByRole('button', { name: 'Replace EDS...' })).toBeVisible()
    await shot(page, 'dcf-node-page')

    await captureSaves(page)
    await page.getByRole('button', { name: 'Export...' }).click()
    const exportDialog = page.getByTestId('canopen-export-dialog')
    await expect(exportDialog.getByTestId('canopen-export-results')).toContainText('node_5.dcf')
    await shot(page, 'dcf-export-node')
    await exportDialog.getByTestId('canopen-export-save').click()
    await expect(exportDialog).toHaveCount(0)
    const exported = await savedFile(page, 0)
    expect(exported.text).toContain('[DeviceComissioning]')
    expect(exported.text).toContain('NodeID=5')
    expect(exported.text).toMatch(/\[1800sub5\][^[]*ParameterValue=100/)

    await page.getByRole('button', { name: 'Export...' }).click()
    await exportDialog.getByRole('radio', { name: /^EDS/ }).check()
    await expect(exportDialog.getByTestId('canopen-export-results')).toContainText('.eds')
    await expect(exportDialog.getByTestId('canopen-export-results')).toContainText('without its values')
    await expect(exportDialog.getByTestId('canopen-export-losses')).toContainText('node ID, name, PDO settings')
    await shot(page, 'export-node-eds')
    await exportDialog.getByTestId('canopen-export-save').click()
    await expect(exportDialog).toHaveCount(0)
    const eds = await savedFile(page, 1)
    expect(eds.text).not.toContain('ParameterValue=')
    expect(eds.text).not.toContain('[DeviceComissioning]')

    await page.getByRole('tab', { name: 'Network' }).click()
    await page.getByRole('button', { name: 'Export network...' }).click()
    await expect(exportDialog).toContainText('Export network canopen_1')
    await exportDialog.getByRole('radio', { name: /^DCF/ }).check()
    await expect(exportDialog.getByTestId('canopen-export-save')).toHaveText('Save canopen_1-dcf.zip...')
    await shot(page, 'dcf-export-network')
    await exportDialog.getByTestId('canopen-export-save').click()
    await expect(exportDialog).toHaveCount(0)
    expect((await savedFile(page, 2)).type).toBe('application/zip')

    await page.getByRole('tab', { name: 'Nodes' }).click()
    const again = writeEds(join(userData, 'node_5.dcf'), exported.text)
    await page.getByTestId('canopen-eds-input').setInputFiles(again)
    await expect(dialog).toContainText('node ID 5 is in use, so the node gets 1')
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText('Node 1: io5_2')).toBeVisible({ timeout: 15000 })
  } finally {
    await quitApp(app, page)
  }
})
