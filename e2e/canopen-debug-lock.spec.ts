// ci-covers:
//   src/frontend/components/_features/[workspace]/editor/device/canopen/lock.tsx
//   src/frontend/services/st-calls/insert-call.ts
/**
 * The CANopen pages and the ST call helpers during a debug session, opened through the test-only
 * seam: the network, node and slave pages are read-only with a note, the tabs, Expert view and
 * Export stay usable, a variable drop and "Insert call" leave the ST body unchanged, and all of it
 * comes back when the session closes.
 *
 * Needs a production build made with OPENPLC_E2E_DEBUG_SEAM=1 plus the preload copy; see
 * "Electron e2e" in CLAUDE.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Locator, type Page, test } from '@playwright/test'

import { windowSize } from './helpers/canopen-project'
import { shot } from './helpers/canopen-shots'
import { launch, PROJECT_NAME, quitApp, writeEthercatProject } from './helpers/ethercat-project'

type DebugSessionSeam = { open(): void; close(): void; isOpen(): boolean }

declare global {
  interface Window {
    __OPENPLC_E2E_DEBUG_SESSION__?: DebugSessionSeam
  }
}

const PROGRAM = `PROGRAM main
  VAR
    inputs AT %IB1 : BYTE;
    outputs AT %QB0 : BYTE;
    timer1 : TON;
  END_VAR

outputs := inputs;

END_PROGRAM
`

const STATION = { bus: join('canopen-generic-io', 'project', 'devices', 'remote', 'canopen_1.json'), program: PROGRAM }

const EDITOR = 'CANopen editor container'
const SLAVE_EDITOR = 'CANopen slave editor container'

async function openDebugSession(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => typeof window.__OPENPLC_E2E_DEBUG_SESSION__)).toBe('object')
  await page.evaluate(() => window.__OPENPLC_E2E_DEBUG_SESSION__?.open())
  await expect.poll(() => page.evaluate(() => window.__OPENPLC_E2E_DEBUG_SESSION__?.isOpen())).toBe(true)
}

async function closeDebugSession(page: Page): Promise<void> {
  await page.evaluate(() => window.__OPENPLC_E2E_DEBUG_SESSION__?.close())
  await expect.poll(() => page.evaluate(() => window.__OPENPLC_E2E_DEBUG_SESSION__?.isOpen())).toBe(false)
}

/** The form fields of @p container that can still be changed; Expert view only changes the view. */
const enabledFields = (container: Locator) =>
  container.locator(
    'input:enabled:not([type="file"]):not([aria-label="Expert view"]), select:enabled, textarea:enabled',
  )

const body = (page: Page) => page.locator('.view-lines:visible').last()
const bodyText = async (page: Page) => (await body(page).innerText()).replace(/ /g, ' ')

/** Drops variable @p name on the ST body as the variable table's drag does. */
async function dropVariable(page: Page, name: string): Promise<void> {
  await body(page).evaluate((target, variable) => {
    const box = target.getBoundingClientRect()
    const data = new DataTransfer()
    data.setData('application/x-plc-variable', variable)
    const at = { clientX: box.left + 20, clientY: box.top + 8, bubbles: true, cancelable: true, dataTransfer: data }
    target.dispatchEvent(new DragEvent('dragover', at))
    target.dispatchEvent(new DragEvent('drop', at))
  }, name)
}

test('the CANopen pages and the ST call helpers are locked during a debug session', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-debug-lock'), '', STATION)
  mkdirSync(join(project, 'devices', 'servers'), { recursive: true })
  const busFile = join(project, 'devices', 'remote', 'canopen_1.json')
  const slaveFile = join(project, 'devices', 'servers', 'slave.json')
  // The fixture slave on its own interface, so the network does not stop its build.
  const server: { canopenSlaveConfig: Record<string, unknown> } = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'canopen-slave', 'project', 'devices', 'servers', 'slave.json'), 'utf8'),
  )
  writeFileSync(
    slaveFile,
    JSON.stringify({ ...server, canopenSlaveConfig: { ...server.canopenSlaveConfig, interface: 'vcan1' } }, null, 2),
  )
  const savedBus = readFileSync(busFile, 'utf8')
  const savedSlave = readFileSync(slaveFile, 'utf8')
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })

    // The network and its node.
    await page.getByText('canopen_1', { exact: true }).first().click({ timeout: 30000 })
    const editor = page.getByLabel(EDITOR, { exact: true })
    await expect(page.getByText('Node 2: io2')).toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeEnabled()
    await openDebugSession(page)
    const notice = page.getByTestId('canopen-debug-lock')
    await expect(notice).toContainText('the CANopen network settings are read-only')
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Remove node' })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Add node/ }).first()).toBeDisabled()
    await expect(enabledFields(editor)).toHaveCount(0)
    await shot(page, 'debug-lock-node')
    const expert = page.getByRole('switch', { name: 'Expert view' })
    await expect(expert).toBeEnabled()
    await expert.click()
    await expect(page.getByRole('button', { name: 'Export...', exact: true })).toBeEnabled()
    await expect(enabledFields(editor)).toHaveCount(0)
    await shot(page, 'debug-lock-node-expert')
    await expert.click()

    await page.getByRole('tab', { name: /Startup SDOs/ }).click()
    await expect(page.getByRole('button', { name: 'Add by index' })).toBeDisabled()
    await expect(enabledFields(editor)).toHaveCount(0)
    await shot(page, 'debug-lock-sdos')

    await page.getByRole('tab', { name: 'Network' }).click()
    await expect(enabledFields(editor)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Export network...' })).toBeEnabled()
    await shot(page, 'debug-lock-network')

    await closeDebugSession(page)
    await expect(notice).toHaveCount(0)
    await expect(enabledFields(editor)).not.toHaveCount(0)
    await page.getByRole('tab', { name: 'Nodes' }).click()
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeEnabled()
    await shot(page, 'debug-lock-node-after')

    // The slave.
    await page.getByText('slave', { exact: true }).first().click({ timeout: 30000 })
    const slave = page.getByLabel(SLAVE_EDITOR, { exact: true })
    await expect(slave).toBeVisible({ timeout: 30000 })
    await expect(enabledFields(slave)).not.toHaveCount(0)
    await openDebugSession(page)
    await expect(notice).toContainText('the CANopen slave settings are read-only')
    await expect(page.getByRole('button', { name: /^Import/ })).toBeDisabled()
    await expect(page.getByRole('button', { name: /^Export/ })).toBeEnabled()
    await expect(enabledFields(slave)).toHaveCount(0)
    await shot(page, 'debug-lock-slave')
    await page.getByRole('tab', { name: 'Data' }).click()
    await expect(enabledFields(slave)).toHaveCount(0)
    await shot(page, 'debug-lock-slave-data')
    await closeDebugSession(page)
    await expect(notice).toHaveCount(0)
    await expect(enabledFields(slave)).not.toHaveCount(0)

    // Nothing above changed the saved project.
    expect(readFileSync(busFile, 'utf8')).toBe(savedBus)
    expect(readFileSync(slaveFile, 'utf8')).toBe(savedSlave)

    // The ST body: a drop and "Insert call" work before the session and insert nothing during it.
    await page.getByText('main', { exact: true }).first().click({ timeout: 30000 })
    await expect(body(page)).toContainText('outputs := inputs;', { timeout: 30000 })
    await dropVariable(page, 'timer1')
    await expect.poll(() => bodyText(page)).toContain('timer1(')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Z')
    await expect.poll(() => bodyText(page)).not.toContain('timer1(')

    await page.getByRole('button', { name: /code/i }).first().click()
    const declaration = page.locator('.view-lines:visible').first().getByText('timer1', { exact: false }).first()
    await declaration.click({ button: 'right' })
    await expect(page.getByText('Insert call', { exact: true })).toBeVisible({ timeout: 15000 })
    await page.keyboard.press('Escape')

    await openDebugSession(page)
    const before = await bodyText(page)
    await dropVariable(page, 'timer1')
    await page.waitForTimeout(500)
    expect(await bodyText(page)).toBe(before)
    await declaration.click({ button: 'right', force: true })
    await page.waitForTimeout(500)
    await expect(page.getByText('Insert call', { exact: true })).toHaveCount(0)
    await shot(page, 'debug-lock-insert-call')
    await page.keyboard.press('Escape')
    expect(await bodyText(page)).toBe(before)
    await closeDebugSession(page)
  } finally {
    await quitApp(app, page)
  }
})
