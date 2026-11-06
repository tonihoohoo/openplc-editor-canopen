/**
 * Screenshots for the CANopen UI tests. `shot` saves a named full-window image for the pull request
 * comment; `keyView` also compares it with its baseline when CANOPEN_UI_VISUAL=1 (CI, Linux only).
 * A difference does not fail the test: it is recorded under KEY_VIEWS_DIR and the CI job fails at its end.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

/** Where the job collects the named screenshots for the pull request comment, one folder per spec. */
export const SHOTS_DIR = join(__dirname, '..', '..', 'test-results', 'canopen-shots')

/** One file per key view that differs from its baseline, holding the spec's path. */
export const KEY_VIEWS_DIR = join(__dirname, '..', '..', 'test-results', 'canopen-key-views')

const visual = process.env.CANOPEN_UI_VISUAL === '1'

/** The path of a named screenshot of the running spec. */
export function shotPath(name: string): string {
  const spec = basename(test.info().file).replace(/\.spec\.ts$/, '')
  mkdirSync(join(SHOTS_DIR, spec), { recursive: true })
  return join(SHOTS_DIR, spec, `${name}.png`)
}

/** Saves the window as `<name>.png` for the pull request comment, with the pointer moved off the controls. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0)
  await page.screenshot({ path: shotPath(name), animations: 'disabled', caret: 'hide' })
}

/**
 * A key view: saved like `shot`, and in CI the CANopen device editor (not the rest of the window) is
 * compared with `e2e/<spec>-snapshots/<name>-chromium-linux.png`. A difference is recorded, not thrown,
 * so the test goes on and is not retried for it.
 * @param mask parts that change between runs, such as times
 * @param container the element compared, by its label; the slave server page passes its own
 */
export async function keyView(
  page: Page,
  name: string,
  mask: Locator[] = [],
  container = 'CANopen editor container',
): Promise<void> {
  await shot(page, name)
  if (!visual) return
  try {
    await expect(page.getByLabel(container, { exact: true })).toHaveScreenshot(`${name}.png`, {
      animations: 'disabled',
      caret: 'hide',
      mask,
      stylePath: join(__dirname, 'canopen-shots.css'),
      maxDiffPixelRatio: 0.01,
      timeout: 15000,
    })
  } catch (error: unknown) {
    const first = error instanceof Error ? error.message.split('\n')[0] : String(error)
    mkdirSync(KEY_VIEWS_DIR, { recursive: true })
    writeFileSync(join(KEY_VIEWS_DIR, `${name}.txt`), `${test.info().file}\n${first}\n`)
  }
}
