/**
 * Screenshots for the CANopen UI tests. `shot` saves a named full-window image for the pull request
 * comment; `keyView` also compares it with its baseline when CANOPEN_UI_VISUAL=1 (CI, Linux only).
 */
import { join } from 'node:path'

import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/** Where the job collects the named screenshots for the pull request comment. */
export const SHOTS_DIR = join(__dirname, '..', '..', 'test-results', 'canopen-shots')

const visual = process.env.CANOPEN_UI_VISUAL === '1'

/** Saves the window as `<name>.png` for the pull request comment, with the pointer moved off the controls. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

/**
 * A key view: saved like `shot`, and in CI the CANopen device editor (not the rest of the window) is
 * compared with `e2e/<spec>-snapshots/<name>-chromium-linux.png`.
 * @param mask parts that change between runs, such as times
 */
export async function keyView(page: Page, name: string, mask: Locator[] = []): Promise<void> {
  await shot(page, name)
  if (!visual) return
  await expect(page.getByLabel('CANopen editor container')).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    caret: 'hide',
    mask,
    stylePath: join(__dirname, 'canopen-shots.css'),
    maxDiffPixelRatio: 0.01,
    timeout: 15000,
  })
}
