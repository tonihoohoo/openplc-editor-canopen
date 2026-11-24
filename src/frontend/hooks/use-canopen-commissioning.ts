import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CanopenNmtCommand } from '../../middleware/shared/ports/canopen-online'
import { useRuntime } from '../../middleware/shared/providers'
import {
  type CanopenOnline,
  COMMISSION_SERVICE_NAME,
  createCanopenOnline,
  type LssDevice,
  type ScanDevice,
} from '../../middleware/shared/utils/canopen'
import { useOpenPLCStore } from '../store'
import type { CanopenOnlineContext } from './use-canopen-online'
import { useCanopenStatusFeed } from './use-canopen-status'

/** The window's bus: closed, opening, waiting for the take-over answer, or open in service mode. */
export type CommissionBus =
  | { state: 'closed' }
  | { state: 'opening' }
  | { state: 'take_over'; network: string }
  | { state: 'open'; index: number; iface: string; bitrate: number }

/** The last Find: running, or ended with its devices and what went wrong. */
export type CommissionFind =
  | { state: 'idle' }
  | { state: 'running'; step: 'scan' | 'lss'; scan: ScanDevice[]; lss: LssDevice[] }
  | { state: 'done'; scan: ScanDevice[]; lss: LssDevice[]; error: string | null; lssNote: string | null }

/** Why the window offers no tools, or null when it does. */
export type CommissionBlock = 'not_connected' | 'no_commission' | 'plc_running' | null

export interface CanopenCommissioning {
  block: CommissionBlock
  plcRunning: boolean
  bus: CommissionBus
  error: string | null
  /** Opens the bus; with @p takeOver a network kept at PLC stop on the interface leaves it. */
  open: (iface: string, bitrate: number, takeOver?: boolean) => void
  cancelTakeOver: () => void
  close: () => void
  find: CommissionFind
  runFind: () => Promise<void>
  /** The online tools for the open bus, as the object list uses them; null while closed. */
  online: CanopenOnlineContext | null
  client: CanopenOnline | null
}

const noNmt = (): CanopenNmtCommand | undefined => undefined

/**
 * The device commissioning window's connection: service mode for commissioning on the runtime the
 * editor is connected to, the Find (bus scan, then LSS search), and the online tools on that bus.
 * The bus closes when the window closes and when the PLC starts.
 */
export function useCanopenCommissioning(): CanopenCommissioning {
  const runtime = useRuntime()
  const feed = useCanopenStatusFeed(true)
  const refresh = feed.refresh
  const plcStatus = useOpenPLCStore((s) => s.runtimeConnection.plcStatus)
  const plcRunning = plcStatus === 'RUNNING' || plcStatus === 'TRANSITIONING'
  const [bus, setBus] = useState<CommissionBus>({ state: 'closed' })
  const [error, setError] = useState<string | null>(null)
  const [find, setFind] = useState<CommissionFind>({ state: 'idle' })
  const busRef = useRef(bus)
  busRef.current = bus
  const pending = useRef<{ iface: string; bitrate: number } | null>(null)

  const client = useMemo(() => {
    const send = runtime.canopenRequest?.bind(runtime)
    return send ? createCanopenOnline(send) : null
  }, [runtime])

  const block: CommissionBlock = !feed.connected
    ? 'not_connected'
    : !feed.features.includes('commission') || !client
      ? 'no_commission'
      : plcRunning
        ? 'plc_running'
        : null

  const open = useCallback(
    (iface: string, bitrate: number, takeOver = false) => {
      if (!client) return
      setError(null)
      setFind({ state: 'idle' })
      setBus({ state: 'opening' })
      pending.current = { iface, bitrate }
      void (async () => {
        if (busRef.current.state === 'open') await client.closeService()
        const r = await client.openCommission(COMMISSION_SERVICE_NAME, iface, bitrate, takeOver)
        if (r.ok) {
          setBus({ state: 'open', index: r.network ?? 0, iface, bitrate })
          refresh()
          return
        }
        if (!takeOver && r.abortCode === undefined && r.reason === 'network_on_interface' && r.name) {
          setBus({ state: 'take_over', network: r.name })
          return
        }
        setBus({ state: 'closed' })
        setError(r.message)
      })()
    },
    [client, refresh],
  )

  const cancelTakeOver = useCallback(() => {
    setBus({ state: 'closed' })
    pending.current = null
  }, [])

  const close = useCallback(() => {
    if (!client) return
    const was = busRef.current.state
    setBus({ state: 'closed' })
    setFind({ state: 'idle' })
    if (was === 'open') void client.closeService().then(() => refresh())
  }, [client, refresh])

  // A PLC start ends service mode on the runtime.
  useEffect(() => {
    if (plcRunning && busRef.current.state !== 'closed') {
      setBus({ state: 'closed' })
      setFind({ state: 'idle' })
    }
  }, [plcRunning])

  // Service mode that ended on the runtime (idle close, another client) is closed here too.
  const listed = feed.status?.active
    ? feed.status.networks.some((n) => n.mode === 'service' && n.name === COMMISSION_SERVICE_NAME)
    : false
  const seen = useRef(false)
  useEffect(() => {
    if (bus.state !== 'open') {
      seen.current = false
      return
    }
    if (listed) seen.current = true
    else if (seen.current) {
      seen.current = false
      setBus({ state: 'closed' })
      setFind({ state: 'idle' })
      setError('The runtime closed the bus.')
    }
  }, [bus.state, listed])

  useEffect(
    () => () => {
      if (busRef.current.state === 'open' && client) void client.closeService()
    },
    [client],
  )

  const runFind = useCallback(async () => {
    const b = busRef.current
    if (!client || b.state !== 'open') return
    setFind({ state: 'running', step: 'scan', scan: [], lss: [] })
    const scan = await client.scan(b.index, (devices) =>
      setFind((f) => (f.state === 'running' ? { ...f, scan: devices } : f)),
    )
    if (busRef.current.state !== 'open') return
    if (!scan.ok) {
      setFind({ state: 'done', scan: scan.devices, lss: [], error: scan.message, lssNote: null })
      return
    }
    setFind({ state: 'running', step: 'lss', scan: scan.devices, lss: [] })
    const lss = await client.lssFind(b.index, (devices) =>
      setFind((f) => (f.state === 'running' ? { ...f, lss: devices } : f)),
    )
    if (busRef.current.state !== 'open') return
    const incomplete = !lss.ok && (lss.reason === 'incomplete' || lss.reason === 'too_many')
    setFind({
      state: 'done',
      scan: scan.devices,
      lss: lss.devices,
      error: lss.ok || incomplete ? null : `The LSS search failed: ${lss.message}`,
      lssNote: incomplete ? lss.message : null,
    })
  }, [client])

  const online = useMemo((): CanopenOnlineContext | null => {
    if (!client || bus.state !== 'open') return null
    return {
      client,
      networkIndex: bus.index,
      ready: true,
      plcStopped: false,
      nmt: feed.features.includes('nmt'),
      requestedNmt: noNmt,
      service: { available: false, open: true, busy: false, error: null },
    }
  }, [client, bus, feed.features])

  return { block, plcRunning, bus, error, open, cancelTakeOver, close, find, runFind, online, client }
}
