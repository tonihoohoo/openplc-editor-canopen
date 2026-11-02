import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  canopenFeatures,
  type CanopenNetworkStatus,
  parseCanopenStatus,
} from '../../middleware/shared/ports/canopen-status'
import { useRuntime } from '../../middleware/shared/providers'
import { useOpenPLCStore } from '../store'

export const CANOPEN_STATUS_POLL_MS = 1000

export interface CanopenLiveStatus {
  /** CANopen runs on the runtime; false before the first answer and while it does not. */
  active: boolean
  /** The network of this device, or null when the runtime has none by its name. */
  network: CanopenNetworkStatus | null
  /** The network's index in the runtime's status, which the online tools' requests name. */
  networkIndex: number
  /** The runtime's CANopen features (`status`, `sdo`, `nmt`, `service`). */
  features: readonly string[]
  /** The runtime's clock at the last answer, in milliseconds since the epoch. */
  now: number
  /** The last read failed; `network` is the last good answer. */
  stale: boolean
  /** Reads failed in a row since the last good answer. */
  failures: number
  error: string | null
  /** Reads the status again now instead of at the next poll. */
  refresh: () => void
}

const noRefresh = (): void => undefined

const EMPTY: CanopenLiveStatus = {
  active: false,
  network: null,
  networkIndex: -1,
  features: [],
  now: 0,
  stale: false,
  failures: 0,
  error: null,
  refresh: noRefresh,
}

/**
 * The live status of one CANopen network, read once a second while the editor is connected to a
 * runtime that lists the CANopen `status` feature. Null when not connected or without the feature.
 * With `enabled` false (the network is off in the project) nothing is read and the status stays empty.
 */
export function useCanopenStatus(networkName: string, enabled = true): CanopenLiveStatus | null {
  const runtime = useRuntime()
  const connected = useOpenPLCStore(
    (s) => s.runtimeConnection.connectionStatus === 'connected' && s.runtimeConnection.jwtToken !== null,
  )
  const ipAddress = useOpenPLCStore((s) => s.runtimeConnection.ipAddress)
  const [features, setFeatures] = useState<readonly string[]>([])
  const supported = features.includes('status')
  const [status, setStatus] = useState<CanopenLiveStatus>(EMPTY)
  const nameRef = useRef(networkName)
  nameRef.current = networkName
  const tickRef = useRef<() => void>(noRefresh)
  const refresh = useCallback(() => tickRef.current(), [])

  useEffect(() => {
    setFeatures([])
    setStatus(EMPTY)
    if (!connected || !runtime.getCanopenCapabilities || !runtime.getCanopenStatus) return
    let cancelled = false
    runtime
      .getCanopenCapabilities()
      .then((result) => {
        if (!cancelled && result.success) setFeatures(canopenFeatures(result.body))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connected, ipAddress, runtime])

  useEffect(() => {
    const read = runtime.getCanopenStatus?.bind(runtime)
    setStatus(EMPTY)
    if (!supported || !connected || !enabled || !read) return
    let cancelled = false
    let busy = false
    let again = false
    const fail = (error: string) => setStatus((prev) => ({ ...prev, stale: true, failures: prev.failures + 1, error }))
    const tick = async (now = false) => {
      if (busy) {
        again ||= now
        return
      }
      busy = true
      again = false
      try {
        const result = await read()
        if (cancelled) return
        if (!result.success) return fail(result.error)
        const parsed = parseCanopenStatus(result.body)
        if (!parsed) return fail('The runtime sent a status this editor does not read')
        if (!parsed.active) return setStatus({ ...EMPTY })
        const networkIndex = parsed.networks.findIndex((n) => n.name === nameRef.current)
        setStatus({
          ...EMPTY,
          active: true,
          network: parsed.networks[networkIndex] ?? null,
          networkIndex,
          now: parsed.now,
          stale: false,
          error: null,
        })
      } catch (err) {
        if (!cancelled) fail(err instanceof Error ? err.message : String(err))
      } finally {
        busy = false
        if (again && !cancelled) void tick()
      }
    }
    void tick()
    tickRef.current = () => void tick(true)
    const timer = setInterval(() => void tick(), CANOPEN_STATUS_POLL_MS)
    return () => {
      cancelled = true
      tickRef.current = noRefresh
      clearInterval(timer)
    }
  }, [supported, connected, enabled, runtime])

  return useMemo(
    () => (supported && connected ? { ...status, features, refresh } : null),
    [supported, connected, status, features, refresh],
  )
}
