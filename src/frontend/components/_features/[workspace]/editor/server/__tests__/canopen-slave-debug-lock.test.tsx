import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import { defaultCanopenSlaveConfig } from '@root/middleware/shared/utils/canopen'
import { portsWithRuntime } from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenSlaveEditor } from '../canopen-slave'

const NAME = 'slave'

let store: OpenPLCStore

const config = (): CanopenSlaveConfig | undefined =>
  store.getState().project.data.servers?.find((s) => s.name === NAME)?.canopenSlaveConfig

function seed(slave: CanopenSlaveConfig) {
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-server', meta: { name: NAME, protocol: 'canopen-slave' } },
    project: {
      ...state.project,
      data: {
        ...state.project.data,
        servers: [{ name: NAME, protocol: 'canopen-slave', canopenSlaveConfig: slave }],
      },
    },
  })
}

const tabNamed = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) })

function openTab(name: string) {
  fireEvent.mouseDown(tabNamed(name))
  fireEvent.click(tabNamed(name))
}

const setDebugging = (on: boolean) => act(() => store.getState().workspaceActions.setDebuggerVisible(on))

const isDisabled = (element: HTMLElement) => element.matches(':disabled')

describe('CanopenSlaveEditor during a debug session', () => {
  beforeEach(() => {
    localStorage.clear()
    store = createTestStore()
    seed({ ...defaultCanopenSlaveConfig('demo'), interface: 'can1' })
    render(<CanopenSlaveEditor />, { wrapper: createStoreWrapper(store, portsWithRuntime()) })
  })

  afterEach(cleanup)

  it('disables the settings, refuses changes and gives the controls back afterwards', () => {
    setDebugging(true)
    const before = config()
    expect(screen.getByTestId('canopen-debug-lock').textContent).toContain('CANopen slave')
    expect(isDisabled(screen.getByLabelText('Node ID'))).toBe(true)
    expect(isDisabled(screen.getByRole('switch', { name: 'Run this slave' }))).toBe(true)
    expect(isDisabled(screen.getByRole('button', { name: 'Import...' }))).toBe(true)

    const nodeId = screen.getByLabelText('Node ID')
    fireEvent.change(nodeId, { target: { value: '9' } })
    fireEvent.blur(nodeId)
    expect(config()).toBe(before)

    openTab('Data')
    const addButton = within(screen.getByTestId('canopen-slave-from-master')).getByRole('button', {
      name: /Add object/,
    })
    expect(isDisabled(addButton)).toBe(true)

    setDebugging(false)
    expect(screen.queryByTestId('canopen-debug-lock')).toBeNull()
    expect(isDisabled(addButton)).toBe(false)
  })

  it('keeps the expert view, the export and the Status tab usable', () => {
    setDebugging(true)
    expect(isDisabled(screen.getByRole('switch', { name: 'Expert view' }))).toBe(false)
    expect(isDisabled(screen.getByRole('button', { name: 'Export...' }))).toBe(false)
    openTab('Status')
    expect(tabNamed('Status').getAttribute('aria-selected')).toBe('true')
  })

  it('saves an export made during the session without recording it', async () => {
    cleanup()
    store = createTestStore()
    seed({ ...defaultCanopenSlaveConfig('demo'), interface: 'can1' })
    const saved: string[] = []
    render(<CanopenSlaveEditor />, {
      wrapper: createStoreWrapper(
        store,
        portsWithRuntime(
          {},
          {
            exportFile: (name) => {
              saved.push(name)
              return Promise.resolve({ success: true })
            },
          },
        ),
      ),
    })
    setDebugging(true)
    const before = config()
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = screen.getByTestId('canopen-export-dialog')
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('canopen-export-save'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(saved).toEqual(['demo.eds'])
    expect(config()).toBe(before)
    expect(config()?.lastExport).toBeUndefined()
  })
})
