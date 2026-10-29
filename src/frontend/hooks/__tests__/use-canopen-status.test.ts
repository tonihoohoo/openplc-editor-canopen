import type { CanopenRuntimeFetch } from '@root/middleware/shared/ports/canopen-status'
import {
  CAPABILITIES_WITH_STATUS,
  portsWithRuntime,
  sampleStatus,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/status'
import { act, renderHook } from '@testing-library/react'

import type { OpenPLCStore } from '../../store'
import { createStoreWrapper, createTestStore } from '../../store/testing'
import { CANOPEN_STATUS_POLL_MS, useCanopenStatus } from '../use-canopen-status'

let store: OpenPLCStore

function connect(connected = true) {
  const { deviceActions } = store.getState()
  deviceActions.setRuntimeJwtToken(connected ? 'token' : null)
  deviceActions.setRuntimeConnectionStatus(connected ? 'connected' : 'disconnected')
}

const ok = (body: unknown): Promise<CanopenRuntimeFetch> => Promise.resolve({ success: true, body })

function render(
  getCanopenStatus: jest.Mock<Promise<CanopenRuntimeFetch>>,
  capabilities: unknown = CAPABILITIES_WITH_STATUS,
) {
  const ports = portsWithRuntime({ getCanopenCapabilities: () => ok(capabilities), getCanopenStatus })
  return renderHook(() => useCanopenStatus('CANopen_1'), { wrapper: createStoreWrapper(store, ports) })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
  })
  await flush()
}

describe('useCanopenStatus', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    store = createTestStore()
  })
  afterEach(() => jest.useRealTimers())

  it('reads nothing while not connected', async () => {
    const read = jest.fn(() => ok(sampleStatus()))
    const { result } = render(read)
    await flush()
    expect(result.current).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('reads nothing from a runtime without the feature', async () => {
    connect()
    const read = jest.fn(() => ok(sampleStatus()))
    const { result } = render(read, { canopen: { configVersions: [2] } })
    await flush()
    await advance(3000)
    expect(result.current).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('polls once a second and picks the network by name', async () => {
    connect()
    const read = jest.fn(() => ok(sampleStatus()))
    const { result } = render(read)
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.current?.network?.nodes.map((n) => n.node_id)).toEqual([2, 3])
    await advance(CANOPEN_STATUS_POLL_MS)
    await advance(CANOPEN_STATUS_POLL_MS)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('keeps the last status, marked stale, when a read fails', async () => {
    connect()
    const read = jest.fn(() => ok(sampleStatus()))
    const { result } = render(read)
    await flush()
    read.mockImplementation(() => Promise.resolve({ success: false, error: 'timed out' }))
    await advance(CANOPEN_STATUS_POLL_MS)
    expect(result.current?.stale).toBe(true)
    expect(result.current?.error).toBe('timed out')
    expect(result.current?.network?.name).toBe('CANopen_1')
    read.mockImplementation(() => ok({ version: 9 }))
    await advance(CANOPEN_STATUS_POLL_MS)
    expect(result.current?.error).toContain('does not read')
    read.mockImplementation(() => ok({ active: false }))
    await advance(CANOPEN_STATUS_POLL_MS)
    expect(result.current).toMatchObject({ active: false, network: null, stale: false })
  })

  it('stops when the connection ends or the editor closes', async () => {
    connect()
    const read = jest.fn(() => ok(sampleStatus('Other')))
    const { result, unmount } = render(read)
    await flush()
    expect(result.current?.network).toBeNull()
    act(() => connect(false))
    await advance(CANOPEN_STATUS_POLL_MS * 3)
    expect(result.current).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    unmount()
  })
})
