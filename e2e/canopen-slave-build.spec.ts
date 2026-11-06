/**
 * A CANopen slave created from the "+" menu: its General, Data and PDOs tabs, its EDS exported and
 * added to a network as a node, and the build of both into conf/canopen.json.
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md.
 */
import { readFileSync, rmSync } from 'node:fs'
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
    await page.getByLabel('When the PLC stops: NMT state').selectOption('pre_operational')
    // The network's library is on, so the program reaches the slave by name or number.
    await expect(page.getByTestId('canopen-slave-program')).toContainText('address this slave as slave (or 1)')
    await slaveKeyView(page, 'slave-general')
    await page.getByTestId('canopen-slave-program').scrollIntoViewIfNeeded()
    await shot(page, 'slave-general-program')

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
    // The check line wraps instead of cutting the file summary off.
    const clipped = await dialog
      .getByTestId('canopen-export-check')
      .evaluate((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight)
    expect(clipped).toBe(false)
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
      version: 12,
      networks: [{ interface: 'can0', nodes: [{ node_id: 1 }] }],
      devices: [
        {
          name: 'slave',
          interface: 'can1',
          node_id: 5,
          heartbeat_ms: 100,
          identity: { vendor_id: 0xabcd },
          on_plc_stop_state: 'pre_operational',
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

    // PDO 5-16: an object moved to TPDO 5, whose COB-ID the master gives or is fixed.
    await page
      .getByText(/^(\* )?slave$/)
      .filter({ visible: true })
      .first()
      .click()
    await page.getByRole('tab', { name: 'PDOs' }).click()
    const tpdos = page.getByTestId('canopen-slave-tpdos')
    for (let i = 0; i < 4; i++) await tpdos.getByRole('button', { name: /Add TPDO/ }).click()
    for (const n of [2, 3, 4]) await page.getByRole('button', { name: `Remove TPDO ${n}` }).click()
    await page.getByRole('button', { name: 'Move ToMaster to another PDO' }).click()
    await expect(page.getByRole('menuitem', { name: 'A new TPDO (TPDO 2)' })).toBeVisible()
    await slaveKeyView(page, 'slave-pdos-menu')
    await page.getByRole('menuitem', { name: 'TPDO 5' }).click()
    const tpdo5 = page.getByTestId('canopen-slave-tpdo5')
    await expect(tpdo5.getByLabel('COB-ID', { exact: true })).toHaveValue('not set')
    await expect(page.getByTestId('canopen-slave-tpdo1')).toContainText('No objects mapped')
    await tpdo5.scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-pdos-master-cob')
    await tpdo5.getByLabel('Given by the master').uncheck()
    const cob = tpdo5.getByLabel('COB-ID', { exact: true })
    await cob.fill('0x205')
    await cob.press('Enter')
    await expect(tpdo5).toContainText("TPDO 5: COB-ID 0x205 is already RPDO 1's")
    await slaveKeyView(page, 'slave-pdos-fixed-cob')
    await tpdo5.getByLabel('Given by the master').check()

    // An object in no default PDO stays mappable; the master maps it.
    await page.getByRole('button', { name: 'Take ToMaster out of TPDO 5' }).click()
    const byMaster = page.getByTestId('canopen-slave-tpdo-by-master')
    await expect(byMaster).toContainText('ToMaster')
    await byMaster.scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-pdos-by-master')
    await byMaster.getByRole('button', { name: 'Move ToMaster to another PDO' }).click()
    await page.getByRole('menuitem', { name: 'TPDO 5' }).click()
    await expect(tpdo5).toContainText('ToMaster')

    await page.getByRole('tab', { name: 'Data' }).click()
    await page.getByTestId('canopen-slave-to-master').getByRole('button', { name: 'TPDO 5' }).click()
    await expect(page.getByRole('tab', { name: 'PDOs' })).toHaveAttribute('aria-selected', 'true')
  } finally {
    await quitApp(app, page)
  }
})

test('LSS on a CANopen slave: waiting for the master, a fixed serial, the EDS flag and the build', async () => {
  test.setTimeout(300000)
  // No located variables: nothing on this slave produces them, and the build would refuse them.
  const station = {
    bus: STATION.bus,
    program: 'PROGRAM main\n  VAR\n    n : INT;\n  END_VAR\n\nn := n + 1;\n\nEND_PROGRAM\n',
  }
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-slave-lss'), '', station)
  // No master network: an empty one would stop the build.
  rmSync(join(project, 'devices', 'remote', 'canopen_1.json'))
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
    await expect(summary).toHaveText('can0, 500 kbit/s, node ID 5, 0 objects', { timeout: 30000 })
    await commitField(page, 'Vendor ID', '0xABCD')

    await expect(page.getByLabel('At first start', { exact: true })).toBeDisabled()
    await slaveKeyView(page, 'slave-lss-off')
    await page.getByLabel('An LSS master may set the node ID', { exact: true }).check()
    await slaveKeyView(page, 'slave-lss-on')
    await page.getByLabel('At first start', { exact: true }).selectOption('wait')
    await expect(page.getByLabel('Node ID', { exact: true })).toHaveValue('Set by the LSS master')
    await expect(page.getByLabel('Node ID', { exact: true })).toBeDisabled()
    await expect(summary).toHaveText('can0, 500 kbit/s, node ID from the LSS master, 0 objects')
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
      version: 12,
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

test('a CANopen slave byte packed as 8 bits: bit rows, aliases, defaults, the PDO and the build', async () => {
  test.setTimeout(300000)
  const station = {
    bus: STATION.bus,
    program:
      'PROGRAM main\n  VAR\n    valve AT %IX0.2 : BOOL;\n    lamp AT %QX0.0 : BOOL;\n  END_VAR\n\nlamp := valve;\n\nEND_PROGRAM\n',
  }
  const { project, userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-slave-bits'), '', station)
  rmSync(join(project, 'devices', 'remote', 'canopen_1.json'))
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
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
    await expect(page.getByTestId('canopen-slave-summary')).toContainText('0 objects', { timeout: 30000 })

    await page.getByRole('tab', { name: 'Data' }).click()
    const from = page.getByTestId('canopen-slave-from-master')
    const to = page.getByTestId('canopen-slave-to-master')
    await from.getByRole('button', { name: /Add object/ }).click()
    await from.getByRole('button', { name: /Add object/ }).click()
    await to.getByRole('button', { name: /Add object/ }).click()
    const valves = from.locator('tbody > tr').nth(1)
    await valves.getByLabel('Name').fill('Valves')
    await valves.getByLabel('Name').press('Enter')
    await valves.getByLabel('Type').selectOption('UNSIGNED8')
    await expect(valves.getByTestId('canopen-slave-address')).toHaveText('%IB0')
    await valves.getByLabel('Type').selectOption('PACKED')
    await expect(valves.getByTestId('canopen-slave-address')).toHaveText('%IX0.0-0.7')
    for (const [bit, name] of ['Valve 1', 'Valve 2', 'Valve 3', 'Valve 4'].entries()) {
      const field = from.getByLabel(`Name of bit ${bit}`, { exact: true })
      await field.fill(name)
      await field.press('Enter')
    }
    for (const [bit, alias] of [
      [0, 'valve_1'],
      [2, 'valve_3'],
    ] as const) {
      const field = from.getByLabel(`Alias of bit ${bit}`, { exact: true })
      await field.fill(alias)
      await field.press('Enter')
    }
    await from.getByLabel('Default of bit 0', { exact: true }).check()
    await from.getByLabel('Default of bit 7', { exact: true }).check()
    const lamps = to.locator('tbody > tr').first()
    await lamps.getByLabel('Name').fill('Lamps')
    await lamps.getByLabel('Name').press('Enter')
    await lamps.getByLabel('Type').selectOption('PACKED')
    await expect(lamps.getByTestId('canopen-slave-address')).toHaveText('%QX0.0-0.7')
    await lamps.getByRole('button', { name: 'Hide the bits of Lamps' }).click()
    await expect(page.getByTestId('canopen-slave-summary')).toContainText('3 objects')
    await page.getByRole('tab', { name: 'Data' }).scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-data-bits')

    await page.getByRole('tab', { name: 'PDOs' }).click()
    await expect(page.getByTestId('canopen-slave-rpdo1')).toContainText('Valves')
    await expect(page.getByTestId('canopen-slave-tpdo1')).toContainText('Lamps')
    await slaveKeyView(page, 'slave-pdos-bits')

    await buildFromMenu(page, 'Build only')
    const build = join(project, 'build')
    await expect.poll(() => findFile(build, 'canopen.json') !== undefined, { timeout: 180000 }).toBe(true)
    const conf: unknown = JSON.parse(readFileSync(findFile(build, 'canopen.json') ?? '', 'utf-8'))
    expect(conf).toMatchObject({
      version: 12,
      devices: [
        {
          name: 'slave',
          objects: [
            { index: 0x2000, subindex: 1, location: '%IW0' },
            {
              index: 0x2000,
              subindex: 2,
              type: 'UNSIGNED8',
              default: 129,
              bits: Array.from({ length: 8 }, (_, i) => `%IX0.${i}`),
            },
            { index: 0x2100, subindex: 1, type: 'UNSIGNED8', bits: Array.from({ length: 8 }, (_, i) => `%QX0.${i}`) },
          ],
          rpdos: [
            {
              entries: [
                { index: 0x2000, subindex: 1 },
                { index: 0x2000, subindex: 2 },
              ],
            },
          ],
          tpdos: [{ entries: [{ index: 0x2100, subindex: 1 }] }],
        },
      ],
    })
  } finally {
    await quitApp(app, page)
  }
})

test('XDD details of a CANopen slave: the expert view, the basic view mark, the EDS loss list and the XDD in a master', async () => {
  test.setTimeout(300000)
  const { userData } = writeEthercatProject(join(tmpdir(), 'openplc-e2e-canopen-slave-details'), '', STATION)
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
    await expect(page.getByTestId('canopen-slave-summary')).toContainText('0 objects', { timeout: 30000 })

    await page.getByRole('switch', { name: 'Expert view' }).check()
    const details = page.getByTestId('canopen-slave-device-details')
    await details.getByLabel('Product text').fill('Generic I/O node: a setpoint in, a temperature out.')
    await details.getByLabel('Product text').blur()
    await commitField(page, 'Order number', 'IO-100')
    await commitField(page, 'Hardware version', 'rev B')
    await details.getByRole('button', { name: /Characteristic/ }).click()
    await commitField(page, 'Name of characteristic 1', 'Supply')
    await commitField(page, 'Value of characteristic 1', '24 V DC')
    await details.scrollIntoViewIfNeeded()
    await slaveKeyView(page, 'slave-general-device-details')

    await page.getByRole('tab', { name: 'Data' }).click()
    const from = page.getByTestId('canopen-slave-from-master')
    const to = page.getByTestId('canopen-slave-to-master')
    await from.getByRole('button', { name: /Add object/ }).click()
    await to.getByRole('button', { name: /Add object/ }).click()
    const mode = from.locator('tbody > tr').first()
    await mode.getByLabel('Name').fill('Mode')
    await mode.getByLabel('Name').press('Enter')
    await mode.getByLabel('Type').selectOption('UNSIGNED8')
    await mode.getByRole('button', { name: 'Show the details of Mode' }).click()
    const modeStrip = from.locator('[data-testid^="canopen-slave-details-"]')
    await modeStrip.getByLabel('Description').fill('Operating mode the master selects.')
    await modeStrip.getByLabel('Description').blur()
    for (const [i, text] of ['Off', 'Manual', 'Auto'].entries()) {
      await modeStrip.getByRole('button', { name: 'Value', exact: true }).click()
      await modeStrip.getByLabel(`Meaning of ${i}`, { exact: true }).fill(text)
      await modeStrip.getByLabel(`Meaning of ${i}`, { exact: true }).press('Enter')
    }
    await modeStrip.getByLabel('Group').fill('Operation')
    await modeStrip.getByLabel('Group').press('Enter')
    await expect(mode).toContainText('0 · Off')
    await mode.scrollIntoViewIfNeeded()
    await shot(page, 'slave-data-meanings')

    const temp = to.locator('tbody > tr').first()
    await temp.getByLabel('Name').fill('Temperature')
    await temp.getByLabel('Name').press('Enter')
    await temp.getByRole('button', { name: 'Show the details of Temperature' }).click()
    const tempStrip = to.locator('[data-testid^="canopen-slave-details-"]')
    await tempStrip.getByLabel('Description').fill('Process temperature from the sensor on the tank outlet.')
    await tempStrip.getByLabel('Description').blur()
    await tempStrip.getByLabel('Unit').fill('°C')
    await tempStrip.getByLabel('Unit').press('Enter')
    await tempStrip.getByLabel('Multiplier').fill('0.1')
    await tempStrip.getByLabel('Multiplier').press('Enter')
    await tempStrip.getByLabel('Group').fill('Process values')
    await tempStrip.getByLabel('Group').press('Enter')
    await expect(tempStrip.getByTestId('canopen-slave-scale-example')).toContainText('Raw 100 = 10 °C')
    await slaveKeyView(page, 'slave-data-details')

    await page.getByRole('switch', { name: 'Expert view' }).uncheck()
    await expect(page.getByTestId('canopen-slave-details-mark')).toHaveCount(2)
    await slaveKeyView(page, 'slave-data-basic-mark')

    await page.getByRole('button', { name: 'Export EDS or XDD...' }).click()
    const dialog = page.getByTestId('canopen-export-dialog')
    await expect(dialog.getByTestId('canopen-export-losses')).toContainText('Descriptions of 2 objects')
    await dialog.getByTestId('canopen-export-losses-toggle').click()
    await expect(dialog.getByTestId('canopen-export-losses')).toContainText('Product text and 1 characteristic')
    await shot(page, 'slave-export-eds-losses')
    await dialog.getByRole('radio', { name: 'XDD' }).check()
    await expect(dialog.getByTestId('canopen-export-losses')).toHaveCount(0)
    await expect(dialog.getByTestId('canopen-export-check')).toContainText('OK')
    await dialog.getByTestId('canopen-export-save').click()
    await expect(dialog).toHaveCount(0)
    const xdd = await savedFile(app)
    expect(xdd.name).toBe(`${PROJECT_NAME}.xdd`)
    expect(xdd.text).toContain('<c:productText>')

    await page.getByText('canopen_1', { exact: true }).first().click()
    await page.getByTestId('canopen-eds-input').setInputFiles(writeEds(join(userData, xdd.name), xdd.text))
    const fileDialog = page.getByTestId('canopen-file-dialog')
    await expect(fileDialog.getByTestId('canopen-file-details')).toContainText('24 V DC')
    await expect(fileDialog.getByTestId('canopen-file-details')).toContainText('with a unit')
    await expect(fileDialog.getByTestId('canopen-file-details')).toContainText('with value meanings')
    await shot(page, 'slave-xdd-in-master')
  } finally {
    await quitApp(app, page)
  }
})
