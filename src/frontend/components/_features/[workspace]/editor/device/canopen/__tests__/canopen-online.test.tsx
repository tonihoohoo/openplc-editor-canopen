import { act, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenConfig } from '@root/middleware/shared/ports/canopen-types'
import type { CanopenRequest } from '@root/middleware/shared/ports/canopen-online'
import type { CanopenRuntimeFetch } from '@root/middleware/shared/ports/canopen-status'
import {
  canopenDevice,
  configWith,
  genericNode,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { portsWithRuntime, sampleStatus } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'
const ALL_FEATURES = { canopen: { configVersions: [3], features: ['status', 'sdo', 'nmt', 'service'] } }

/** A simulated node 2 behind the request route: its objects, NMT state and the requests it got. */
class FakeNode {
  values = new Map<string, string>([
    ['4119:0', 'f401'], // 0x1017 = 500
    ['8448:0', '00000000'], // 0x2100
    ['4096:0', '91010000'], // 0x1000 = 401, as the EDS
  ])
  operational = true
  sent: CanopenRequest[] = []
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
      switch (request.op) {
        case 'sdo_read': {
          const v = this.values.get(`${request.index}:${request.subindex}`)
          return job(v === undefined ? { state: 'failed', abort_code: 0x06020000 } : { state: 'done', data: v })
        }
        case 'sdo_write':
          if (request.index === 0x2100 && this.operational) return job({ state: 'failed', abort_code: 0x08000022 })
          this.values.set(`${request.index}:${request.subindex}`, request.data)
          return job({ state: 'done' })
        case 'job':
          return this.jobs.get(request.job) ?? { error: 'unknown_job' }
        case 'nmt':
          this.operational = request.command === 'start'
          return { ok: true }
        case 'service_open':
          return { ok: true, network: 0 }
        case 'service_close':
          return { ok: true }
      }
    })()
    return Promise.resolve({ success: true, body })
  }
}

const offIf = (config: CanopenConfig, off: boolean): CanopenConfig =>
  off ? { ...config, network: { ...config.network, enabled: false } } : config

let store: OpenPLCStore
let node: FakeNode

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

async function renderEditor(
  options: { capabilities?: unknown; status?: unknown; expert?: boolean; off?: boolean } = {},
) {
  localStorage.setItem('openplc:canopen-expert-view', options.expert ? 'on' : 'off')
  store = createTestStore()
  node = new FakeNode()
  const state = store.getState()
  const n2 = { ...genericNode(2), heartbeatProducerMs: 1000, supervision: 'heartbeat' as const }
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: {
      ...state.project,
      data: {
        ...state.project.data,
        remoteDevices: [canopenDevice(NET, offIf(configWith(n2), options.off ?? false))],
      },
    },
  })
  state.deviceActions.setRuntimeJwtToken('token')
  state.deviceActions.setRuntimeConnectionStatus('connected')
  state.deviceActions.setPlcRuntimeStatus(options.status ? 'STOPPED' : 'RUNNING')
  const ports = portsWithRuntime({
    getCanopenCapabilities: () => ok(options.capabilities ?? ALL_FEATURES),
    getCanopenStatus: () => ok(options.status ?? sampleStatus()),
    canopenRequest: node.handle,
  })
  render(<CanopenEditor />, { wrapper: createStoreWrapper(store, ports) })
  await settle()
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

const row = (index: number) => screen.getByTestId(`canopen-online-row-${index}:0`)

describe('CANopen online tools', () => {
  it('has no Online tab for a runtime that lists only the status', async () => {
    await renderEditor({ capabilities: { canopen: { configVersions: [3], features: ['status'] } } })
    expect(screen.getByRole('tab', { name: 'Status' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Online' })).toBeNull()
  })

  it('reads all objects and finds the one that differs from the project, read only in the basic view', async () => {
    await renderEditor()
    openTab('Online')
    expect(screen.queryByRole('button', { name: 'Write' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset node' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Read all' }))
    await settle()
    await settle()
    fireEvent.change(screen.getByLabelText('Filter objects'), { target: { value: 'differs' } })
    const tab = screen.getByTestId('canopen-online-tab')
    const rows = within(tab).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('0x1017')
    expect(rows[0].textContent).toContain('1000')
    expect(screen.getByTestId('canopen-online-value-4119:0').textContent).toBe('500')
    expect(node.sent.every((r) => r.op === 'sdo_read' || r.op === 'job')).toBe(true)
  })

  it('switches a node to pre-operational to retry a refused write, then keeps it as a startup SDO', async () => {
    await renderEditor({ expert: true })
    openTab('Online')
    const r = row(0x2100)
    fireEvent.change(within(r).getByLabelText('New value for 0x2100:00'), { target: { value: '25' } })
    fireEvent.click(within(r).getByRole('button', { name: 'Write' }))
    await settle()
    expect(r.textContent).toContain('Write refused')
    fireEvent.click(within(r).getByRole('button', { name: 'Switch to pre-operational and retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch and retry' }))
    await settle()
    await settle()
    expect(node.sent.some((s) => s.op === 'nmt' && s.command === 'pre_operational' && s.node === 2)).toBe(true)
    expect(screen.getByTestId('canopen-online-value-8448:0').textContent).toBe('25')
    fireEvent.click(within(r).getByRole('button', { name: 'Add as startup SDO' }))
    const sdos = store.getState().project.data.remoteDevices?.[0].canopenConfig?.nodes[0].sdos ?? []
    expect(sdos[sdos.length - 1]).toMatchObject({ index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '25' })
  })

  it('says a write to an object the master writes lasts until the next boot', async () => {
    await renderEditor({ expert: true })
    openTab('Online')
    const r = row(0x1017)
    fireEvent.change(within(r).getByLabelText('New value for 0x1017:00'), { target: { value: '200' } })
    fireEvent.click(within(r).getByRole('button', { name: 'Write' }))
    await settle()
    await settle()
    expect(r.textContent).toContain('lasts until the node boots again')
    expect(within(r).queryByRole('button', { name: 'Add as startup SDO' })).toBeNull()
  })

  it('asks before a reset and before an NMT command to every node', async () => {
    await renderEditor({ expert: true })
    openTab('Online')
    fireEvent.click(screen.getByRole('button', { name: 'Reset node' }))
    expect(node.sent.some((s) => s.op === 'nmt')).toBe(false)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset node' }))
    await settle()
    expect(node.sent).toContainEqual({ op: 'nmt', network: 0, node: 2, command: 'reset_node' })

    openTab('Network')
    const card = screen.getByTestId('canopen-network-nmt')
    fireEvent.click(within(card).getByRole('button', { name: 'Stop' }))
    fireEvent.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Stop' }))
    await settle()
    expect(node.sent).toContainEqual({ op: 'nmt', network: 0, node: 0, command: 'stop' })
  })

  it('refuses raw writes to 0x1010 and points to Save to node', async () => {
    await renderEditor({ expert: true })
    openTab('Online')
    const raw = screen.getByTestId('canopen-online-raw')
    fireEvent.change(within(raw).getByLabelText('Index (hex)'), { target: { value: '1010' } })
    fireEvent.change(within(raw).getByLabelText('Sub-index'), { target: { value: '1' } })
    fireEvent.change(within(raw).getByLabelText('Value to write'), { target: { value: '73617665' } })
    fireEvent.click(within(raw).getByRole('button', { name: 'Write' }))
    expect(raw.textContent).toContain('Use Save to node')
    expect(node.sent.some((s) => s.op === 'sdo_write')).toBe(false)
  })

  it('opens the bus in service mode while the PLC is stopped', async () => {
    await renderEditor({ status: { version: 1, active: false } })
    const open = screen.getAllByRole('button', { name: 'Open bus' })[0]
    fireEvent.click(open)
    await settle()
    expect(node.sent[0]).toMatchObject({ op: 'service_open', name: NET, nodes: [2] })
  })

  it('has no online tools for a network that is off in the project', async () => {
    await renderEditor({ off: true, status: { version: 1, active: false } })
    expect(screen.queryByRole('tab', { name: 'Online' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open bus' })).toBeNull()
  })
})
