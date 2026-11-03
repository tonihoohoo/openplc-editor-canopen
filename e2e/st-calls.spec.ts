/**
 * Function block and function calls in the ST editor: drag from the variable table, "Insert call"
 * from the variables code view, call completion, "next input" for an extensible function, the
 * "Remove empty parameters" quick fix and documentation hovers. Screenshots go to
 * test-results/st-calls-shots/.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { windowSize } from './helpers/canopen-project'
import { launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const SHOTS = join(__dirname, '..', 'test-results', 'st-calls-shots')

const PROGRAM = `PROGRAM main
  VAR
    timer1 : TON; (* pump delay *)
    start : BOOL;
    total : INT;
    a : INT;
    b : INT;
    c : INT;
  END_VAR

total := 0;

END_PROGRAM
`

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled', caret: 'initial' })

const body = (page: Page) => page.locator('.view-lines:visible').last()
const bodyText = async (page: Page) => (await body(page).innerText()).replace(/ /g, ' ')
const suggest = (page: Page) => page.locator('.suggest-widget.visible')

/** Replaces the body text and leaves the cursor at its end. */
async function setBody(page: Page, text: string) {
  await page.keyboard.press('Escape')
  await body(page).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Escape')
}

test('ST call helpers', async () => {
  test.setTimeout(300000)
  const root = join(tmpdir(), 'openplc-e2e-st-calls')
  const { project, userData } = writeEthercatProject(root, '', {
    bus: join('canopen-empty', 'canopen_1.json'),
    program: PROGRAM,
  })
  rmSync(join(project, 'devices', 'remote', 'canopen_1.json'))
  const { app, page } = await launch(userData)
  await windowSize(app, 1400, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByText('main', { exact: true }).first().click({ timeout: 30000 })
    await expect(body(page)).toContainText('total := 0;', { timeout: 30000 })
    await expect(page.locator('.squiggly-error')).toHaveCount(0, { timeout: 30000 })

    // 1. Drag timer1 by its # cell into the body.
    await setBody(page, '')
    const handle = page.getByTestId('variable-drag-handle').first()
    await handle.dragTo(body(page), { targetPosition: { x: 20, y: 8 } })
    await expect.poll(() => bodyText(page)).toContain('Q =>')
    expect(await bodyText(page)).toMatch(/timer1\(\s*IN := TRUE,\s*PT := T#100ms,\s*Q => ,\s*ET =>\s*\);/)
    await expect(page.getByTestId('variable-drag-handle')).toHaveCount(6)
    await shot(page, '01-drag-from-table')

    // 2. The call left with empty outputs is an error until fixed.
    await page.keyboard.press('Escape')
    await expect(page.locator('.squiggly-error').first()).toBeVisible({ timeout: 30000 })
    await shot(page, '02-empty-values-error')

    // 3. Quick fix: Remove empty parameters.
    await setBody(page, 'timer1(IN := start, PT := T#5s, Q => , ET => );')
    await page.keyboard.press('Home')
    await page.keyboard.press('Control+.')
    await expect(page.getByText('Remove empty parameters').first()).toBeVisible({ timeout: 15000 })
    await shot(page, '03-quick-fix-menu')
    await page.keyboard.press('Enter')
    await expect.poll(() => bodyText(page)).toContain('timer1(IN := start, PT := T#5s);')
    await expect(page.locator('.squiggly-error')).toHaveCount(0, { timeout: 30000 })
    await shot(page, '04-quick-fix-applied')
    await page.keyboard.press('Control+Z')
    await expect.poll(() => bodyText(page)).toContain('Q => , ET => );')

    // 4. Completion after a name.
    await setBody(page, '')
    await page.keyboard.type('tim')
    await page.keyboard.press('Control+Space')
    await expect(suggest(page)).toContainText('timer1 — all parameters', { timeout: 15000 })
    await shot(page, '05-name-completion')
    await page.keyboard.press('Escape')

    // 5. Inside empty parentheses.
    await setBody(page, '')
    await page.keyboard.type('timer1(')
    await expect(suggest(page)).toContainText('all parameters', { timeout: 15000 })
    await shot(page, '06-empty-parentheses')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await shot(page, '07-details-panel')
    await page.keyboard.press('Escape')

    // 6. One output added later.
    await setBody(page, 'timer1(IN := start, PT := T#5s);')
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type(',')
    await expect(suggest(page)).toContainText('Q =>', { timeout: 15000 })
    await shot(page, '08-add-output-later')
    await page.getByRole('option', { name: /Q =>/ }).click()
    await expect.poll(() => bodyText(page)).toContain('PT := T#5s, Q => );')

    // 7. ADD: next input in the unnamed form.
    await setBody(page, 'total := ADD(a, b);')
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type(', ')
    await page.keyboard.press('Control+Space')
    await expect(suggest(page)).toContainText('next input', { timeout: 15000 })
    await shot(page, '09-next-input')
    await page.keyboard.press('Escape')
    await page.keyboard.type('c')
    expect(await bodyText(page)).toContain('total := ADD(a, b, c);')

    // 8. Hovers.
    await setBody(page, 'timer1(IN := start, PT := T#5s);')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    const word = page.locator('.view-lines:visible .view-line span span', { hasText: 'timer1' }).first()
    await word.hover()
    await expect(page.locator('.monaco-hover:visible')).toContainText('pump delay', { timeout: 15000 })
    await expect(page.locator('.monaco-hover:visible')).toContainText('timer1 : TON')
    await page.waitForTimeout(500)
    await shot(page, '10-hover-instance')
    const box = await word.boundingBox()
    if (!box) throw new Error('no timer1 on screen')
    const charWidth = box.width / 'timer1'.length
    const column = 'timer1(IN := start, PT'.indexOf('PT')
    await page.mouse.move(box.x + charWidth * (column + 0.5), box.y + box.height / 2)
    await page.waitForTimeout(1500)
    await shot(page, '11-hover-parameter')

    // 9. Insert call from the variables code view.
    await setBody(page, 'total := 0;\n')
    await page.getByRole('button', { name: /code/i }).first().click()
    const declaration = page.locator('.view-lines:visible').first().getByText('timer1', { exact: false }).first()
    await declaration.click({ button: 'right' })
    await expect(page.getByText('Insert call', { exact: true })).toBeVisible({ timeout: 15000 })
    await shot(page, '12-insert-call-menu')
    await page.getByText('Insert call', { exact: true }).click()
    await expect.poll(() => bodyText(page)).toContain('timer1(')
    await shot(page, '13-insert-call-done')
  } finally {
    await quitApp(app, page)
  }
})
