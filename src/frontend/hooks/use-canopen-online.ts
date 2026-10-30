import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CanopenConfig } from '../../middleware/shared/ports/canopen-types'
import { useRuntime } from '../../middleware/shared/providers'
import { type CanopenOnline, createCanopenOnline } from '../../middleware/shared/utils/canopen'
import { useOpenPLCStore } from '../store'
import type { CanopenLiveStatus } from './use-canopen-status'

export interface CanopenServiceControl {
  /** The runtime offers service mode and the PLC does not run CANopen. */
  available: boolean
  /** This editor opened service mode for the network and it runs. */
  open: boolean
  busy: boolean
  error: string | null
  openBus: () => void
  closeBus: () => void
}

export interface CanopenOnlineContext {
  client: CanopenOnline
  /** The network's index in the runtime's status; requests name it. */
  networkIndex: number
  /** The network runs on the runtime (a PLC program or service mode), so requests reach the nodes. */
  ready: boolean
  /** The runtime takes NMT commands. */
  nmt: boolean
  service: CanopenServiceControl
}

/**
 * The online tools for one CANopen network: null unless the connected runtime lists the `sdo`
 * feature. Service mode this editor opens is closed when the device editor closes.
 */
export function useCanopenOnline(
  deviceName: string,
  config: CanopenConfig,
  live: CanopenLiveStatus | null,
): CanopenOnlineContext | null {
  const runtime = useRuntime()
  const plcRunning = useOpenPLCStore((s) => s.runtimeConnection.plcStatus === 'RUNNING')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const openedRef = useRef(false)

  const client = useMemo(() => {
    const send = runtime.canopenRequest?.bind(runtime)
    return send ? createCanopenOnline(send) : null
  }, [runtime])

  const features = live?.features ?? []
  const hasSdo = features.includes('sdo')
  const hasService = features.includes('service')
  const serviceRuns = live?.network?.mode === 'service'
  const ready = live !== null && live.active && live.network !== null && !live.stale

  useEffect(() => {
    openedRef.current = opened
  }, [opened])

  // Service mode that ended on the runtime (PLC start, idle close) is no longer this editor's.
  useEffect(() => {
    if (opened && live && !serviceRuns && !busy) setOpened(false)
  }, [opened, live, serviceRuns, busy])

  // A network turned off in the project closes the service mode this editor opened.
  const enabled = config.network.enabled
  useEffect(() => {
    if (!enabled && opened && client) {
      setOpened(false)
      void client.closeService()
    }
  }, [enabled, opened, client])

  useEffect(
    () => () => {
      if (openedRef.current && client) void client.closeService()
    },
    [client],
  )

  const configRef = useRef(config)
  configRef.current = config

  const openBus = useCallback(() => {
    if (!client) return
    setBusy(true)
    setError(null)
    const { network, nodes } = configRef.current
    void client
      .openService(
        deviceName,
        network,
        nodes.map((n) => n.nodeId),
      )
      .then((r) => {
        if (r.ok) setOpened(true)
        else setError(r.message)
      })
      .finally(() => setBusy(false))
  }, [client, deviceName])

  const closeBus = useCallback(() => {
    if (!client) return
    setBusy(true)
    setError(null)
    void client
      .closeService()
      .then((r) => {
        if (r.ok) setOpened(false)
        else setError(r.message)
      })
      .finally(() => setBusy(false))
  }, [client])

  if (!client || !live || !hasSdo) return null
  return {
    client,
    networkIndex: live.networkIndex,
    ready,
    nmt: features.includes('nmt'),
    service: {
      available: hasService && !plcRunning && (!live.active || serviceRuns),
      open: serviceRuns,
      busy,
      error,
      openBus,
      closeBus,
    },
  }
}
