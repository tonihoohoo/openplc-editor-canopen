import { useEffect, useRef, useState } from 'react'

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
  /** The runtime's clock at the last answer, in milliseconds since the epoch. */
  now: number
  /** The last read failed; `network` is the last good answer. */
  stale: boolean
  error: string | null
}

const EMPTY: CanopenLiveStatus = { active: false, network: null, now: 0, stale: false, error: null }

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
  const [supported, setSupported] = useState(false)
  const [status, setStatus] = useState<CanopenLiveStatus>(EMPTY)
  const nameRef = useRef(networkName)
  nameRef.current = networkName

  useEffect(() => {
    setSupported(false)
    setStatus(EMPTY)
    if (!connected || !runtime.getCanopenCapabilities || !runtime.getCanopenStatus) return
    let cancelled = false
    runtime
      .getCanopenCapabilities()
      .then((result) => {
        if (!cancelled && result.success) setSupported(canopenFeatures(result.body).includes('status'))
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
    const fail = (error: string) => setStatus((prev) => ({ ...prev, stale: true, error }))
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const result = await read()
        if (cancelled) return
        if (!result.success) return fail(result.error)
        const parsed = parseCanopenStatus(result.body)
        if (!parsed) return fail('The runtime sent a status this editor does not read')
        if (!parsed.active) return setStatus({ ...EMPTY })
        setStatus({
          active: true,
          network: parsed.networks.find((n) => n.name === nameRef.current) ?? null,
          now: parsed.now,
          stale: false,
          error: null,
        })
      } catch (err) {
        if (!cancelled) fail(err instanceof Error ? err.message : String(err))
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), CANOPEN_STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [supported, connected, enabled, runtime])

  return supported && connected ? status : null
}
