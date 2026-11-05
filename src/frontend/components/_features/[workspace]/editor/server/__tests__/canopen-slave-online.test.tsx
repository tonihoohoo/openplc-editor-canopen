import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { OpenPLCStore } from '@root/frontend/store'
import { createStoreWrapper, createTestStore } from '@root/frontend/store/testing'
import type { CanopenRequest } from '@root/middleware/shared/ports/canopen-online'
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

async function show(
  body: unknown,
  config = slaveConfig(),
  connected = true,
  request?: (r: CanopenRequest) => Promise<CanopenRuntimeFetch>,
) {
  seed(config)
  if (connected) connect()
  const features = request ? ['status', 'slave_lss'] : ['status']
  const ports = portsWithRuntime({
    getCanopenCapabilities: () => ok({ canopen: { ...CAPABILITIES_WITH_STATUS.canopen, features } }),
    getCanopenStatus: () => ok(body),
    ...(request ? { canopenRequest: request } : {}),
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
      'Setpoint, Mode, Valves (4 of 8 bytes)18 204 received, last 9 ms ago',
    )
    expect(screen.queryByTestId('canopen-slave-online-pdo-rx2')).toBeNull()
    expect(value('0x2000:01')).toBe('1500')
    expect(value('0x2200:01')).toBe('"SN-0001"')
    expect(value('0x2000:04')).toBe('5Valve 1, Valve 3')
    const dots = within(screen.getByTestId('canopen-slave-online-value-0x2000:04')).getByTestId(
      'canopen-slave-online-bits',
    )
    expect(Array.from(dots.children).map((d) => d.getAttribute('title'))).toEqual([
      'bit 0 on',
      'bit 1',
      'bit 2 on',
      'bit 3',
      'bit 4',
      'bit 5',
      'bit 6',
      'bit 7',
    ])
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

  describe('with LSS', () => {
    const lss = {
      state: 'waiting',
      serial_auto: true,
      node_id_from: 'stored',
      project_node_id: 5,
      bitrate_from: 'project',
      bitrate: 500000,
      project_bitrate: 500000,
      stored_node_id: 12,
    }
    // Node 12 from an LSS store: the PDO COB-IDs that follow the node ID moved with it.
    const lssStatus = (fields: Record<string, unknown> = {}) => {
      const pdos = slaveStatus().pdos.map((p) => ({ ...p, cob_id: p.cob_id - 5 + 12 }))
      return slaveStatus(SLAVE_NOW, { node_id: 12, serial: 0x1234abcd, pdos, lss, ...fields })
    }
    const lssConfig = (): CanopenSlaveConfig => ({
      ...slaveConfig(),
      nodeId: 5,
      bitrate: 500000,
      lss: { enabled: true, waitForMaster: false, serial: null, bitrateChange: true },
    })

    it('shows the node ID in use and its source, and forgets the stored values after a confirm', async () => {
      const sent: CanopenRequest[] = []
      await show(inactive([lssStatus()]), lssConfig(), true, (r) => {
        sent.push(r)
        return ok({ ok: true })
      })
      const card = screen.getByTestId('canopen-slave-online-lss')
      expect(screen.getByTestId('canopen-slave-lss-node_id').textContent).toBe('12')
      expect(card.textContent).toContain('Stored by an LSS master (project 5)')
      expect(card.textContent).toContain('0x1234ABCD')
      expect(card.textContent).toContain('Picked by the runtime and kept')
      expect(screen.getByTestId('canopen-slave-lss-stored').textContent).toContain('Stored on the runtime: node ID 12.')
      expect(screen.queryByTestId('canopen-slave-online-notice')).toBeNull()
      fireEvent.click(within(card).getByRole('button', { name: 'Forget stored LSS values...' }))
      expect(sent).toEqual([])
      const ask = within(card).getByRole('alertdialog')
      expect(ask.textContent).toContain("restarts with the project's values (node ID 5, 500 kbit/s)")
      fireEvent.click(within(ask).getByRole('button', { name: 'Forget' }))
      await flush()
      expect(sent).toEqual([{ op: 'slave_lss_forget', slave: NAME }])
      expect(within(card).queryByRole('alert')).toBeNull()
    })

    it('shows a refusal, and offers no Forget with nothing stored or an older runtime', async () => {
      await show(inactive([lssStatus()]), lssConfig(), true, () => ok({ error: 'lss_off' }))
      let card = screen.getByTestId('canopen-slave-online-lss')
      fireEvent.click(within(card).getByRole('button', { name: 'Forget stored LSS values...' }))
      fireEvent.click(within(card).getByRole('button', { name: 'Forget' }))
      await flush()
      expect(within(card).getByRole('alert').textContent).toBe(
        'Cannot forget the stored values: LSS is off in the slave the runtime runs.',
      )
      cleanup()
      store = createTestStore()
      const empty = { ...lss, node_id_from: 'none', stored_node_id: undefined }
      await show(inactive([lssStatus({ node_id: null, lss: empty })]), lssConfig(), true, () => ok({ ok: true }))
      card = screen.getByTestId('canopen-slave-online-lss')
      expect(screen.getByTestId('canopen-slave-lss-node_id').textContent).toBe('None')
      expect(within(card).getByRole('button', { name: 'Forget stored LSS values...' })).toHaveProperty('disabled', true)
      cleanup()
      store = createTestStore()
      await show(inactive([lssStatus()]), lssConfig())
      card = screen.getByTestId('canopen-slave-online-lss')
      expect(within(card).queryByRole('button')).toBeNull()
    })
  })
})
