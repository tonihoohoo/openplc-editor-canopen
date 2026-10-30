import { act, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenRuntimeFetch } from '@root/middleware/shared/ports/canopen-status'
import type { CanopenNode } from '@root/middleware/shared/ports/canopen-types'
import {
  canopenDevice,
  configWith,
  genericNode,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import {
  CAPABILITIES_WITH_STATUS,
  portsWithRuntime,
  sampleStatus,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'
let store: OpenPLCStore

function seed(connected: boolean) {
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: {
      ...state.project,
      data: { ...state.project.data, remoteDevices: [canopenDevice(NET, configWith(genericNode(2), genericNode(3)))] },
    },
  })
  if (connected) {
    state.deviceActions.setRuntimeJwtToken('token')
    state.deviceActions.setRuntimeConnectionStatus('connected')
  }
}

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

async function renderEditor(
  connected: boolean,
  capabilities: unknown = CAPABILITIES_WITH_STATUS,
  status: () => Promise<CanopenRuntimeFetch> = () => ok(sampleStatus()),
) {
  store = createTestStore()
  seed(connected)
  const ports = portsWithRuntime({ getCanopenCapabilities: () => ok(capabilities), getCanopenStatus: status })
  render(<CanopenEditor />, { wrapper: createStoreWrapper(store, ports) })
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

function openTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

const dots = () =>
  within(screen.getByRole('list', { name: 'CANopen nodes' }))
    .queryAllByRole('img')
    .map((d) => d.getAttribute('data-dot'))

describe('CANopen live status', () => {
  it('shows dots, the bus status and the reason of a failed boot', async () => {
    await renderEditor(true)
    expect(dots()).toEqual(['amber', 'red'])
    expect(screen.getByTestId('canopen-bus-status').textContent).toBe(
      'Bus OK (error active), errors TX 0 RX 0, load 3.1 %',
    )
    fireEvent.click(screen.getByRole('button', { name: /3: io3/ }))
    openTab('Status')
    const tab = screen.getByTestId('canopen-node-status')
    expect(within(tab).getByTestId('canopen-node-problem').textContent).toBe(
      'The product code is 0x43 where 0x42 was expected (boot status M).',
    )
    expect(tab.textContent).toContain('Pre-operational')
    expect(tab.textContent).toContain('Boot failed. The product code')
  })

  it('decodes the emergencies and late PDOs of a node', async () => {
    await renderEditor(true)
    openTab('Status')
    const tab = screen.getByTestId('canopen-node-status')
    expect(tab.textContent).toContain('Life guard or heartbeat error')
    expect(tab.textContent).toContain('generic, communication')
    expect(tab.textContent).toContain('01 02 03 04 05')
    expect(tab.textContent).toContain('TPDO 1 (COB-ID 0x182) late since')
  })

  it('says when a node sends no emergency messages or has them turned off', async () => {
    await renderEditor(true)
    const setNode3 = (change: (n: CanopenNode) => CanopenNode) =>
      act(() => {
        const state = store.getState()
        const devices = state.project.data.remoteDevices ?? []
        store.setState({
          project: {
            ...state.project,
            data: {
              ...state.project.data,
              remoteDevices: devices.map((d) =>
                d.canopenConfig
                  ? {
                      ...d,
                      canopenConfig: {
                        ...d.canopenConfig,
                        nodes: d.canopenConfig.nodes.map((n) => (n.nodeId === 3 ? change(n) : n)),
                      },
                    }
                  : d,
              ),
            },
          },
        })
      })
    fireEvent.click(screen.getByRole('button', { name: /3: io3/ }))
    openTab('Status')
    const tab = () => screen.getByTestId('canopen-node-status').textContent
    expect(tab()).toContain('No emergencies since the PLC started.')
    setNode3((n) => ({ ...n, emcy: { ...n.emcy, enabled: false } }))
    expect(tab()).toContain('Emergency messages are off for this node.')
    setNode3((n) => ({
      ...n,
      emcy: { ...n.emcy, enabled: true },
      eds: { ...n.eds, objects: n.eds.objects.filter((o) => o.index !== 0x1014) },
    }))
    expect(tab()).toContain('This device sends no emergency messages (its EDS has no 0x1014).')
  })

  it('shows link resets and a bus-off link the runtime may not reset', async () => {
    const status = sampleStatus()
    const net = status.networks[0]
    net.bus = { ...net.bus, state: 'bus_off', link_resets: 2 }
    net.events = [{ time: status.now - 1000, kind: 'bus_reset', outcome: 'not_permitted' }, ...net.events]
    await renderEditor(true, CAPABILITIES_WITH_STATUS, () => ok(status))
    const line = screen.getByTestId('canopen-bus-status').textContent ?? ''
    expect(line).toContain('Bus off,')
    expect(line).toContain('link reset 2 times')
    expect(line).toContain('the runtime may not reset the link, reset it by hand')
  })

  it('shows dropped sent frames and the runtime may not reset a link at a wrong bit rate', async () => {
    const status = sampleStatus()
    const net = status.networks[0]
    const bus = { ...net.bus, link_resets: 1, tx_dropped: 182 }
    const events = [{ time: status.now - 1000, kind: 'bus_reset', outcome: 'not_permitted', cause: 'bit_rate' }]
    await renderEditor(true, CAPABILITIES_WITH_STATUS, () =>
      ok({ ...status, networks: [{ ...net, bus, events: [...events, ...net.events] }] }),
    )
    const line = screen.getByTestId('canopen-bus-status').textContent ?? ''
    expect(line).toContain('182 sent frames dropped')
    expect(line).toContain('the runtime may not reset the link, reset it by hand')
  })

  it('greys the last status when a read fails', async () => {
    await renderEditor(true, CAPABILITIES_WITH_STATUS, () => Promise.resolve({ success: false, error: 'timed out' }))
    expect(screen.getByTestId('canopen-bus-status').textContent).toContain('Status unavailable: timed out')
  })

  it('shows nothing while not connected', async () => {
    await renderEditor(false)
    expect(dots()).toEqual([])
    expect(screen.queryByRole('tab', { name: 'Status' })).toBeNull()
    expect(screen.queryByTestId('canopen-bus-status')).toBeNull()
  })

  it('reads no status for a network that is off and says it is off', async () => {
    const status = jest.fn(() => ok(sampleStatus()))
    await renderEditor(true, CAPABILITIES_WITH_STATUS, status)
    expect(status).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Run this network' }))
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    status.mockClear()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
    })
    expect(status).not.toHaveBeenCalled()
    expect(screen.getByTestId('canopen-bus-status').textContent).toBe('Off in the project')
    expect(dots()).toEqual([])
    expect(screen.queryByRole('tab', { name: 'Status' })).toBeNull()
  })

  it('shows nothing for a runtime without the feature', async () => {
    await renderEditor(true, { canopen: { configVersions: [2] } })
    expect(dots()).toEqual([])
    expect(screen.queryByRole('tab', { name: 'Status' })).toBeNull()
  })

  it('offers a receive timeout on enabled inputs, with its warning', async () => {
    await renderEditor(false)
    openTab(/Inputs/)
    const field = within(screen.getByTestId('canopen-pdo-input-1')).getByLabelText('Receive timeout (ms)')
    fireEvent.change(field, { target: { value: '5' } })
    fireEvent.blur(field)
    const node = store.getState().project.data.remoteDevices?.[0].canopenConfig?.nodes[0]
    expect(node?.tpdos[0].receiveTimeoutMs).toBe(5)
  })
})
