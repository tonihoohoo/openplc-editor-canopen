import { act, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenConfig, CanopenObject } from '@root/middleware/shared/ports/canopen-types'
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
    ['4112:1', '01000000'], // 0x1010:01 saves on command
    ['4112:2', '00000000'], // 0x1010:02 does not save on command
    ['4112:3', '02000000'], // 0x1010:03 saves by itself
  ])
  operational = true
  /** Abort code for writes to 0x1010 and 0x1011 while operational, or null to take them. */
  nvmAbort: number | null = null
  /** Refuse 0x1010 and 0x1011 in every state. */
  nvmAlwaysRefused = false
  nmtError: string | null = null
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
          if (
            (request.index === 0x1010 || request.index === 0x1011) &&
            this.nvmAbort !== null &&
            (this.operational || this.nvmAlwaysRefused)
          )
            return job({ state: 'failed', abort_code: this.nvmAbort })
          this.values.set(`${request.index}:${request.subindex}`, request.data)
          return job({ state: 'done' })
        case 'job':
          return this.jobs.get(request.job) ?? { error: 'unknown_job' }
        case 'nmt':
          if (this.nmtError) return { error: this.nmtError }
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

const nvmObject = (index: number, subIndex: number, name: string): CanopenObject => ({
  index,
  subIndex,
  name,
  dataType: 'UNSIGNED32',
  access: 'rw',
  pdoMapping: false,
})

const NVM_OBJECTS: CanopenObject[] = [
  nvmObject(0x1010, 1, 'Save all parameters'),
  nvmObject(0x1010, 2, 'Save communication parameters'),
  nvmObject(0x1010, 3, 'Save application parameters'),
  nvmObject(0x1011, 1, 'Restore all default parameters'),
  nvmObject(0x1011, 2, 'Restore communication default parameters'),
]

const offIf = (config: CanopenConfig, off: boolean): CanopenConfig =>
  off ? { ...config, network: { ...config.network, enabled: false } } : config

let store: OpenPLCStore
let node: FakeNode
let statusReads = 0
/** Node 2's NMT state in the runtime's status; null keeps the sample's. */
let reportedNmt: string | null = null

function currentStatus() {
  const body = sampleStatus()
  if (reportedNmt) body.networks[0].nodes[0].nmt = reportedNmt
  return body
}

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

async function settle() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

async function renderEditor(
  options: {
    capabilities?: unknown
    /** The runtime's status, or a function that gives it at each read. */
    status?: object | (() => object)
    expert?: boolean
    off?: boolean
    setup?: (node: FakeNode) => void
  } = {},
) {
  localStorage.setItem('openplc:canopen-expert-view', options.expert ? 'on' : 'off')
  store = createTestStore()
  node = new FakeNode()
  statusReads = 0
  reportedNmt = null
  options.setup?.(node)
  const state = store.getState()
  const base = genericNode(2)
  const n2 = {
    ...base,
    eds: { ...base.eds, objects: [...base.eds.objects, ...NVM_OBJECTS] },
    heartbeatProducerMs: 1000,
    supervision: 'heartbeat' as const,
  }
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
    getCanopenStatus: () => {
      statusReads++
      const status = typeof options.status === 'function' ? options.status() : options.status
      return ok(status ?? currentStatus())
    },
    canopenRequest: node.handle,
  })
  render(<CanopenEditor />, { wrapper: createStoreWrapper(store, ports) })
  await settle()
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

/** The node's Online tab; the network's Online tab comes first in the page. */
function openNodeOnline() {
  const tabs = screen.getAllByRole('tab', { name: 'Online' })
  const tab = tabs[tabs.length - 1]
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
}

const row = (index: number) => screen.getByTestId(`canopen-online-row-${index}:0`)
const note = (index: number) => screen.getByTestId(`canopen-online-note-${index}:0`)

describe('CANopen online tools', () => {
  it('has no Online tab for a runtime that lists only the status', async () => {
    await renderEditor({ capabilities: { canopen: { configVersions: [3], features: ['status'] } } })
    expect(screen.getByRole('tab', { name: 'Status' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Online' })).toBeNull()
  })

  it('reads all objects and finds the one that differs from the project, read only in the basic view', async () => {
    await renderEditor()
    openNodeOnline()
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

  it('keeps reading all objects while another tab is open, until stopped', async () => {
    await renderEditor()
    openNodeOnline()
    fireEvent.click(screen.getByRole('button', { name: 'Read all' }))
    openTab('Status')
    await settle()
    openNodeOnline()
    await settle()
    await settle()
    expect(screen.getByTestId('canopen-online-value-4119:0').textContent).toBe('500')
    expect(screen.getByTestId('canopen-online-value-8448:0').textContent).toBe('0')
  })

  it('shows what a PDO mapping entry maps', async () => {
    await renderEditor({
      setup: (n) => {
        n.values.set('6656:1', '08010060')
        n.values.set('6656:2', '00000000')
      },
    })
    openNodeOnline()
    fireEvent.click(screen.getByRole('button', { name: 'Read all' }))
    await settle()
    await settle()
    await settle()
    const tab = screen.getByTestId('canopen-online-tab')
    expect(within(tab).getByTestId('canopen-online-row-6656:1').textContent).toContain(
      '0x6000:01 Digital inputs / Inputs 1-8, 8\u00a0bits',
    )
    expect(within(tab).getByTestId('canopen-online-value-6656:1').textContent).toBe('0x60000108')
    expect(within(tab).getByTestId('canopen-online-row-6656:2').textContent).toContain('not used')
    expect(within(tab).getByTestId('canopen-online-project-meaning-6656:2').textContent).toMatch(/^0x[0-9A-F]{4}:\d\d/)
  })

  it('shows a sent NMT command as requested and reads the status again at once', async () => {
    await renderEditor({ expert: true })
    openNodeOnline()
    const card = screen.getByTestId('canopen-online-nmt')
    const before = statusReads
    reportedNmt = 'operational'
    const preOperational = () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Enter pre-operational' }))
      fireEvent.click(
        within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Enter pre-operational' }),
      )
    }
    preOperational()
    await settle()
    expect(statusReads).toBeGreaterThan(before)
    expect(within(card).getByTestId('canopen-online-nmt-requested').textContent).toBe('Pre-operational, requested')

    reportedNmt = 'pre_operational'
    preOperational()
    await settle()
    await settle()
    expect(within(card).queryByTestId('canopen-online-nmt-requested')).toBeNull()
    expect(card.textContent).toContain('NMT state: Pre-operational')
  })

  it('switches a node to pre-operational to retry a refused write, and leaves the project as it was', async () => {
    await renderEditor({ expert: true })
    openNodeOnline()
    const before = store.getState().project.data.remoteDevices?.[0].canopenConfig?.nodes[0].sdos.length
    const r = row(0x2100)
    fireEvent.change(within(r).getByLabelText('New value for 0x2100:00'), { target: { value: '25' } })
    fireEvent.click(within(r).getByRole('button', { name: 'Write' }))
    await settle()
    expect(note(0x2100).textContent).toContain('Write refused')
    fireEvent.click(within(note(0x2100)).getByRole('button', { name: 'Enter pre-operational and retry' }))
    fireEvent.click(within(note(0x2100)).getByRole('button', { name: 'Retry' }))
    await settle()
    await settle()
    expect(node.sent.some((s) => s.op === 'nmt' && s.command === 'pre_operational' && s.node === 2)).toBe(true)
    expect(screen.getByTestId('canopen-online-value-8448:0').textContent).toBe('25')
    expect(screen.queryByRole('button', { name: 'Add as startup SDO' })).toBeNull()
    expect(store.getState().project.data.remoteDevices?.[0].canopenConfig?.nodes[0].sdos.length).toBe(before)
  })

  it('says a write to an object the master writes lasts until the next boot', async () => {
    await renderEditor({ expert: true })
    openNodeOnline()
    const r = row(0x1017)
    fireEvent.change(within(r).getByLabelText('New value for 0x1017:00'), { target: { value: '200' } })
    fireEvent.click(within(r).getByRole('button', { name: 'Write' }))
    await settle()
    await settle()
    expect(note(0x1017).textContent).toContain('lasts until the node boots again')
  })

  it('asks before a reset, in the card, and before an NMT command to every node', async () => {
    await renderEditor({ expert: true })
    openNodeOnline()
    const card = screen.getByTestId('canopen-online-nmt')
    fireEvent.click(within(card).getByRole('button', { name: 'Reset node' }))
    expect(node.sent.some((s) => s.op === 'nmt')).toBe(false)
    fireEvent.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Reset node' }))
    await settle()
    expect(node.sent).toContainEqual({ op: 'nmt', network: 0, node: 2, command: 'reset_node' })
    expect(card.textContent).toContain('Reset node sent.')

    fireEvent.click(within(card).getByRole('checkbox', { name: 'Send to all nodes of the network' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Stop remote node' }))
    expect(within(card).getByRole('alertdialog').textContent).toContain('Stop every node?')
    fireEvent.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Stop remote node' }))
    await settle()
    expect(node.sent).toContainEqual({ op: 'nmt', network: 0, node: 0, command: 'stop' })
    expect(card.textContent).toContain('Stop remote node sent to every node.')
  })

  it('has one Online tab, on the node, and none on the network', async () => {
    await renderEditor()
    expect(screen.getAllByRole('tab', { name: 'Online' })).toHaveLength(1)
  })

  it('reads any object from the toolbar and refuses raw writes to 0x1010', async () => {
    await renderEditor({ expert: true })
    openNodeOnline()
    fireEvent.click(screen.getByRole('button', { name: 'Any object…' }))
    const raw = screen.getByTestId('canopen-online-raw')
    fireEvent.change(within(raw).getByLabelText('Index (hex)'), { target: { value: '1010' } })
    fireEvent.change(within(raw).getByLabelText('Sub-index'), { target: { value: '1' } })
    fireEvent.change(within(raw).getByLabelText('Value to write'), { target: { value: '73617665' } })
    fireEvent.click(within(raw).getByRole('button', { name: 'Write' }))
    expect(raw.textContent).toContain('File > CANopen device commissioning')
    expect(node.sent.some((s) => s.op === 'sdo_write')).toBe(false)
  })

  it('reads any object in the basic view too, without a write', async () => {
    await renderEditor()
    openNodeOnline()
    fireEvent.click(screen.getByRole('button', { name: 'Any object…' }))
    const raw = screen.getByTestId('canopen-online-raw')
    expect(within(raw).queryByRole('button', { name: 'Write' })).toBeNull()
    fireEvent.change(within(raw).getByLabelText('Index (hex)'), { target: { value: '1017' } })
    fireEvent.click(within(raw).getByRole('button', { name: 'Read' }))
    await settle()
    expect(raw.textContent).toContain('0x1017:00')
  })

  it('reads an object the EDS lists as its EDS type in Any object', async () => {
    await renderEditor()
    openNodeOnline()
    fireEvent.click(screen.getByRole('button', { name: 'Any object…' }))
    const raw = screen.getByTestId('canopen-online-raw')
    fireEvent.change(within(raw).getByLabelText('Index (hex)'), { target: { value: '1017' } })
    expect(within(raw).getByLabelText<HTMLSelectElement>('Data type').value).toBe('UNSIGNED16')
    fireEvent.change(within(raw).getByLabelText('Index (hex)'), { target: { value: '5FFF' } })
    expect(within(raw).getByLabelText<HTMLSelectElement>('Data type').value).toBe('raw bytes')
  })

  const readRaw = async (index: string) => {
    openNodeOnline()
    fireEvent.click(screen.getByRole('button', { name: 'Any object…' }))
    const raw = screen.getByTestId('canopen-online-raw')
    fireEvent.change(within(raw).getByLabelText('Index (hex)'), { target: { value: index } })
    fireEvent.click(within(raw).getByRole('button', { name: 'Read' }))
    await settle()
  }

  it('opens service mode by itself at the first request while the PLC is stopped and no network runs', async () => {
    await renderEditor({ status: { version: 1, active: false } })
    expect(screen.queryByRole('button', { name: 'Open bus' })).toBeNull()
    expect(screen.getByTestId('canopen-bus-mode').textContent).toContain('The bus opens with the project')
    await readRaw('1017')
    expect(node.sent[0]).toMatchObject({ op: 'service_open', name: NET, nodes: [2] })
    expect(node.sent[1]).toMatchObject({ op: 'sdo_read', network: 0, node: 2, index: 0x1017 })
    expect(node.sent.filter((r) => r.op === 'service_open')).toHaveLength(1)
  })

  it('keeps reading all objects when the first read opens service mode', async () => {
    const serviceStatus = () => {
      if (!node.sent.some((r) => r.op === 'service_open')) return { version: 1, active: false }
      const body = sampleStatus()
      Object.assign(body.networks[0], { mode: 'service' })
      return body
    }
    await renderEditor({ status: serviceStatus })
    openNodeOnline()
    fireEvent.click(screen.getByRole('button', { name: 'Read all' }))
    for (let i = 0; i < 4; i++) await settle()
    expect(node.sent.filter((r) => r.op === 'service_open')).toHaveLength(1)
    expect(screen.getByTestId('canopen-online-value-4119:0').textContent).toBe('500')
  })

  it('uses the network kept on the bus while the PLC is stopped, without service mode', async () => {
    const kept = sampleStatus()
    Object.assign(kept.networks[0], { plc_running: false })
    await renderEditor({ status: kept })
    expect(screen.getByTestId('canopen-bus-mode').textContent).toContain('PLC stopped, outputs zero')
    await readRaw('1017')
    expect(node.sent.some((r) => r.op === 'service_open')).toBe(false)
    expect(node.sent[0]).toMatchObject({ op: 'sdo_read', node: 2, index: 0x1017 })
  })

  it('shows no bus line while the PLC runs', async () => {
    await renderEditor()
    expect(screen.queryByTestId('canopen-bus-mode')).toBeNull()
  })

  it('has no online tools for a network that is off in the project', async () => {
    await renderEditor({ off: true, status: { version: 1, active: false } })
    expect(screen.queryByRole('tab', { name: 'Online' })).toBeNull()
    expect(screen.queryByTestId('canopen-bus-mode')).toBeNull()
  })

  it('has no save or restore card: those are in the device commissioning window', async () => {
    await renderEditor({ expert: true })
    openNodeOnline()
    await settle()
    expect(screen.queryByTestId('canopen-online-nvm')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save to node' })).toBeNull()
  })
})
