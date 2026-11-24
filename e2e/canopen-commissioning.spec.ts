// ci-covers:
//   src/frontend/components/_features/[workspace]/editor/device/canopen/commissioning/window.tsx
//   src/frontend/components/_features/[workspace]/editor/device/canopen/commissioning/device-panel.tsx
//   src/frontend/components/_features/[workspace]/editor/device/canopen/commissioning/add-to-project.tsx
//   src/frontend/components/_features/[workspace]/editor/device/canopen/device-memory-card.tsx
//   src/frontend/hooks/use-canopen-commissioning.ts
//   src/middleware/shared/utils/canopen/commissioning.ts
//   src/main/menu.ts
/**
 * File > CANopen device commissioning against a connected runtime: the bus opens in service mode for
 * commissioning (taking over the network kept at PLC stop), Find lists the devices, a device at node
 * 127 gets node ID 10 over LSS and a reset, saves its parameters after a retry in pre-operational,
 * and is added to the project. The runtime is a local fake (`helpers/canopen-runtime.ts`).
 *
 * Needs a production build plus the preload copy; see "Electron e2e" in CLAUDE.md. Port 8443 must be free.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ElectronApplication } from '@playwright/test'
import { expect, test } from '@playwright/test'

import {
  addNode,
  EDS_TEXT,
  EMPTY_STATION,
  openNetwork,
  windowSize,
  withOptionalObjects,
  writeEds,
} from './helpers/canopen-project'
import { fakeRuntime } from './helpers/canopen-runtime'
import { keyView, shot } from './helpers/canopen-shots'
import { connectRuntime, launch, quitApp, writeEthercatProject } from './helpers/ethercat-project'

const FEATURES = ['status', 'sdo', 'nmt', 'service', 'lss', 'commission']

const NVM_OBJECTS = `
[1010]
ParameterName=Store parameters
ObjectType=0x8
SubNumber=2

[1010sub0]
ParameterName=Highest sub-index supported
ObjectType=0x7
DataType=0x0005
AccessType=ro
DefaultValue=1
PDOMapping=0

[1010sub1]
ParameterName=Save all parameters
ObjectType=0x7
DataType=0x0007
AccessType=rw
DefaultValue=1
PDOMapping=0

[1011]
ParameterName=Restore default parameters
ObjectType=0x8
SubNumber=2

[1011sub0]
ParameterName=Highest sub-index supported
ObjectType=0x7
DataType=0x0005
AccessType=ro
DefaultValue=1
PDOMapping=0

[1011sub1]
ParameterName=Restore all default parameters
ObjectType=0x7
DataType=0x0007
AccessType=rw
DefaultValue=1
PDOMapping=0
`

type Device = { nodeId: number; serial: number; operational: boolean; given: number | null }

/**
 * The runtime's request route with a bus of generic I/O modules: node 1 and a new one at 127. A
 * network kept at PLC stop holds the interface until taken over; saves are refused while operational.
 */
class FakeBus {
  devices: Device[] = [
    { nodeId: 1, serial: 0x0101, operational: true, given: null },
    { nodeId: 127, serial: 0x7f7f, operational: true, given: null },
  ]
  kept = true
  requests: Array<Record<string, unknown>> = []
  private jobs = new Map<number, unknown>()
  private next = 1

  private at(node: unknown) {
    return this.devices.find((d) => d.nodeId === Number(node))
  }

  answer(request: Record<string, unknown>): unknown {
    this.requests.push(request)
    const job = (result: unknown) => {
      const id = this.next++
      this.jobs.set(id, result)
      return { job: id }
    }
    switch (request.op) {
      case 'service_open':
        if (this.kept && request.take_over !== true) return { error: 'network_on_interface', name: 'canopen_1' }
        this.kept = false
        return { ok: true, network: 0 }
      case 'service_close':
        return { ok: true }
      case 'scan':
        return job({
          state: 'done',
          devices: this.devices.map((d) => ({
            node_id: d.nodeId,
            answered: true,
            heard: ['heartbeat'],
            device_type: 401,
            vendor_id: 1,
            product_code: 2,
            revision: 3,
            serial_number: d.serial,
          })),
        })
      case 'lss': {
        if (request.action === 'set_id') {
          const device = this.devices.find((d) => d.serial === Number(request.serial_number))
          if (device) device.given = Number(request.node_id)
          return job({ state: 'done', previous_id: device?.nodeId ?? null, stored: true })
        }
        return job({ state: 'done', devices: [] })
      }
      case 'sdo_read': {
        const k = `${String(request.index)}:${String(request.subindex)}`
        const values: Record<string, string> = { '4112:0': '01', '4113:0': '01', '4112:1': '01000000' }
        const v = this.at(request.node) ? values[k] : undefined
        return job(v === undefined ? { state: 'failed', abort_code: 0x06020000 } : { state: 'done', data: v })
      }
      case 'sdo_write': {
        const device = this.at(request.node)
        if (device?.operational && Number(request.index) === 0x1010)
          return job({ state: 'failed', abort_code: 0x08000022 })
        return job({ state: 'done' })
      }
      case 'nmt': {
        const device = this.at(request.node)
        if (!device) return { ok: true }
        if (request.command === 'reset_node' && device.given !== null) {
          device.nodeId = device.given
          device.given = null
        }
        device.operational = request.command === 'start' || request.command === 'reset_node'
        return { ok: true }
      }
      case 'job':
        return this.jobs.get(Number(request.job)) ?? { error: 'unknown_job' }
      default:
        return { error: 'unknown_op' }
    }
  }
}

/** Clicks File > CANopen device commissioning... in the native menu. */
async function openCommissioning(app: ElectronApplication) {
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === 'File')
    const item = file?.submenu?.items.find((i) => i.label === 'CANopen device commissioning...')
    if (item === undefined) throw new Error('File > CANopen device commissioning... is not in the menu')
    item.click()
  })
}

test('commissioning: a new device gets node ID 10, saves its parameters and is added to the project', async () => {
  test.setTimeout(240000)
  const bus = new FakeBus()
  const runtime = fakeRuntime({
    features: FEATURES,
    configVersions: [15],
    plcState: () => 'STOPPED',
    status: () => ({ active: false }),
    request: (body) => bus.answer(body),
  })
  const { userData } = writeEthercatProject(
    join(tmpdir(), 'openplc-e2e-canopen-commission'),
    '127.0.0.1',
    EMPTY_STATION,
  )
  const text = withOptionalObjects(EDS_TEXT, [0x1010, 0x1011], NVM_OBJECTS).replace(
    'LSS_Supported=0',
    'LSS_Supported=1',
  )
  const eds = writeEds(join(userData, 'nvm-module.eds'), text)
  const { app, page } = await launch(userData)
  await windowSize(app, 1600, 1000)
  try {
    await openNetwork(page, () => connectRuntime(page, 'e2e', 'e2e'))
    await addNode(page, eds, 'Node 1: Generic_I_O_module')
    await openCommissioning(app)
    const win = page.getByTestId('canopen-commissioning')
    await expect(win.getByTestId('canopen-com-open')).toBeVisible({ timeout: 15000 })
    await shot(page, 'commissioning-closed')

    await win.getByTestId('canopen-com-open').click()
    const takeOver = win.getByTestId('canopen-com-take-over')
    await expect(takeOver).toContainText('The network canopen_1', { timeout: 15000 })
    await shot(page, 'commissioning-take-over')
    await takeOver.getByRole('button', { name: 'Leave the bus and open' }).click()
    await expect(win.getByTestId('canopen-com-bus-state')).toContainText('Open on', { timeout: 15000 })
    expect(bus.requests.filter((r) => r.op === 'service_open').at(-1)).toMatchObject({
      commission: true,
      take_over: true,
    })

    await win.getByTestId('canopen-com-find-button').click()
    await expect(win.getByTestId('canopen-com-find-result')).toContainText('2 devices answered.', { timeout: 15000 })
    await win.getByTestId('canopen-com-device-node:127').click()
    const lss = win.getByTestId('canopen-com-lss')
    await lss.getByLabel('New node ID').fill('10')
    await lss.getByTestId('canopen-com-set-id').click()
    const outcome = lss.getByTestId('canopen-com-lss-outcome')
    await expect(outcome).toContainText('Node ID 10 set and stored.', { timeout: 15000 })
    await keyView(page, 'commissioning-node-id-set', [], win)
    await outcome.getByRole('button', { name: 'Reset device' }).click()
    await expect.poll(() => bus.devices[1].nodeId).toBe(10)
    await win.getByTestId('canopen-com-find-button').click()
    await expect(win.getByTestId('canopen-com-device-node:10')).toHaveClass(/ring-green-500/, { timeout: 15000 })
    await expect(win.getByTestId('canopen-com-panel')).toContainText('Node 10', { timeout: 15000 })

    const memory = win.getByTestId('canopen-device-memory')
    await expect(memory.getByLabel('Scope to save')).toContainText('Save all parameters', { timeout: 15000 })
    await memory.getByRole('button', { name: 'Save to device' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save to device' }).click()
    await memory.getByRole('button', { name: 'Enter pre-operational and retry' }).click({ timeout: 15000 })
    await page.getByRole('alertdialog').getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(memory).toContainText('Save all parameters: done. The device is in pre-operational.', {
      timeout: 15000,
    })
    await memory.getByTestId('canopen-device-memory-offer').scrollIntoViewIfNeeded()
    await keyView(page, 'commissioning-saved', [], win)
    const saves = bus.requests.filter((r) => r.op === 'sdo_write' && r.index === 0x1010)
    expect(saves.map((r) => [r.node, r.data])).toEqual([
      [10, '73617665'],
      [10, '73617665'],
    ])

    await win.getByTestId('canopen-com-add').click()
    const dialog = page.getByTestId('canopen-com-add-dialog')
    await expect(dialog.getByLabel('Node ID')).toHaveValue('10')
    await shot(page, 'commissioning-add-to-project')
    await dialog.getByTestId('canopen-com-add-confirm').click()
    await expect(dialog).toHaveCount(0)
    await expect(win.getByTestId('canopen-com-added')).toContainText('as node 10: Generic_I_O_module_2.')
    await page.keyboard.press('Escape')
    await expect(win).toHaveCount(0)
    await expect.poll(() => bus.requests.some((r) => r.op === 'service_close')).toBe(true)
    await expect(page.getByText('10: Generic_I_O_module_2', { exact: true })).toBeVisible({ timeout: 15000 })
  } finally {
    await quitApp(app, page)
    runtime.close()
  }
})
