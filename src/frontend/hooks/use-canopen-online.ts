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
  /**
   * The runtime offers service mode, the PLC is stopped and no network by this name runs, so the
   * first request opens the bus with the project's settings.
   */
  available: boolean
  /** Service mode runs this network. */
  open: boolean
  busy: boolean
  error: string | null
  /** The bit rate (bit/s) this editor opened the bus at; null when it did not open it. */
  bitrate: number | null
  /** The bit rate the next opening uses (expert choice); 0 for the network's. */
  chosenBitrate: number
  /** Chooses the bit rate to open the bus at; a bus open at another rate closes first. */
  chooseBitrate: (bitrate: number) => void
}

export interface CanopenOnlineContext {
  client: CanopenOnline
  /** The network's index in the runtime's status; requests name it. */
  networkIndex: number
  /**
   * Requests reach the nodes: the network runs on the runtime (a PLC program, with the PLC running
   * or stopped, or service mode), or the first request opens service mode.
   */
  ready: boolean
  /** The network runs, kept on the bus while the PLC is stopped. */
  plcStopped: boolean
  /** The runtime takes NMT commands. */
  nmt: boolean
  /** The runtime offers the LSS tools. */
  lss: boolean
  /** The NMT command sent to @p node that the runtime's status does not show yet. */
  requestedNmt: (node: number) => CanopenNmtCommand | undefined
  service: CanopenServiceControl
}

/**
 * The online tools for one CANopen network: null unless the connected runtime lists the `sdo`
 * feature. While the PLC is stopped and no network by this name runs, the first request opens
 * service mode with the project's settings; it is closed when the device editor closes.
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
  const [openedBitrate, setOpenedBitrate] = useState<number | null>(null)
  const [chosenBitrate, setChosenBitrate] = useState(0)
  const openedRef = useRef(false)
  /** The service mode network's index from the opening, until the status lists it. */
  const openIndexRef = useRef<number | null>(null)
  const openingRef = useRef<Promise<number | string> | null>(null)

  const [requests, setRequests] = useState<ReadonlyMap<number, NmtRequest>>(new Map())
  const refreshRef = useRef<() => void>(() => undefined)
  refreshRef.current = live?.refresh ?? (() => undefined)

  const features = live?.features ?? []
  const hasSdo = features.includes('sdo')
  const hasService = features.includes('service')
  const serviceRuns = live?.network?.mode === 'service'
  const listed = live !== null && live.active && live.network !== null && live.failures < STALE_READS
  const available = live !== null && hasService && !plcRunning && (live.network === null || serviceRuns)

  const configRef = useRef(config)
  configRef.current = config
  const stateRef = useRef({ listed, available, networkIndex: live?.networkIndex ?? -1, chosenBitrate })
  stateRef.current = { listed, available, networkIndex: live?.networkIndex ?? -1, chosenBitrate }

  const base = useMemo(() => {
    const send = runtime.canopenRequest?.bind(runtime)
    return send ? createCanopenOnline(send) : null
  }, [runtime])

  /** The network index to send to: the listed network, else service mode opened now. */
  const target = useCallback(async (): Promise<number | string> => {
    const state = stateRef.current
    if (state.listed) return state.networkIndex
    if (openIndexRef.current !== null) return openIndexRef.current
    if (!base || !state.available) return state.networkIndex
    if (openingRef.current) return openingRef.current
    const { network, nodes } = configRef.current
    const rate = state.chosenBitrate || network.bitrate
    setBusy(true)
    setError(null)
    const opening = base
      .openService(
        deviceName,
        { ...network, bitrate: rate },
        nodes.map((n) => n.nodeId),
      )
      .then((r): number | string => {
        if (!r.ok) {
          setError(r.message)
          return r.message
        }
        const index = r.network ?? 0
        openIndexRef.current = index
        openedRef.current = true
        setOpened(true)
        setOpenedBitrate(rate)
        refreshRef.current()
        return index
      })
      .finally(() => {
        openingRef.current = null
        setBusy(false)
      })
    openingRef.current = opening
    return opening
  }, [base, deviceName])

  const client = useMemo(() => {
    if (!base) return null
    const refused = (message: string) => ({ ok: false as const, reason: 'service', message })
    const tracked: CanopenOnline = {
      ...base,
      read: async (_network, node, index, subIndex) => {
        const net = await target()
        return typeof net === 'string' ? refused(net) : base.read(net, node, index, subIndex)
      },
      write: async (_network, node, index, subIndex, bytes) => {
        const net = await target()
        return typeof net === 'string' ? refused(net) : base.write(net, node, index, subIndex, bytes)
      },
      // A sent NMT command shows as requested and the status is read again at once.
      nmt: async (_network, node, command) => {
        const net = await target()
        if (typeof net === 'string') return refused(net)
        const r = await base.nmt(net, node, command)
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
      },
      lssFind: async (_network, onProgress) => {
        const net = await target()
        return typeof net === 'string' ? { ...refused(net), devices: [] } : base.lssFind(net, onProgress)
      },
      lssSetId: async (_network, device, nodeId, store) => {
        const net = await target()
        return typeof net === 'string' ? refused(net) : base.lssSetId(net, device, nodeId, store)
      },
      lssSetBitrate: async (_network, device, bitrate) => {
        const net = await target()
        return typeof net === 'string' ? refused(net) : base.lssSetBitrate(net, device, bitrate)
      },
    }
    return tracked
  }, [base, target])

  const network = live?.network ?? null
  useEffect(() => {
    setRequests((prev) => (prev.size === 0 ? prev : pruneRequests(prev, network, Date.now())))
  }, [network])

  const requestedNmt = useCallback((node: number) => (requests.get(node) ?? requests.get(0))?.command, [requests])

  // The bit rate this editor opened the bus at, until the service mode it saw running ends.
  const serviceSeen = useRef(false)
  useEffect(() => {
    if (serviceRuns) serviceSeen.current = true
    else if (serviceSeen.current) {
      serviceSeen.current = false
      setOpenedBitrate(null)
    }
  }, [serviceRuns])

  // Service mode that ended on the runtime (PLC start, idle close) is no longer this editor's.
  useEffect(() => {
    if (opened && live && !serviceRuns && !busy && openIndexRef.current === null) {
      setOpened(false)
      openedRef.current = false
    }
  }, [opened, live, serviceRuns, busy])
  // Once the status shows service mode, its index comes from there.
  useEffect(() => {
    if (serviceRuns) openIndexRef.current = null
  }, [serviceRuns])

  const closeBus = useCallback(() => {
    if (!base || !openedRef.current) return
    openedRef.current = false
    openIndexRef.current = null
    setOpened(false)
    setOpenedBitrate(null)
    void base.closeService().then(() => refreshRef.current())
  }, [base])

  // A PLC start ends service mode on the runtime; this editor forgets its opening.
  useEffect(() => {
    if (plcRunning) {
      openIndexRef.current = null
      if (openedRef.current) {
        openedRef.current = false
        setOpened(false)
      }
    }
  }, [plcRunning])

  // A network turned off in the project closes the service mode this editor opened.
  const enabled = config.network.enabled
  useEffect(() => {
    if (!enabled) closeBus()
  }, [enabled, closeBus])

  useEffect(
    () => () => {
      if (openedRef.current && base) void base.closeService()
    },
    [base],
  )

  const chooseBitrate = useCallback(
    (bitrate: number) => {
      setChosenBitrate(bitrate)
      closeBus()
    },
    [closeBus],
  )

  if (!client || !live || !hasSdo) return null
  return {
    client,
    networkIndex: live.networkIndex,
    ready: listed || available,
    plcStopped: listed && !serviceRuns && live.network?.plc_running === false,
    nmt: features.includes('nmt'),
    lss: features.includes('lss'),
    requestedNmt,
    service: {
      available,
      open: serviceRuns,
      busy,
      error,
      bitrate: serviceRuns ? openedBitrate : null,
      chosenBitrate,
      chooseBitrate,
    },
  }
}
