/**
 * A CANopen slave created from the "+" menu: its General, Data and PDOs tabs, its EDS exported and
 * added to a network as a node, and the build of both into conf/canopen.json.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ElectronApplication, expect, type Page, test } from '@playwright/test'

import { windowSize, writeEds } from './helpers/canopen-project'
import { keyView, shot } from './helpers/canopen-shots'
import {
  buildFromMenu,
  findFile,
  launch,
  PROJECT_NAME,
  quitApp,
  writeEthercatProject,
} from './helpers/ethercat-project'

const SLAVE_EDITOR = 'CANopen slave editor container'

const STATION = {
  bus: join('canopen-empty', 'canopen_1.json'),
  program:
    'PROGRAM main\n  VAR\n    setpoint AT %IW0 : INT;\n    echo AT %QW0 : INT;\n  END_VAR\n\necho := setpoint;\n\nEND_PROGRAM\n',
}

/** Answers the save dialog in the main process and keeps the text the editor saves. */
async function captureSaves(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const saved: Array<{ name: string; bytes: number[] }> = []
    Reflect.set(globalThis, '__slaveSaved', saved)
    ipcMain.removeHandler('project:export-file')
    ipcMain.handle('project:export-file', (_event, name: string, bytes: Uint8Array) => {
      saved.push({ name, bytes: Array.from(bytes) })
      return { success: true }
    })
  })
}

async function savedFile(app: ElectronApplication): Promise<{ name: string; text: string }> {
  const json = await app.evaluate(() => {
    const saved: unknown = Reflect.get(globalThis, '__slaveSaved')
    return JSON.stringify(Array.isArray(saved) ? (saved[0] ?? null) : null)
  })
  const file: unknown = JSON.parse(json)
  if (typeof file !== 'object' || file === null || !('name' in file) || !('bytes' in file))
    return { name: '', text: '' }
  const bytes = Array.isArray(file.bytes) ? file.bytes.filter((b): b is number => typeof b === 'number') : []
  return { name: String(file.name), text: Buffer.from(bytes).toString('utf-8') }
}

/** A key view of the slave page with no field focused, so no caret, focus ring or spelling mark shows. */
async function slaveKeyView(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await keyView(page, name, [], SLAVE_EDITOR)
}

async function commitField(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label, { exact: true }).first()
  await field.fill(value)
  await field.press('Enter')
}

test('a CANopen slave is created, edited, built and its EDS added to a network', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-slave'), '', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  await captureSaves(app)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByLabel('Create PLC element trigger component').click({ timeout: 30000 })
    // The server card opens on hover as well as on click, so a click may close it again.
    const serverCard = page.locator('#create-server-trigger')
    const serverName = page.getByPlaceholder('Server name')
    await serverCard.hover()
    const opened = await serverName.waitFor({ timeout: 3000 }).then(
      () => true,
      () => false,
    )
    if (!opened) await serverCard.click()
    await serverName.fill('slave')
    await page.getByLabel('server-protocol').click()
    await page.getByRole('option', { name: 'CANopen slave' }).click()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const slaveInTree = page.getByText('slave', { exact: true }).first()
    await slaveInTree.click({ timeout: 30000 })

    const summary = page.getByTestId('canopen-slave-summary')
    // The network has can0, so the new slave takes the next interface.
    await expect(summary).toHaveText('can1, 500 kbit/s, node ID 5, 0 objects', { timeout: 30000 })
    await commitField(page, 'Heartbeat (ms)', '100')
    await commitField(page, 'Vendor ID', '0xABCD')
    await slaveKeyView(page, 'slave-general')

    await page.getByRole('tab', { name: 'Data' }).click()
    const from = page.getByTestId('canopen-slave-from-master')
    const to = page.getByTestId('canopen-slave-to-master')
    await from.getByRole('button', { name: /Add object/ }).click()
    await from.getByRole('button', { name: /Add object/ }).click()
    await to.getByRole('button', { name: /Add object/ }).click()
    await expect(from.getByTestId('canopen-slave-address').first()).toHaveText('%IW0')
    await expect(to.getByTestId('canopen-slave-address').first()).toHaveText('%QW0')
    const second = from.locator('tbody tr').nth(1)
    await second.getByLabel('Name').fill('Limit')
    await second.getByLabel('Name').press('Enter')
    await second.getByLabel('Type').selectOption('UNSIGNED16')
    await second.getByLabel('Exchange').selectOption('sdo')
    await second.getByLabel('Default').fill('1000')
    await second.getByLabel('Default').press('Enter')
    await second.getByLabel('Minimum').fill('100')
    await second.getByLabel('Minimum').press('Enter')
    await second.getByLabel('Maximum').fill('30000')
    await second.getByLabel('Maximum').press('Enter')
    await to.locator('tbody tr').first().getByLabel('Alias').fill('slave_echo')
    await to.locator('tbody tr').first().getByLabel('Alias').press('Enter')
    await expect(summary).toHaveText('can1, 500 kbit/s, node ID 5, 3 objects')
    await slaveKeyView(page, 'slave-data')

    await page.getByRole('tab', { name: 'PDOs' }).click()
    await expect(page.getByTestId('canopen-slave-rpdo1')).toContainText('0x205')
    await expect(page.getByTestId('canopen-slave-tpdo1')).toContainText('0x185')
    await page.getByTestId('canopen-slave-tpdo1').scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-pdos')

    await page.getByRole('button', { name: 'Export EDS or XDD...' }).click()
    const dialog = page.getByTestId('canopen-export-dialog')
    await expect(dialog.getByTestId('canopen-export-check')).toContainText('CiA 306 OK')
    await shot(page, 'slave-export')
    await dialog.getByTestId('canopen-export-save').click()
    await expect(dialog).toHaveCount(0)
    const eds = await savedFile(app)
    expect(eds.name).toBe(`${PROJECT_NAME}.eds`)
    expect(eds.text).toContain('VendorNumber=0x0000ABCD')

    await page.getByText('canopen_1', { exact: true }).first().click()
    await page.getByTestId('canopen-eds-input').setInputFiles(writeEds(join(userData, eds.name), eds.text))
    const fileDialog = page.getByTestId('canopen-file-dialog')
    await expect(fileDialog).toContainText('File check (CiA 306)')
    await shot(page, 'slave-eds-in-master')
    await page.getByTestId('canopen-file-dialog-confirm').click()
    await expect(page.getByText(/^Node 1: /)).toBeVisible({ timeout: 15000 })
    await shot(page, 'slave-node-in-master')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      version: 7,
      networks: [{ interface: 'can0', nodes: [{ node_id: 1 }] }],
      devices: [
        {
          name: 'slave',
          interface: 'can1',
          node_id: 5,
          heartbeat_ms: 100,
          identity: { vendor_id: 0xabcd },
          objects: [
            { index: 0x2000, subindex: 1, exchange: 'pdo', location: '%IW0' },
            { index: 0x2000, subindex: 2, exchange: 'sdo', type: 'UNSIGNED16', default: 1000, min: 100, max: 30000 },
            { index: 0x2100, subindex: 1, exchange: 'pdo', location: '%QW0' },
          ],
          rpdos: [{ cob_id: 0x205, entries: [{ index: 0x2000, subindex: 1 }] }],
          tpdos: [{ cob_id: 0x185, entries: [{ index: 0x2100, subindex: 1 }] }],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})

test('LSS on a CANopen slave: waiting for the master, a fixed serial, the EDS flag and the build', async () => {
  test.setTimeout(300000)
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-slave-lss'), '', STATION)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  await captureSaves(app)
  try {
    await page.getByText(PROJECT_NAME, { exact: true }).first().click({ timeout: 30000 })
    await page.getByLabel('Create PLC element trigger component').click({ timeout: 30000 })
    const serverCard = page.locator('#create-server-trigger')
    const serverName = page.getByPlaceholder('Server name')
    await serverCard.hover()
    const opened = await serverName.waitFor({ timeout: 3000 }).then(
      () => true,
      () => false,
    )
    if (!opened) await serverCard.click()
    await serverName.fill('slave')
    await page.getByLabel('server-protocol').click()
    await page.getByRole('option', { name: 'CANopen slave' }).click()
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.getByText('slave', { exact: true }).first().click({ timeout: 30000 })
    const summary = page.getByTestId('canopen-slave-summary')
    await expect(summary).toHaveText('can1, 500 kbit/s, node ID 5, 0 objects', { timeout: 30000 })
    await commitField(page, 'Vendor ID', '0xABCD')

    await page.getByLabel('An LSS master may set the node ID', { exact: true }).check()
    await slaveKeyView(page, 'slave-lss-on')
    await page.getByLabel('At first start', { exact: true }).selectOption('wait')
    await expect(page.getByLabel('Node ID', { exact: true })).toHaveValue('Set by the LSS master')
    await expect(page.getByLabel('Node ID', { exact: true })).toBeDisabled()
    await expect(summary).toHaveText('can1, 500 kbit/s, node ID from the LSS master, 0 objects')
    await page.getByLabel('Serial number', { exact: true }).selectOption('fixed')
    await commitField(page, 'Fixed serial number', '0')
    await expect(page.getByText('The serial number is part of the LSS address and cannot be 0.')).toBeVisible()
    await commitField(page, 'Fixed serial number', '0x17')
    await expect(page.getByLabel('Fixed serial number', { exact: true })).toHaveValue('0x00000017')
    await page.getByLabel('The master may change the bit rate', { exact: true }).uncheck()
    await slaveKeyView(page, 'slave-lss-wait')

    await page.getByRole('button', { name: 'Export EDS or XDD...' }).click()
    const dialog = page.getByTestId('canopen-export-dialog')
    await expect(dialog.getByTestId('canopen-export-check')).toContainText('CiA 306 OK')
    await dialog.getByTestId('canopen-export-save').click()
    await expect(dialog).toHaveCount(0)
    const eds = await savedFile(app)
    expect(eds.text).toContain('LSS_Supported=1')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      version: 7,
      devices: [
        {
          name: 'slave',
          node_id: 5,
          lss: { enabled: true, wait_for_master: true, serial: 0x17, bitrate_change: false },
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})
