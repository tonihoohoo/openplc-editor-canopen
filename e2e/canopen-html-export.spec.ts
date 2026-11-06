// ci-covers:
//   src/middleware/shared/utils/canopen/html-export.ts
//   src/frontend/components/_features/[workspace]/editor/device/canopen/export-options.tsx
/**
 * HTML documentation export: the network exported as one HTML document with its section options,
 * the saved document shown in a window of its own and printed to PDF on A4 landscape pages.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ElectronApplication, expect, type Page, test } from '@playwright/test'

import { EDS_TEXT, EMPTY_STATION, openNetwork, windowSize, writeEds } from './helpers/canopen-project'
import { shot, shotPath, SHOTS_DIR } from './helpers/canopen-shots'
import { launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

/** Answers the save dialog in the main process and keeps the text the editor saves. */
async function captureSaves(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const saved: Array<{ name: string; text: string }> = []
    Reflect.set(globalThis, '__htmlSaved', saved)
    ipcMain.removeHandler('project:export-file')
    ipcMain.handle('project:export-file', (_event, name: string, bytes: Uint8Array) => {
      saved.push({ name, text: Buffer.from(bytes).toString('utf-8') })
      return { success: true }
    })
  })
}

async function savedFile(app: ElectronApplication, index: number): Promise<{ name: string; text: string }> {
  const json = await app.evaluate((_electron, i) => {
    const saved: unknown = Reflect.get(globalThis, '__htmlSaved')
    return JSON.stringify(Array.isArray(saved) ? (saved[i] ?? null) : null)
  }, index)
  const file: unknown = JSON.parse(json)
  if (typeof file !== 'object' || file === null || !('name' in file) || !('text' in file)) return { name: '', text: '' }
  return { name: String(file.name), text: String(file.text) }
}

/** Opens the file in a new window of the app, without its preload, and returns that window's page. */
async function showDocument(app: ElectronApplication, path: string): Promise<Page> {
  await app.evaluate(({ BrowserWindow }, file) => {
    const win = new BrowserWindow({ width: 1280, height: 900, show: true, webPreferences: { javascript: false } })
    void win.loadFile(file)
  }, path)
  await expect.poll(() => app.windows().some((w) => w.url().endsWith('canopen_1.html'))).toBe(true)
  const page = app.windows().find((w) => w.url().endsWith('canopen_1.html'))
  if (!page) throw new Error('the document window did not open')
  await page.waitForLoadState('load')
  return page
}

test('a network is exported as an HTML document', async () => {
  test.setTimeout(240000)
  const root = join(tmpdir(), 'openplc-e2e-canopen-html')
  const { userData } = writeEthercatProject(root, '', EMPTY_STATION)
  const eds = writeEds(join(userData, 'generic-io-module.eds'), EDS_TEXT)
  const { app, page } = await launch(userData)
  await windowSize(app, 1280, 800)
  try {
    await openNetwork(page)
    await page.getByTestId('canopen-eds-input').setInputFiles(eds)
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText(/^Node \d+: /).first()).toBeVisible({ timeout: 15000 })

    await captureSaves(app)
    await page.getByRole('tab', { name: 'Network' }).click()
    await page.getByRole('button', { name: 'Export network...' }).click()
    const dialog = page.getByTestId('canopen-export-dialog')
    const height = (await dialog.boundingBox())?.height
    await dialog.locator('label', { hasText: /^HTML$/ }).click()
    await expect(dialog.getByTestId('canopen-export-format-description')).toContainText('document for people')
    await expect(dialog.getByTestId('canopen-export-check')).toContainText('canopen_1.html')
    await expect(dialog.getByTestId('canopen-export-html-objects')).toHaveAttribute('aria-checked', 'false')
    expect((await dialog.boundingBox())?.height).toBe(height)
    await shot(page, 'html-export-dialog')

    await dialog.getByTestId('canopen-export-html-objects').click()
    await expect(dialog.getByTestId('canopen-export-html-objects')).toHaveAttribute('aria-checked', 'true')
    await dialog.getByTestId('canopen-export-html-bootWrites').click()
    await expect(dialog.getByTestId('canopen-export-losses')).toContainText('the writes the master makes at boot')
    await shot(page, 'html-export-options')
    await dialog.getByTestId('canopen-export-html-bootWrites').click()
    await dialog.getByTestId('canopen-export-html-objects').click()
    await expect(dialog.getByTestId('canopen-export-save')).toHaveText('Save canopen_1.html...')
    await dialog.getByTestId('canopen-export-save').click()
    await expect(dialog).toHaveCount(0)

    const html = await savedFile(app, 0)
    expect(html.name).toBe('canopen_1.html')
    expect(html.text).toMatch(/^<!doctype html>/)
    expect(html.text).not.toMatch(/<script|https?:\/\//i)
    const file = join(userData, html.name)
    writeFileSync(file, html.text)

    const doc = await showDocument(app, file)
    await expect(doc.locator('h1')).toHaveText('CANopen network canopen_1')
    await expect(doc.locator('#io ~ table').first()).toContainText('NMT state')
    await expect(doc.locator('section.node')).toHaveCount(1)
    await doc.screenshot({ path: shotPath('html-document-top') })
    await doc.evaluate(() => document.querySelector('section.node')?.scrollIntoView())
    await doc.screenshot({ path: shotPath('html-document-node') })

    const pdf = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('canopen_1.html'))
      if (!win) return []
      const data = await win.webContents.printToPDF({ preferCSSPageSize: true })
      return Array.from(data)
    })
    writeFileSync(join(SHOTS_DIR, '..', 'canopen-html-print.pdf'), Buffer.from(pdf))
    const head = Buffer.from(pdf).toString('latin1')
    expect(head.startsWith('%PDF')).toBe(true)
    // A4 landscape is 842 x 595 points.
    const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(head)
    expect(Number(box?.[1])).toBeGreaterThan(Number(box?.[2]))
  } finally {
    await quitApp(app, page)
  }
})
