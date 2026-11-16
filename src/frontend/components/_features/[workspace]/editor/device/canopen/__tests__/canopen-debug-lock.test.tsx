import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import { defaultCanopenConfig } from '@root/middleware/shared/utils/canopen'
import { GENERIC_IO_EDS } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenEditor } from '..'

const NET = 'CANopen_1'

let store: OpenPLCStore

const config = () => store.getState().project.data.remoteDevices?.find((d) => d.name === NET)?.canopenConfig

function seed() {
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-remote-device', meta: { name: NET, protocol: 'canopen' } },
    project: {
      ...state.project,
      data: {
        ...state.project.data,
        remoteDevices: [{ name: NET, protocol: 'canopen', canopenConfig: defaultCanopenConfig() }],
      },
    },
  })
}

async function addNode() {
  const file = new File([GENERIC_IO_EDS], 'generic-io-module.eds')
  const bytes = new TextEncoder().encode(GENERIC_IO_EDS)
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(bytes.buffer) })
  await act(async () => {
    fireEvent.change(screen.getByTestId('canopen-eds-input'), { target: { files: [file] } })
    await Promise.resolve()
  })
  const confirm = await screen.findByTestId('canopen-file-dialog-confirm')
  await act(async () => {
    fireEvent.click(confirm)
    await Promise.resolve()
  })
}

function openTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
  fireEvent.click(screen.getByRole('tab', { name }))
}

const setDebugging = (on: boolean) => act(() => store.getState().workspaceActions.setDebuggerVisible(on))

const isDisabled = (element: HTMLElement) => element.matches(':disabled')

describe('CanopenEditor during a debug session', () => {
  beforeEach(async () => {
    localStorage.clear()
    store = createTestStore()
    seed()
    render(<CanopenEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
    await addNode()
    await screen.findByText('Node 1: Generic_I_O_module')
  })

  afterEach(cleanup)

  it('says why the page is read-only and gives the controls back when the session closes', () => {
    expect(screen.queryByTestId('canopen-debug-lock')).toBeNull()
    setDebugging(true)
    expect(screen.getByTestId('canopen-debug-lock').textContent).toContain('debug session is open')
    expect(isDisabled(screen.getByLabelText('Node ID'))).toBe(true)
    setDebugging(false)
    expect(screen.queryByTestId('canopen-debug-lock')).toBeNull()
    expect(isDisabled(screen.getByLabelText('Node ID'))).toBe(false)
  })

  it('disables the node settings and leaves the project unchanged', () => {
    setDebugging(true)
    const before = config()
    expect(isDisabled(screen.getByRole('button', { name: 'Add node from device file...' }))).toBe(true)
    expect(isDisabled(screen.getByRole('button', { name: 'Remove node' }))).toBe(true)
    expect(isDisabled(screen.getByRole('button', { name: 'Replace device file...' }))).toBe(true)
    expect(isDisabled(screen.getByRole('switch', { name: 'Run this network' }))).toBe(true)

    // A change event still reaches a disabled input; the write path refuses it.
    const nodeId = screen.getByLabelText('Node ID')
    fireEvent.change(nodeId, { target: { value: '7' } })
    fireEvent.blur(nodeId)
    expect(config()).toBe(before)
    expect(store.getState().project.data.remoteDevices?.[0].canopenConfig?.nodes[0].nodeId).toBe(1)
  })

  it('keeps tabs, the expert view and the exports usable', () => {
    setDebugging(true)
    expect(isDisabled(screen.getByRole('switch', { name: 'Expert view' }))).toBe(false)
    expect(isDisabled(screen.getByRole('button', { name: 'Export...' }))).toBe(false)
    openTab(/^Outputs/)
    expect(screen.getByRole('tab', { name: /^Outputs/ }).getAttribute('aria-selected')).toBe('true')
    openTab('Network')
    expect(isDisabled(screen.getByRole('button', { name: 'Export network...' }))).toBe(false)
    expect(isDisabled(screen.getByLabelText('Interface'))).toBe(true)
  })

  it('keeps the boot writes readable while the startup SDOs are locked', () => {
    setDebugging(true)
    openTab(/^Startup SDOs/)
    expect(isDisabled(screen.getByRole('button', { name: /Written at boot/ }))).toBe(false)
    expect(isDisabled(screen.getByRole('button', { name: 'Add by index' }))).toBe(true)
  })
})
