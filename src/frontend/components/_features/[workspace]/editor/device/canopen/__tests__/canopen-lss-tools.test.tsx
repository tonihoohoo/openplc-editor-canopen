import { act, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenRequest } from '@root/middleware/shared/ports/canopen-online'
import type { CanopenRuntimeFetch } from '@root/middleware/shared/ports/canopen-status'
import type { CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import {
  canopenDevice,
  configWith,
  genericNode,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { portsWithRuntime, sampleStatus } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'
const FEATURES = ['status', 'sdo', 'nmt', 'service', 'lss']

/** Two devices without a node ID: one has the serial number of project node 3, one only its product. */
const IDENTITY = { vendor_id: genericNode(2).eds.vendorId, product_code: genericNode(2).eds.productCode, revision: 3 }
const FOUND = [
  { ...IDENTITY, serial_number: 0x1234 },
  { ...IDENTITY, serial_number: 0x5678 },
]

let store: OpenPLCStore
let sent: CanopenRequest[]

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
    // Job polls wait 10 ms or more between reads.
    await new Promise((resolve) => setTimeout(resolve, 25))
  })
}

function lssNode(base: CanopenNode, nodeId: number, serialNumber: number): CanopenNode {
  return {
    ...base,
    id: `node-${nodeId}`,
    name: `io${nodeId}`,
    nodeId,
    lss: { enabled: true, serialNumber, revision: 0, store: false },
  }
}

async function renderEditor(options: { features?: string[]; service?: boolean; stopped?: boolean } = {}) {
  store = createTestStore()
  sent = []
  const base = genericNode(2)
  const n2 = { ...base, eds: { ...base.eds, lssSupported: true } }
  const config = configWith(n2, lssNode(n2, 3, 0x1234))
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: { ...state.project, data: { ...state.project.data, remoteDevices: [canopenDevice(NET, config)] } },
  })
  state.deviceActions.setRuntimeJwtToken('token')
  state.deviceActions.setRuntimeConnectionStatus('connected')
  state.deviceActions.setPlcRuntimeStatus(options.service || options.stopped ? 'STOPPED' : 'RUNNING')
  const jobs = new Map<number, unknown[]>()
  let next = 1
  const job = (...states: unknown[]) => {
    jobs.set(next, states)
    return { job: next++ }
  }
  const status = () => {
    if (options.stopped) return { version: 1, active: false }
    const body = sampleStatus()
    if (options.service) Object.assign(body.networks[0], { mode: 'service' })
    return body
  }
  const ports = portsWithRuntime({
    getCanopenCapabilities: () => ok({ canopen: { configVersions: [7], features: options.features ?? FEATURES } }),
    getCanopenStatus: () => ok(status()),
    canopenRequest: (request: CanopenRequest) => {
      sent.push(request)
      if (request.op === 'lss' && request.action === 'find')
        return ok(job({ state: 'pending', devices: FOUND.slice(0, 1) }, { state: 'done', devices: FOUND }))
      if (request.op === 'lss' && request.action === 'set_id')
        return ok(job({ state: 'done', previous_id: 255, stored: request.store }))
      if (request.op === 'lss') return ok(job({ state: 'done', stored: true }))
      if (request.op === 'job') {
        const states = jobs.get(request.job) ?? [{ error: 'unknown_job' }]
        return ok(states.length > 1 ? states.shift() : states[0])
      }
      return ok({ ok: true, network: 0 })
    },
  })
  render(<CanopenEditor />, { wrapper: createStoreWrapper(store, ports) })
  await settle()
}

function openNetworkOnline() {
  const tab = screen.getAllByRole('tab', { name: 'Online' })[0]
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
}

async function find() {
  openNetworkOnline()
  fireEvent.click(screen.getByTestId('canopen-lss-find'))
  for (let i = 0; i < 6; i++) await settle()
}

const nodes = () => store.getState().project.data.remoteDevices?.[0].canopenConfig?.nodes ?? []

describe('CANopen LSS tools', () => {
  it('has the network Online tab only for a runtime with the lss feature', async () => {
    await renderEditor({ features: ['status', 'sdo', 'nmt', 'service'] })
    expect(screen.getAllByRole('tab', { name: 'Online' })).toHaveLength(1)
    expect(screen.queryByTestId('canopen-lss-panel')).toBeNull()
  })

  it('finds the devices without a node ID and shows what they match', async () => {
    await renderEditor()
    await find()
    expect(sent[0]).toEqual({ op: 'lss', network: 0, action: 'find' })
    const rows = screen.getAllByTestId('canopen-lss-device')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('node 3 io3')
    expect(rows[0].textContent).toContain('serial matches')
    expect(within(rows[0]).getByRole('button', { name: 'Give node ID 3' })).toBeTruthy()
    expect(rows[1].textContent).toContain('not in project')
    expect(within(rows[1]).getByRole('button', { name: 'Add to project' })).toBeTruthy()
    expect(screen.getByTestId('canopen-lss-result').textContent).toBe('2 devices without a node ID found.')
  })

  it('gives the node ID of the project node with the serial number', async () => {
    await renderEditor()
    await find()
    fireEvent.click(screen.getByRole('button', { name: 'Give node ID 3' }))
    const dialog = screen.getByTestId('canopen-lss-give-dialog')
    expect(within(dialog).queryByTestId('canopen-lss-add-to-project')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give node ID 3' }))
    for (let i = 0; i < 4; i++) await settle()
    expect(sent).toContainEqual({
      op: 'lss',
      network: 0,
      action: 'set_id',
      node_id: 3,
      store: false,
      ...FOUND[0],
    })
    expect(screen.queryByTestId('canopen-lss-give-dialog')).toBeNull()
    expect(screen.getAllByTestId('canopen-lss-given')[0].textContent).toBe('Node ID 3 given')
  })

  it('gives a free node ID, stores it and adds the device to the project', async () => {
    await renderEditor()
    await find()
    fireEvent.click(screen.getByRole('button', { name: 'Give node ID...' }))
    const dialog = screen.getByTestId('canopen-lss-give-dialog')
    const id = within(dialog).getByTestId<HTMLSelectElement>('canopen-lss-node-id')
    expect(id.value).toBe('1')
    fireEvent.change(id, { target: { value: '4' } })
    fireEvent.click(within(dialog).getByTestId('canopen-lss-store'))
    expect(within(dialog).getByTestId<HTMLInputElement>('canopen-lss-add-to-project').checked).toBe(true)
    expect(within(dialog).queryByTestId('canopen-lss-bitrate')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give node ID 4' }))
    for (let i = 0; i < 4; i++) await settle()
    expect(sent).toContainEqual({ op: 'lss', network: 0, action: 'set_id', node_id: 4, store: true, ...FOUND[1] })
    const added = nodes().find((n) => n.nodeId === 4)
    expect(added?.lss).toEqual({ enabled: true, serialNumber: 0x5678, revision: 3, store: true })
    expect(screen.getAllByTestId('canopen-lss-given')[0].textContent).toBe(
      'Node ID 4 given and stored; added to the project as node 4',
    )
  })

  it('adds a device to the project without giving it a node ID now', async () => {
    await renderEditor()
    await find()
    fireEvent.click(screen.getByRole('button', { name: 'Add to project' }))
    await settle()
    expect(nodes().find((n) => n.nodeId === 1)?.lss?.serialNumber).toBe(0x5678)
    expect(sent.some((r) => r.op === 'lss' && r.action === 'set_id')).toBe(false)
  })

  it('sets the bit rate in service mode only after the change is confirmed', async () => {
    await renderEditor({ service: true })
    await find()
    fireEvent.click(screen.getByRole('button', { name: 'Give node ID...' }))
    const dialog = screen.getByTestId('canopen-lss-give-dialog')
    fireEvent.change(within(dialog).getByTestId('canopen-lss-bitrate'), { target: { value: '125000' } })
    const confirm = within(dialog).getByTestId<HTMLButtonElement>('canopen-lss-give-confirm')
    expect(confirm.textContent).toBe('Give node ID 1 and set 125 kbit/s')
    expect(confirm.disabled).toBe(true)
    fireEvent.click(within(dialog).getByTestId('canopen-lss-bitrate-confirm'))
    fireEvent.click(within(dialog).getByTestId('canopen-lss-add-to-project'))
    fireEvent.click(confirm)
    for (let i = 0; i < 6; i++) await settle()
    const lss = sent.filter((r) => r.op === 'lss')
    expect(lss.map((r) => (r.op === 'lss' ? r.action : ''))).toEqual(['find', 'set_id', 'set_bitrate'])
    expect(lss[2]).toEqual({ op: 'lss', network: 0, action: 'set_bitrate', bitrate: 125000, ...FOUND[1] })
    expect(nodes()).toHaveLength(2)
  })

  it('opens the bus at another bit rate', async () => {
    await renderEditor({ stopped: true })
    fireEvent.change(screen.getByTestId('canopen-service-bitrate'), { target: { value: '125000' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Open bus' })[0])
    await settle()
    expect(sent[0]).toMatchObject({ op: 'service_open', name: NET, bitrate: 125000 })
  })
})
