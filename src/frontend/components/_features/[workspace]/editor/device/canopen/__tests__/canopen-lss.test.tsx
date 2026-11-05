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
  NOW,
  portsWithRuntime,
  sampleStatus,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'
let store: OpenPLCStore

/** Node 3 of the generic module with LSS support in its device file; LSS on when `serial` is given. */
function lssNode(serial: number | null, enabled = true): CanopenNode {
  const node = genericNode(3)
  return {
    ...node,
    eds: { ...node.eds, lssSupported: true },
    lss: { enabled, serialNumber: serial, revision: 0, store: false },
  }
}

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

const config = () => store.getState().project.data.remoteDevices?.find((d) => d.name === NET)?.canopenConfig

async function renderEditor(nodes: CanopenNode[], status?: unknown) {
  store = createTestStore()
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: {
      ...state.project,
      data: { ...state.project.data, remoteDevices: [canopenDevice(NET, configWith(...nodes))] },
    },
  })
  if (status) {
    state.deviceActions.setRuntimeJwtToken('token')
    state.deviceActions.setRuntimeConnectionStatus('connected')
  }
  const ports = portsWithRuntime({
    getCanopenCapabilities: () => ok(CAPABILITIES_WITH_STATUS),
    getCanopenStatus: () => ok(status ?? sampleStatus()),
  })
  render(<CanopenEditor />, { wrapper: createStoreWrapper(store, ports) })
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

const select = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }))

function openTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

function commit(label: string, value: string) {
  const input = screen.getByRole('textbox', { name: label })
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

describe('CANopen node ID over LSS', () => {
  it('disables LSS for a device file without LSS support', async () => {
    await renderEditor([genericNode(2)])
    const section = screen.getByTestId('canopen-lss-section')
    expect(section.textContent).toContain('How the device gets node ID 2')
    const radio = within(section).getByRole('radio', { name: 'Given by the master over LSS at every start' })
    expect((radio as HTMLInputElement).disabled).toBe(true)
    expect(section.textContent).toContain('The device file does not list LSS support')
    expect((within(section).getByRole('radio', { name: 'Set on the device' }) as HTMLInputElement).checked).toBe(true)
  })

  it('turns LSS on, takes a serial number in hexadecimal and marks the node in the list', async () => {
    await renderEditor([genericNode(2), lssNode(null, false)])
    select(/3: io3/)
    const list = screen.getByRole('list', { name: 'CANopen nodes' })
    expect(within(list).queryByText('LSS')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Given by the master over LSS at every start' }))
    expect(config()?.nodes[1].lss?.enabled).toBe(true)
    expect(within(list).getByText('LSS')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Vendor ID' }) as HTMLInputElement).value).toBe('0x00000001')
    expect((screen.getByRole('textbox', { name: 'Product code' }) as HTMLInputElement).value).toBe('0x00000002')
    // An empty serial number stops the build, with its node named.
    expect(screen.getByRole('status', { name: 'Network checks' }).textContent).toContain(
      'node 3 (io3): gets its node ID over LSS but has no serial number',
    )
    commit('Serial number', '0x00001234')
    expect(config()?.nodes[1].lss?.serialNumber).toBe(0x1234)
    commit('Revision', '5')
    expect(config()?.nodes[1].lss?.revision).toBe(5)
    commit('Revision', '')
    expect(config()?.nodes[1].lss?.revision).toBe(0)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also store the node ID in the device' }))
    expect(config()?.nodes[1].lss?.store).toBe(true)
    expect(screen.queryByRole('status', { name: 'Network checks' })).toBeNull()

    // Back to set on the device: the serial number stays in the project.
    fireEvent.click(screen.getByRole('radio', { name: 'Set on the device' }))
    expect(config()?.nodes[1].lss).toEqual({ enabled: false, serialNumber: 0x1234, revision: 0, store: true })
    expect(within(list).queryByText('LSS')).toBeNull()
  })

  it('refuses a serial number of 0', async () => {
    await renderEditor([lssNode(0x1234)])
    commit('Serial number', '0')
    expect(screen.getByText('The serial number cannot be 0.')).toBeTruthy()
    expect(config()?.nodes[0].lss?.serialNumber).toBe(0x1234)
  })

  it('shows a device not found under the node name and in the Status tab', async () => {
    const status = sampleStatus()
    const net = status.networks[0] as unknown as { nodes: Array<Record<string, unknown>>; events: unknown[] }
    net.nodes[1].lss = { result: 'not_found', previous_id: 0, stored: false, time: NOW - 1000 }
    net.events = [
      {
        time: NOW - 1000,
        node: 3,
        kind: 'lss',
        lss: { result: 'not_found', previous_id: 0, stored: false, time: NOW - 1000 },
      },
      {
        time: NOW - 9000,
        node: 3,
        kind: 'lss',
        lss: { result: 'given', previous_id: 255, stored: false, time: NOW - 9000 },
      },
    ]
    await renderEditor([genericNode(2), lssNode(0x1234)], status)
    const list = screen.getByRole('list', { name: 'CANopen nodes' })
    expect(within(list).getByText('LSS: no device answered')).toBeTruthy()
    select(/3: io3/)
    openTab('Status')
    const panel = screen.getByTestId('canopen-status-lss')
    expect(panel.textContent).toContain(
      'No device with vendor 0x00000001, product 0x00000002, serial 0x00001234 answered. Check the serial number and the cabling.',
    )
    expect(panel.textContent).toContain('Node ID 3 given (device had none); not stored.')
  })
})
