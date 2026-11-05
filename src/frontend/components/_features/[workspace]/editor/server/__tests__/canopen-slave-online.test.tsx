import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenRuntimeFetch } from '@root/middleware/shared/ports/canopen-status'
import type { CanopenSlaveConfig } from '@root/middleware/shared/ports/canopen-types'
import {
  SLAVE_NOW,
  slaveConfig,
  slaveStatus,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/slave-status'
import {
  CAPABILITIES_WITH_STATUS,
  portsWithRuntime,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'

import { CanopenSlaveEditor } from '../canopen-slave'

const NAME = 'slave'

let store: OpenPLCStore

function seed(slave: CanopenSlaveConfig) {
  const state = store.getState()
  store.setState({
    editor: { type: 'plc-server', meta: { name: NAME, protocol: 'canopen-slave' } },
    project: {
      ...state.project,
      data: { ...state.project.data, servers: [{ name: NAME, protocol: 'canopen-slave', canopenSlaveConfig: slave }] },
    },
  })
}

function connect() {
  const { deviceActions } = store.getState()
  deviceActions.setRuntimeJwtToken('token')
  deviceActions.setRuntimeConnectionStatus('connected')
}

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function show(body: unknown, config = slaveConfig(), connected = true) {
  seed(config)
  if (connected) connect()
  const ports = portsWithRuntime({
    getCanopenCapabilities: () => ok(CAPABILITIES_WITH_STATUS),
    getCanopenStatus: () => ok(body),
  })
  render(<CanopenSlaveEditor />, { wrapper: createStoreWrapper(store, ports) })
  await flush()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Online' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Online' }))
}

const inactive = (slaves: unknown[]) => ({ version: 1, active: false, now: SLAVE_NOW, slaves })

const value = (ref: string) =>
  within(screen.getByTestId(`canopen-slave-online-value-${ref}`)).getByTestId('canopen-slave-online-value').textContent

describe('the slave Online tab', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    store = createTestStore()
  })
  afterEach(() => {
    cleanup()
    jest.useRealTimers()
  })

  it('shows the running slave: state, bus line, PDOs, values and events', async () => {
    await show(inactive([slaveStatus()]))
    expect(screen.getByTestId('canopen-slave-bus-status').textContent).toBe(
      'Bus OK (error active), errors TX 0 RX 0, load 3.1 %',
    )
    expect(screen.queryByTestId('canopen-slave-online-notice')).toBeNull()
    const state = screen.getByTestId('canopen-slave-online-state')
    expect(state.textContent).toContain('Operational')
    expect(state.textContent).toContain('Started by the master (node 127)')
    expect(state.textContent).toContain('Seen 100 ms ago')
    expect(screen.getByTestId('canopen-slave-online-pdo-rx1').textContent).toContain(
      'Setpoint, Mode (3 of 8 bytes)18 204 received, last 9 ms ago',
    )
    expect(screen.queryByTestId('canopen-slave-online-pdo-rx2')).toBeNull()
    expect(value('0x2000:01')).toBe('1500')
    expect(value('0x2200:01')).toBe('"SN-0001"')
    fireEvent.change(screen.getByLabelText('Number display'), { target: { value: 'hex' } })
    expect(value('0x2000:01')).toBe('0x05DC')
    fireEvent.change(screen.getByLabelText('Number display'), { target: { value: 'decimal' } })
    expect(value('0x2000:01')).toBe('1500')
    expect(screen.getByTestId('canopen-slave-online-events').textContent).toContain(
      'The master wrote 0x2000:03 (Limit).',
    )
  })

  it('marks the settings the master changed with the project values', async () => {
    const values = slaveStatus().values.map((v) =>
      v.subindex === 3 && v.index === 0x2000 ? { ...v, data: '3200' } : v,
    )
    await show(inactive([slaveStatus(SLAVE_NOW, { heartbeat_ms: 200, values })]))
    expect(screen.getByTestId('canopen-slave-online-notice').textContent).toContain(
      'The master changed 2 settings of this slave.',
    )
    expect(screen.getByTestId('canopen-slave-online-state').textContent).toContain('every 200 msproject 100 ms')
    expect(value('0x2000:03')).toBe('50written by the master')
  })

  it('shows the master loss and keeps the live data', async () => {
    await show(
      inactive([
        slaveStatus(SLAVE_NOW, {
          state: 'pre_operational',
          nmt_by: 'self',
          master_seen: false,
          master_last_seen: SLAVE_NOW - 41000,
          emcy_active: [0x8130],
          error_register: 0x11,
        }),
      ]),
    )
    const notice = screen.getByTestId('canopen-slave-online-notice')
    expect(notice.getAttribute('data-notice')).toBe('master_lost')
    expect(notice.textContent).toContain('so the slave went pre-operational')
    const state = screen.getByTestId('canopen-slave-online-state').textContent
    expect(state).toContain('By itself')
    expect(state).toContain('Lost 41 s ago')
    expect(state).toContain('1 active')
  })

  it('says why there is nothing live to show', async () => {
    await show(inactive([]))
    expect(screen.getByTestId('canopen-slave-online-notice').textContent).toContain(
      'The runtime does not run this slave.',
    )
    expect(screen.queryByTestId('canopen-slave-online-state')).toBeNull()
    expect(screen.queryByTestId('canopen-slave-bus-status')).toBeNull()
  })

  it('says not connected without a runtime and off for a slave that is off', async () => {
    await show(inactive([slaveStatus()]), slaveConfig(), false)
    expect(screen.getByTestId('canopen-slave-online-notice').getAttribute('data-notice')).toBe('not_connected')
    cleanup()
    store = createTestStore()
    await show(inactive([slaveStatus()]), { ...slaveConfig(), enabled: false })
    expect(screen.getByTestId('canopen-slave-online-notice').getAttribute('data-notice')).toBe('off')
  })
})
