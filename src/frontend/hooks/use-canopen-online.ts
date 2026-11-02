import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CanopenNmtCommand } from '../../middleware/shared/ports/canopen-online'
import type { CanopenNetworkStatus } from '../../middleware/shared/ports/canopen-status'
import type { CanopenConfig } from '../../middleware/shared/ports/canopen-types'
import { useRuntime } from '../../middleware/shared/providers'
import { type CanopenOnline, createCanopenOnline, nmtCommandTarget } from '../../middleware/shared/utils/canopen'
import { useOpenPLCStore } from '../store'
import type { CanopenLiveStatus } from './use-canopen-status'

const STALE_READS = 3
/** How long a sent NMT command shows as requested when the runtime does not report its state. */
export const NMT_REQUEST_HOLD_MS = 3000

interface NmtRequest {
  command: CanopenNmtCommand
  until: number
}

/** Drops requests whose state the runtime reports, or that waited too long; @p node 0 is every node. */
function pruneRequests(
  requests: ReadonlyMap<number, NmtRequest>,
  network: CanopenNetworkStatus | null,
  now: number,
): ReadonlyMap<number, NmtRequest> {
  const kept = new Map<number, NmtRequest>()
  requests.forEach((request, node) => {
    const target = nmtCommandTarget(request.command)
    const nodes = network?.nodes.filter((n) => node === 0 || n.node_id === node) ?? []
    const reached = target !== null && nodes.length > 0 && nodes.every((n) => n.nmt === target)
    if (!reached && now < request.until) kept.set(node, request)
  })
  return kept.size === requests.size ? requests : kept
}

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
  /** The NMT command sent to @p node that the runtime's status does not show yet. */
  requestedNmt: (node: number) => CanopenNmtCommand | undefined
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

  const [requests, setRequests] = useState<ReadonlyMap<number, NmtRequest>>(new Map())
  const refreshRef = useRef<() => void>(() => undefined)
  refreshRef.current = live?.refresh ?? (() => undefined)

  const client = useMemo(() => {
    const send = runtime.canopenRequest?.bind(runtime)
    if (!send) return null
    const base = createCanopenOnline(send)
    // A sent NMT command shows as requested and the status is read again at once.
    const tracked: CanopenOnline = {
      ...base,
      nmt: (network, node, command) =>
        base.nmt(network, node, command).then((r) => {
          if (r.ok) {
            setRequests((prev) => {
              const next = new Map(prev)
              if (node === 0) next.clear()
              next.set(node, { command, until: Date.now() + NMT_REQUEST_HOLD_MS })
              return next
            })
            refreshRef.current()
          }
          return r
        }),
    }
    return tracked
  }, [runtime])

  const network = live?.network ?? null
  useEffect(() => {
    setRequests((prev) => (prev.size === 0 ? prev : pruneRequests(prev, network, Date.now())))
  }, [network])

  const requestedNmt = useCallback((node: number) => (requests.get(node) ?? requests.get(0))?.command, [requests])

  const features = live?.features ?? []
  const hasSdo = features.includes('sdo')
  const hasService = features.includes('service')
  const serviceRuns = live?.network?.mode === 'service'
  // One missed status read does not grey the tools; a few in a row do.
  const ready = live !== null && live.active && live.network !== null && live.failures < STALE_READS

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
    requestedNmt,
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
