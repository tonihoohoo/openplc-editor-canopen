/**
 * The CANopen editor scrolls as one area: node tabs have no scroll box of their own, the node's tab
 * bar and the node list stay in view, and a tab switch far down starts the new tab under the bar.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { expect, type Locator, type Page, test } from '@playwright/test'

import { FakeNode, openDevice } from './helpers/canopen-online-node'
import { keyView, shot } from './helpers/canopen-shots'
import { quitApp } from './helpers/ethercat-project'

const FEATURES = ['status', 'sdo', 'nmt', 'service']

/** Elements in the editor that scroll vertically, the editor container included. */
async function verticalScrollers(editor: Locator): Promise<string[]> {
  return editor.evaluate((root) =>
    [root, ...Array.from(root.querySelectorAll('*'))]
      .filter((el) => {
        const { overflowY } = getComputedStyle(el)
        return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1
      })
      .map((el) => el.getAttribute('aria-label') ?? el.tagName),
  )
}

async function wheel(page: Page, editor: Locator, dy: number): Promise<void> {
  const box = await editor.boundingBox()
  if (!box) throw new Error('editor not shown')
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height - 40)
  await page.mouse.wheel(0, dy)
  await expect.poll(() => editor.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.mouse.move(0, 0)
}

/** Distance of @p locator's top from the editor's top edge, in pixels. */
async function topIn(editor: Locator, locator: Locator): Promise<number> {
  const [outer, inner] = await Promise.all([editor.boundingBox(), locator.boundingBox()])
  if (!outer || !inner) throw new Error('not shown')
  return inner.y - outer.y
}

test('the CANopen editor scrolls as one area with the tab bar and node list in view', async () => {
  test.setTimeout(180000)
  const node = new FakeNode()
  const { app, page, runtime } = await openDevice(FEATURES, 'openplc-e2e-canopen-scrolling', node)
  try {
    const editor = page.getByLabel('CANopen editor container')
    const tabBar = page.getByTestId('canopen-node-panel').getByRole('tablist')
    await expect(page.getByText('Console', { exact: true }).first()).toBeVisible()

    await page.getByRole('tab', { name: 'Online' }).click()
    await page.getByRole('button', { name: 'Read all' }).click()
    await expect(page.getByTestId('canopen-online-value-4119:0')).toHaveText('500', { timeout: 15000 })
    expect(await verticalScrollers(editor)).toEqual(['CANopen editor container'])

    await wheel(page, editor, 600)
    expect(Math.abs(await topIn(editor, tabBar))).toBeLessThan(2)
    await expect(page.getByLabel('CANopen nodes')).toBeInViewport()
    const visibleRows = await editor.evaluate((root) => {
      const view = root.getBoundingClientRect()
      return Array.from(root.querySelectorAll('[data-testid^="canopen-online-row-"]')).filter((row) => {
        const r = row.getBoundingClientRect()
        return r.top >= view.top && r.bottom <= view.bottom
      }).length
    })
    expect(visibleRows).toBeGreaterThanOrEqual(10)
    // A 600 px wheel lands on 584 or 600; pin the offset so the key view is stable.
    await editor.evaluate((el) => {
      el.scrollTop = 584
    })
    await expect.poll(() => editor.evaluate((el) => el.scrollTop)).toBe(584)
    await keyView(page, 'scrolled-online')

    await wheel(page, editor, 20000)
    expect(Math.abs(await topIn(editor, tabBar))).toBeLessThan(2)

    await page.getByRole('tab', { name: /^Inputs/ }).click()
    const barTop = await topIn(editor, tabBar)
    expect(barTop).toBeGreaterThanOrEqual(0)
    const barHeight = (await tabBar.boundingBox())?.height ?? 0
    const pdoTop = await topIn(editor, page.getByTestId('canopen-pdo-input-1'))
    expect(pdoTop - barTop).toBeGreaterThan(0)
    expect(pdoTop - barTop).toBeLessThan(barHeight + 60)
    await shot(page, 'scrolled-switch-to-inputs')

    await page.getByRole('tab', { name: 'Network', exact: true }).click()
    expect(await verticalScrollers(editor)).toEqual(['CANopen editor container'])
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
