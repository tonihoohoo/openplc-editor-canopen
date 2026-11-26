import { act, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenRequest } from '@root/middleware/shared/ports/canopen-online'
import type { CanopenRuntimeFetch } from '@root/middleware/shared/ports/canopen-status'
import type { CanopenEdsInfo, CanopenObject } from '@root/middleware/shared/ports/canopen-types'
import {
  canopenDevice,
  configWith,
  genericIoEds,
  genericNode,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenCommissioningWindow } from '../commissioning/window'

const FEATURES = {
  canopen: { configVersions: [15], features: ['status', 'sdo', 'nmt', 'service', 'lss', 'commission'] },
}
const IO = genericIoEds()

const nvm = (index: number, subIndex: number, name: string): CanopenObject => ({
  index,
  subIndex,
  name,
  dataType: 'UNSIGNED32',
  access: 'rw',
  pdoMapping: false,
})

type Scanned = { node_id: number; answered: boolean; heard: string[]; serial: number }

/** A runtime's request route with a simulated bus of devices with node IDs. */
class FakeBus {
  sent: CanopenRequest[] = []
  devices: Scanned[] = [
    { node_id: 10, answered: true, heard: ['heartbeat'], serial: 0x0a0a },
    { node_id: 127, answered: true, heard: [], serial: 0x7f7f },
  ]
  /** The first open is refused naming a network kept at PLC stop. */
  keptNetwork: string | null = null
  values = new Map<string, string>([
    ['4112:0', '03'],
    ['4113:0', '01'],
    ['4112:1', '01000000'],
    ['4112:2', '01000000'],
    ['4112:3', '01000000'],
  ])
  nvmAbort: number | null = null
  /** An abort every SDO read gets, as when the link is down. */
  readAbort: number | null = null
  /** Service mode ended on the runtime: requests answer that no network runs. */
  gone = false
  operational = true
  links = [
    { name: 'can0', kind: 'can', up: true, bitrate: 125000 },
    { name: 'can1', kind: 'can', up: false, bitrate: 0 },
    { name: 'vcan0', kind: 'vcan', up: true, bitrate: 0 },
  ]
  private jobs = new Map<number, unknown>()
  private next = 1

  handle = (request: CanopenRequest): Promise<CanopenRuntimeFetch> => {
    this.sent.push(request)
    const job = (result: unknown) => {
      const id = this.next++
      this.jobs.set(id, result)
      return { job: id }
    }
    const body = (() => {
      if (this.gone && request.op !== 'service_open' && request.op !== 'service_close' && request.op !== 'job')
        return { error: 'not_running' }
      switch (request.op) {
        case 'service_open':
          if (this.keptNetwork && !request.take_over) return { error: 'network_on_interface', name: this.keptNetwork }
          return { ok: true, network: 0 }
        case 'service_close':
          return { ok: true }
        case 'interfaces':
          return { interfaces: this.links }
        case 'scan':
          return job({
            state: 'done',
            devices: this.devices.map((d) => ({
              node_id: d.node_id,
              answered: d.answered,
              heard: d.heard,
              device_type: d.answered ? IO.deviceType : null,
              vendor_id: d.answered ? IO.vendorId : null,
              product_code: d.answered ? IO.productCode : null,
              revision: d.answered ? IO.revision : null,
              serial_number: d.answered ? d.serial : null,
            })),
          })
        case 'lss':
          return job({ state: 'done', devices: [], previous_id: 127, stored: true })
        case 'sdo_read': {
          if (this.readAbort !== null) return job({ state: 'failed', abort_code: this.readAbort })
          const v = this.values.get(`${request.index}:${request.subindex}`)
          return job(v === undefined ? { state: 'failed', abort_code: 0x06020000 } : { state: 'done', data: v })
        }
        case 'sdo_write':
          if ((request.index === 0x1010 || request.index === 0x1011) && this.nvmAbort !== null && this.operational)
            return job({ state: 'failed', abort_code: this.nvmAbort })
          this.values.set(`${request.index}:${request.subindex}`, request.data)
          return job({ state: 'done' })
        case 'nmt':
          this.operational = request.command === 'start'
          return { ok: true }
        case 'job':
          return this.jobs.get(request.job) ?? { error: 'unknown_job' }
        default:
          return { error: 'unknown_op' }
      }
    })()
    return Promise.resolve({ success: true, body })
  }
}

let store: OpenPLCStore
let bus: FakeBus

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function renderWindow(
  options: {
    features?: string[]
    plc?: 'RUNNING' | 'STOPPED'
    eds?: Partial<CanopenEdsInfo>
    noProjectFile?: boolean
    networkBitrate?: number
    setup?: (b: FakeBus) => void
  } = {},
) {
  store = createTestStore()
  bus = new FakeBus()
  options.setup?.(bus)
  const state = store.getState()
  const base = genericNode(2)
  const node = {
    ...base,
    eds: {
      ...base.eds,
      lssSupported: true,
      objects: [
        ...base.eds.objects,
        nvm(0x1010, 1, 'Save all parameters'),
        nvm(0x1011, 1, 'Restore all default parameters'),
      ],
      ...options.eds,
    },
  }
  const config = configWith(...(options.noProjectFile ? [] : [node]))
  const net = {
    ...config,
    network: { ...config.network, interface: 'can0', bitrate: options.networkBitrate ?? 125000 },
  }
  store.setState({
    project: {
      ...state.project,
      meta: { ...state.project.meta, path: '/tmp/p' },
      data: { ...state.project.data, remoteDevices: [canopenDevice('machine', net)] },
    },
  })
  state.deviceActions.setRuntimeJwtToken('token')
  state.deviceActions.setRuntimeConnectionStatus('connected')
  state.deviceActions.setPlcRuntimeStatus(options.plc ?? 'STOPPED')
  state.modalActions.openModal('canopen-commissioning', null)
  const features = options.features ?? FEATURES.canopen.features
  const ports = portsWithRuntime({
    getCanopenCapabilities: () => ok({ canopen: { configVersions: [15], features } }),
    getCanopenStatus: () => ok({ version: 1, active: true, now: 0, networks: [] }),
    canopenRequest: bus.handle,
  })
  render(<CanopenCommissioningWindow />, { wrapper: createStoreWrapper(store, ports) })
  await settle()
}

async function openAndFind() {
  fireEvent.click(screen.getByTestId('canopen-com-open'))
  await settle()
  fireEvent.click(screen.getByTestId('canopen-com-find-button'))
  await settle()
  await settle()
}

const pick = async (key: string) => {
  fireEvent.click(screen.getByTestId(`canopen-com-device-${key}`))
  await settle()
}

describe('CANopen device commissioning window', () => {
  it('says why it offers nothing on a runtime without commissioning', async () => {
    await renderWindow({ features: ['status', 'sdo'] })
    expect(screen.getByTestId('canopen-com-block').textContent).toContain('does not support device commissioning')
  })

  it('says to stop the PLC first while it runs', async () => {
    await renderWindow({ plc: 'RUNNING' })
    expect(screen.getByTestId('canopen-com-block').textContent).toContain('Stop the PLC first')
    expect(screen.queryByTestId('canopen-com-open')).toBeNull()
  })

  it('opens the bus for commissioning at the rate of the network on the interface', async () => {
    await renderWindow({ networkBitrate: 500000 })
    expect(screen.getByLabelText('Bit rate')).toHaveProperty('value', '500000')
    fireEvent.click(screen.getByTestId('canopen-com-open'))
    await settle()
    expect(bus.sent[0]).toMatchObject({ op: 'service_open', interface: 'can0', bitrate: 500000, commission: true })
    expect(screen.getByTestId('canopen-com-bus-state').textContent).toContain('Open on can0 at 500 kbit/s')
  })

  it('asks before taking over a network kept at PLC stop', async () => {
    await renderWindow({ setup: (b) => (b.keptNetwork = 'machine') })
    fireEvent.click(screen.getByTestId('canopen-com-open'))
    await settle()
    const ask = screen.getByTestId('canopen-com-take-over')
    expect(ask.textContent).toContain('The network machine on can0 leaves the bus until the next PLC start')
    fireEvent.click(within(ask).getByRole('button', { name: 'Leave the bus and open' }))
    await settle()
    expect(bus.sent[1]).toMatchObject({ op: 'service_open', commission: true, take_over: true })
    expect(screen.getByTestId('canopen-com-bus-state').textContent).toContain('Open on can0')
  })

  it('finds devices by scan and LSS, names the matching file and blocks the bit rate with two', async () => {
    await renderWindow()
    await openAndFind()
    expect(bus.sent.map((s) => s.op)).toEqual(['service_open', 'scan', 'job', 'lss', 'job'])
    expect(screen.getByTestId('canopen-com-find-result').textContent).toContain('2 devices answered.')
    expect(screen.getByTestId('canopen-com-device-node:10').textContent).toContain(`Node 10: ${IO.productName}`)
    await pick('node:127')
    expect(screen.getByTestId('canopen-com-bitrate-block').textContent).toContain('must be alone on the link')
    expect(screen.getByTestId('canopen-com-set-bitrate')).toHaveProperty('disabled', true)
  })

  it('refuses an ID in use, then gives a new node ID stored, and resets the device', async () => {
    await renderWindow()
    await openAndFind()
    await pick('node:127')
    const lss = screen.getByTestId('canopen-com-lss')
    fireEvent.change(within(lss).getByLabelText('New node ID'), { target: { value: '10' } })
    fireEvent.click(within(lss).getByTestId('canopen-com-set-id'))
    await settle()
    expect(within(lss).getByTestId('canopen-com-lss-outcome').textContent).toBe('Node 10 is already on the bus.')
    fireEvent.change(within(lss).getByLabelText('New node ID'), { target: { value: '20' } })
    fireEvent.click(within(lss).getByTestId('canopen-com-set-id'))
    await settle()
    expect(bus.sent).toContainEqual(
      expect.objectContaining({ op: 'lss', action: 'set_id', node_id: 20, store: true, serial_number: 0x7f7f }),
    )
    expect(within(lss).getByTestId('canopen-com-lss-outcome').textContent).toContain(
      'Node ID 20 set and stored. The device keeps node 127 until it is reset',
    )
    fireEvent.click(within(lss).getByRole('button', { name: 'Reset device' }))
    await settle()
    expect(bus.sent).toContainEqual({ op: 'nmt', network: 0, node: 127, command: 'reset_node' })
    expect(within(lss).getByTestId('canopen-com-lss-outcome').textContent).toContain(
      'Find devices to see it as node 20.',
    )
    bus.devices[1].node_id = 20
    fireEvent.click(screen.getByTestId('canopen-com-find-button'))
    await settle()
    expect(screen.getByTestId('canopen-com-device-node:20').className).toContain('ring-green-500')
    expect(within(screen.getByTestId('canopen-com-panel')).getByText(/^Node 20$/i)).toBeTruthy()
  })

  it('sets the bit rate of the only device after the confirmation and offers to reopen the bus', async () => {
    await renderWindow({ setup: (b) => (b.devices = [b.devices[1]]) })
    await openAndFind()
    await pick('node:127')
    const lss = screen.getByTestId('canopen-com-lss')
    fireEvent.change(within(lss).getByLabelText('New bit rate'), { target: { value: '250000' } })
    expect(within(lss).getByTestId('canopen-com-set-bitrate')).toHaveProperty('disabled', true)
    fireEvent.click(within(lss).getByLabelText('This device is the only one on the link'))
    fireEvent.click(within(lss).getByTestId('canopen-com-set-bitrate'))
    await settle()
    expect(bus.sent).toContainEqual(expect.objectContaining({ op: 'lss', action: 'set_bitrate', bitrate: 250000 }))
    expect(within(lss).getByTestId('canopen-com-lss-outcome').textContent).toContain('cycle its power')
    fireEvent.click(within(lss).getByRole('button', { name: 'Open the bus at 250 kbit/s' }))
    await settle()
    expect(bus.sent.filter((s) => s.op === 'service_open').at(-1)).toMatchObject({ bitrate: 250000 })
  })

  it('disables the LSS controls when the device file says no LSS', async () => {
    await renderWindow({ eds: { lssSupported: false } })
    await openAndFind()
    await pick('node:10')
    expect(screen.getByTestId('canopen-com-lss-off').textContent).toContain('does not support LSS')
    expect(screen.getByTestId('canopen-com-set-id')).toHaveProperty('disabled', true)
  })

  it('saves to the device, retrying in pre-operational', async () => {
    await renderWindow({ setup: (b) => (b.nvmAbort = 0x08000022) })
    await openAndFind()
    await pick('node:10')
    await settle()
    const card = screen.getByTestId('canopen-device-memory')
    fireEvent.click(within(card).getByRole('button', { name: 'Save to device' }))
    fireEvent.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Save to device' }))
    expect(within(card).getByRole('status').textContent).toMatch(/: saving\.\.\.$/)
    expect(within(card).getByRole('button', { name: 'Save to device' })).toHaveProperty('disabled', true)
    await settle()
    fireEvent.click(within(card).getByRole('button', { name: 'Enter pre-operational and retry' }))
    fireEvent.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Retry' }))
    await settle()
    await settle()
    expect(bus.sent).toContainEqual({ op: 'nmt', network: 0, node: 10, command: 'pre_operational' })
    const saves = bus.sent.filter((s) => s.op === 'sdo_write' && s.index === 0x1010)
    expect(saves).toHaveLength(2)
    expect(saves[1]).toMatchObject({ node: 10, subindex: 1, data: '73617665' })
    expect(card.textContent).toContain('Save all parameters: done. The device is in pre-operational.')
  })

  it('without a device file, lists the scopes the device reports and reads objects by index', async () => {
    await renderWindow({ noProjectFile: true })
    await openAndFind()
    await pick('node:10')
    await settle()
    await settle()
    const card = screen.getByTestId('canopen-device-memory')
    const scopes = within(within(card).getByLabelText('Scope to save'))
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(scopes).toEqual(['All parameters', 'Communication parameters', 'Application parameters'])
    expect(screen.getByTestId('canopen-com-device-node:10').textContent).toContain('No device file in the project')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Objects' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Objects' }))
    expect(screen.getByTestId('canopen-online-raw')).toBeTruthy()
  })

  it('adds the device to the project, warning about another bit rate', async () => {
    await renderWindow({ networkBitrate: 500000 })
    fireEvent.change(screen.getByLabelText('Bit rate'), { target: { value: '125000' } })
    await openAndFind()
    await pick('node:10')
    fireEvent.click(screen.getByTestId('canopen-com-add'))
    await settle()
    const dialog = screen.getByTestId('canopen-com-add-dialog')
    expect(within(dialog).getByTestId('canopen-com-add-warning').textContent).toContain(
      'Set the device to 500 kbit/s first',
    )
    fireEvent.click(within(dialog).getByTestId('canopen-com-add-confirm'))
    await settle()
    const nodes = store.getState().project.data.remoteDevices?.[0].canopenConfig?.nodes ?? []
    expect(nodes.map((n) => n.nodeId)).toEqual([2, 10])
    expect(nodes[1].tpdos.length + nodes[1].rpdos.length).toBeGreaterThan(0)
    expect(screen.getByTestId('canopen-com-added').textContent).toMatch(/^Added to .+ as node 10: .+\.$/)
  })

  it('says the reads failed, not that the device lacks 0x1010 and 0x1011', async () => {
    await renderWindow({ noProjectFile: true })
    await openAndFind()
    bus.readAbort = 0x05040000
    await pick('node:10')
    await settle()
    await settle()
    expect(screen.getByTestId('canopen-device-memory-missing').textContent).toMatch(
      /^Could not read 0x1010 and 0x1011 from the device: /,
    )
  })

  it('closes the bus with the reason when service mode ended on the runtime during Find', async () => {
    await renderWindow()
    fireEvent.click(screen.getByTestId('canopen-com-open'))
    await settle()
    bus.gone = true
    fireEvent.click(screen.getByTestId('canopen-com-find-button'))
    await settle()
    await settle()
    expect(screen.getByTestId('canopen-com-open')).toBeTruthy()
    expect(screen.getByText(/The runtime closed the bus, for example after a link reset/)).toBeTruthy()
  })

  it('highlights only the device it followed, until another is picked', async () => {
    await renderWindow()
    await openAndFind()
    await pick('node:127')
    bus.devices[1].node_id = 20
    fireEvent.click(screen.getByTestId('canopen-com-find-button'))
    await settle()
    await settle()
    expect(screen.getByTestId('canopen-com-device-node:20').className).toContain('ring-green-500')
    await pick('node:10')
    expect(screen.getByTestId('canopen-com-device-node:20').className).not.toContain('ring-green-500')
  })

  it('locks Add to project during a debug session but keeps the device tools', async () => {
    await renderWindow()
    act(() => store.setState((s) => ({ workspace: { ...s.workspace, isDebuggerVisible: true } })))
    await openAndFind()
    await pick('node:10')
    expect(screen.getByTestId('canopen-com-add')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('canopen-com-set-id')).toHaveProperty('disabled', false)
  })

  it("lists the runtime computer's CAN interfaces and lets the user type one", async () => {
    await renderWindow({ features: [...FEATURES.canopen.features, 'interfaces'] })
    const select = screen.getByTestId('canopen-com-interface')
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['can0 (up, 125 kbit/s)', 'can1 (down)', 'vcan0 (virtual, up)', 'Type a name...'])
    fireEvent.change(select, { target: { value: '__type__' } })
    fireEvent.change(screen.getByTestId('canopen-com-interface-name'), { target: { value: 'can7' } })
    fireEvent.click(screen.getByTestId('canopen-com-open'))
    await settle()
    expect(bus.sent.find((r) => r.op === 'service_open')).toMatchObject({ interface: 'can7' })
  })

  it("keeps the project's interfaces on a runtime that does not list its own", async () => {
    await renderWindow()
    expect(bus.sent.some((r) => r.op === 'interfaces')).toBe(false)
    const options = within(screen.getByTestId('canopen-com-interface')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['can0 (used in the project)', 'Type a name...'])
  })

  it('stays open on a click outside and asks before closing while the bus is open', async () => {
    await renderWindow()
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    expect(screen.queryByTestId('canopen-commissioning')).not.toBeNull()
    fireEvent.click(screen.getByTestId('canopen-com-open'))
    await settle()
    fireEvent.click(screen.getByTestId('canopen-com-window-close'))
    const ask = screen.getByTestId('canopen-com-close-confirm')
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it open' }))
    expect(screen.queryByTestId('canopen-com-close-confirm')).toBeNull()
    expect(store.getState().modals['canopen-commissioning']?.open).toBe(true)
    fireEvent.click(screen.getByTestId('canopen-com-window-close'))
    fireEvent.click(
      within(screen.getByTestId('canopen-com-close-confirm')).getByRole('button', { name: 'Close the window' }),
    )
    await settle()
    expect(store.getState().modals['canopen-commissioning']?.open).toBe(false)
    expect(bus.sent.some((r) => r.op === 'service_close')).toBe(true)
  })

  it('closes at once while the bus is closed', async () => {
    await renderWindow()
    fireEvent.click(screen.getByTestId('canopen-com-window-close'))
    await settle()
    expect(store.getState().modals['canopen-commissioning']?.open).toBe(false)
  })

  it('names a device without a device file by the name it reports and greys out Read all', async () => {
    await renderWindow({ noProjectFile: true, setup: (b) => b.values.set('4104:0', '47656e6572696320494f00') })
    await openAndFind()
    expect(bus.sent.filter((r) => r.op === 'sdo_read').map((r) => r.op === 'sdo_read' && r.node)).toEqual([10, 127])
    expect(screen.getByTestId('canopen-com-device-node:10').textContent).toContain('Node 10: Generic IO')
    await pick('node:10')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Objects' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Objects' }))
    expect(screen.getByRole('button', { name: 'Read all' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/No objects without a device file/)).toBeTruthy()
  })
})
