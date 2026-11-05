import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  canopenFeatures,
  type CanopenNetworkStatus,
  type CanopenSlaveStatus,
  type CanopenStatus,
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

interface StatusFeed {
  supported: boolean
  connected: boolean
  features: readonly string[]
  /** The last good answer, or null before it. */
  status: CanopenStatus | null
  stale: boolean
  failures: number
  error: string | null
  refresh: () => void
}

interface FeedState {
  status: CanopenStatus | null
  stale: boolean
  failures: number
  error: string | null
}

const NO_FEED: FeedState = { status: null, stale: false, failures: 0, error: null }

/** The runtime's CANopen status, read once a second while connected to a runtime with the `status` feature. */
function useStatusFeed(enabled: boolean): StatusFeed {
  const runtime = useRuntime()
  const connected = useOpenPLCStore(
    (s) => s.runtimeConnection.connectionStatus === 'connected' && s.runtimeConnection.jwtToken !== null,
  )
  const ipAddress = useOpenPLCStore((s) => s.runtimeConnection.ipAddress)
  const [features, setFeatures] = useState<readonly string[]>([])
  const supported = features.includes('status')
  const [feed, setFeed] = useState<FeedState>(NO_FEED)
  const tickRef = useRef<() => void>(noRefresh)
  const refresh = useCallback(() => tickRef.current(), [])

  useEffect(() => {
    setFeatures([])
    setFeed(NO_FEED)
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
    setFeed(NO_FEED)
    if (!supported || !connected || !enabled || !read) return
    let cancelled = false
    let busy = false
    let again = false
    const fail = (error: string) => setFeed((prev) => ({ ...prev, stale: true, failures: prev.failures + 1, error }))
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
        setFeed({ status: parsed, stale: false, failures: 0, error: null })
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

  return { supported, connected, features, refresh, ...feed }
}

/**
 * The live status of one CANopen network, read once a second while the editor is connected to a
 * runtime that lists the CANopen `status` feature. Null when not connected or without the feature.
 * With `enabled` false (the network is off in the project) nothing is read and the status stays empty.
 */
export function useCanopenStatus(networkName: string, enabled = true): CanopenLiveStatus | null {
  const feed = useStatusFeed(enabled)
  const { supported, connected, features, refresh, status, stale, failures, error } = feed
  return useMemo(() => {
    if (!supported || !connected) return null
    const base = { ...EMPTY, features, refresh, stale, failures, error }
    if (!status?.active) return base
    const networkIndex = status.networks.findIndex((n) => n.name === networkName)
    return {
      ...base,
      active: true,
      network: status.networks[networkIndex] ?? null,
      networkIndex,
      now: status.now,
    }
  }, [supported, connected, features, refresh, status, stale, failures, error, networkName])
}

export interface CanopenSlaveLiveStatus {
  /** The runtime answered at least once. */
  answered: boolean
  /** The slave by this name in the runtime's status, or null when the runtime does not run it. */
  slave: CanopenSlaveStatus | null
  /** The runtime's CANopen features, such as `slave_lss`. */
  features: readonly string[]
  /** The runtime's clock at the last answer, or 0 when an older runtime does not send it. */
  now: number
  stale: boolean
  failures: number
  error: string | null
  refresh: () => void
}

/**
 * The live status of one CANopen slave, read like {@link useCanopenStatus}: null when not connected or
 * without the `status` feature. With `enabled` false nothing is read.
 */
export function useCanopenSlaveStatus(slaveName: string, enabled = true): CanopenSlaveLiveStatus | null {
  const { supported, connected, features, refresh, status, stale, failures, error } = useStatusFeed(enabled)
  return useMemo(() => {
    if (!supported || !connected) return null
    return {
      answered: status !== null,
      slave: status?.slaves.find((s) => s.name === slaveName) ?? null,
      features,
      now: status?.now ?? 0,
      stale,
      failures,
      error,
      refresh,
    }
  }, [supported, connected, features, refresh, status, stale, failures, error, slaveName])
}
