/**
 * Checks of a CANopen network that come with a repair: timings that do not fit the PLC cycle,
 * heartbeat timeouts that cannot work, a second SYNC producer, COB-ID clashes, a SYNC window that
 * is not shorter than the SYNC period, node options the EDS does not allow, and receive timeouts on
 * TPDOs sent only after a change. Each fix is a pure
 * function of the configuration, so "Fix all" applies them one after the other as one change.
 */

import type { CanopenConfig, CanopenNode, CanopenPdo } from '../../ports/canopen-types'
import { canopenTypeBits, objectRef } from './data-types'
import { changeOnlyTimeoutText, timeoutOnChangeOnlyPdo } from './editing'
import { pdoConfigured, pdoExchanged, watchesMaster } from './generate-canopen-config'
import {
  canBeGuarded,
  consumerSlots,
  consumerTimeFor,
  effectiveEmcy,
  effectiveProducerMs,
  emcySupport,
  isDummyEntry,
  isGapEntry,
  type PdoDirection,
  restoreChoices,
  updateNode,
  updatePdo,
  writesEventTimer,
} from './model'

export type CanopenCheckLevel = 'error' | 'warning'

/** Node settings shown only in the expert view; a problem on one of them offers to switch to it. */
export type CanopenExpertField =
  | 'configure'
  | 'restoreDefaults'
  | 'identity'
  | 'heartbeatConsumers'
  | 'watchMasterReaction'
  | 'emcy'
  | 'receiveTime'

export interface CanopenCheckFix {
  /** What the fix changes, as a button label: "Set to 150 ms". */
  label: string
  apply: (config: CanopenConfig) => CanopenConfig
}

export interface CanopenCheck {
  level: CanopenCheckLevel
  /** The node's `id`, or undefined for the network. */
  nodeId?: string
  /** "node 2 (io1)" or "node 2 (io1) TPDO 1"; empty for the network. */
  where: string
  text: string
  field?: CanopenExpertField
  fix?: CanopenCheckFix
}

const hex = (v: number, width: number): string => `0x${v.toString(16).toUpperCase().padStart(width, '0')}`

/** What a COB-ID is reserved for, or null. */
export function reservedCobId(id: number): string | null {
  if (id === 0x000) return 'NMT'
  if (id === 0x080) return 'SYNC'
  if (id >= 0x081 && id <= 0x0ff) return 'EMCY'
  if (id === 0x100) return 'TIME'
  if ((id >= 0x581 && id <= 0x5ff) || (id >= 0x601 && id <= 0x67f)) return 'SDO'
  if (id >= 0x701 && id <= 0x77f) return 'heartbeat'
  if (id === 0x7e4 || id === 0x7e5) return 'LSS'
  return null
}

/** Microseconds of an IEC duration such as T#20ms, T#1s500ms or 250us, or null. */
export function durationUs(text: string): number | null {
  let body = text
    .trim()
    .replace(/^(?:t|time)#/i, '')
    .replace(/_/g, '')
  if (body === '') return null
  const units: Record<string, number> = { d: 86_400e6, h: 3_600e6, m: 60e6, s: 1e6, ms: 1e3, us: 1, ns: 1e-3 }
  let total = 0
  while (body !== '') {
    const match = /^(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/i.exec(body)
    if (!match) return null
    total += Number(match[1]) * units[match[2].toLowerCase()]
    body = body.slice(match[0].length)
  }
  return Math.round(total)
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * The PLC cycle in microseconds: the greatest common divisor of the cyclic task intervals, which
 * is the runtime's base tick and the rate of the CANopen exchange. Null without a cyclic task.
 */
export function plcCycleUs(tasks: ReadonlyArray<{ triggering: string; interval: string }>): number | null {
  let cycle = 0
  for (const t of tasks) {
    if (t.triggering !== 'Cyclic') continue
    const us = durationUs(t.interval)
    if (us && us > 0) cycle = gcd(cycle, us)
  }
  return cycle > 0 ? cycle : null
}

/** The smallest whole number of milliseconds at or above `ms` that is a multiple of the cycle. */
export function roundUpToCycle(ms: number, cycleUs: number): number {
  let k = Math.ceil((ms * 1000) / cycleUs)
  while ((k * cycleUs) % 1000 !== 0) k++
  return (k * cycleUs) / 1000
}

/** The largest whole number of milliseconds at or below `ms` that is a multiple of the cycle, or 0. */
export function roundDownToCycle(ms: number, cycleUs: number): number {
  for (let k = Math.floor((ms * 1000) / cycleUs); k > 0; k--)
    if ((k * cycleUs) % 1000 === 0) return (k * cycleUs) / 1000
  return 0
}

function label(node: CanopenNode): string {
  return `node ${node.nodeId} (${node.name})`
}

function setNode(nodeId: string, update: (node: CanopenNode) => CanopenNode) {
  return (config: CanopenConfig): CanopenConfig => updateNode(config, nodeId, update)
}

/** The lowest COB-ID in [from, to] that no one uses and that is not reserved, or null. */
function freeCobId(used: ReadonlySet<number>, from: number, to: number, allowReserved: boolean): number | null {
  for (let id = from; id <= to; id++) if (!used.has(id) && (allowReserved || !reservedCobId(id))) return id
  return null
}

interface CobUse {
  cobId: number
  what: string
  /** A receiver (an RPDO the master does not exchange) shares the COB-ID of one sender. */
  receiver?: boolean
  nodeId?: string
  move?: (cobId: number) => (config: CanopenConfig) => CanopenConfig
  /** Where a new COB-ID is looked for. */
  range: [number, number]
  reservedOk: boolean
}

function cobUses(config: CanopenConfig): CobUse[] {
  const { network, nodes } = config
  const uses: CobUse[] = []
  if (network.syncMode !== 'none') uses.push({ cobId: 0x80, what: 'SYNC', range: [0x80, 0x80], reservedOk: true })
  if (network.time.enabled)
    uses.push({
      cobId: network.time.cobId,
      what: 'TIME',
      move: (cobId) => (c) => ({ ...c, network: { ...c.network, time: { ...c.network.time, cobId } } }),
      range: [0x100, 0x57f],
      reservedOk: true,
    })
  for (const node of nodes) {
    const emcy = effectiveEmcy(node)
    if (emcy.enabled)
      uses.push({
        cobId: emcy.cobId,
        what: `${label(node)} emergency`,
        nodeId: node.id,
        move:
          emcySupport(node.eds) === 'fixed'
            ? undefined
            : (cobId) => setNode(node.id, (n) => ({ ...n, emcy: { ...n.emcy, cobId } })),
        range: [0x81, 0xff],
        reservedOk: true,
      })
  }
  for (const node of nodes) {
    const pdos = (list: CanopenPdo[], direction: PdoDirection): void => {
      for (const pdo of list) {
        if (!pdoConfigured(pdo)) continue
        uses.push({
          cobId: pdo.cobId,
          what: `${label(node)} ${direction === 'input' ? 'TPDO' : 'RPDO'} ${pdo.number}`,
          receiver: direction === 'output' && !pdo.exchanged,
          nodeId: node.id,
          move: (cobId) => setNode(node.id, (n) => updatePdo(n, direction, pdo.number, (p) => ({ ...p, cobId }))),
          range: [0x181, 0x57f],
          reservedOk: false,
        })
      }
    }
    pdos(node.tpdos, 'input')
    pdos(node.rpdos, 'output')
  }
  return uses
}

/** The PDO ranges of the predefined connection set and beyond, in search order. */
const PDO_COB_RANGES: ReadonlyArray<[number, number]> = [
  [0x181, 0x57f],
  [0x681, 0x6df],
]

/** The lowest COB-ID of the PDO ranges that nothing in the network uses and that is not reserved, or null. */
export function freePdoCobId(config: CanopenConfig): number | null {
  const used = new Set(cobUses(config).map((u) => u.cobId))
  for (const [from, to] of PDO_COB_RANGES) {
    const free = freeCobId(used, from, to, false)
    if (free !== null) return free
  }
  return null
}

/**
 * The other ends of a node-to-node PDO: for a TPDO, the RPDOs the master does not exchange on its
 * COB-ID; for such an RPDO, the TPDO that sends its COB-ID. Labels like "node 3 (io2) RPDO 1".
 */
export function pdoLinkPartners(
  config: CanopenConfig,
  nodeId: string,
  direction: PdoDirection,
  pdo: CanopenPdo,
): string[] {
  if (!pdoConfigured(pdo)) return []
  const uses = cobUses(config).filter((u) => u.cobId === pdo.cobId && u.nodeId !== nodeId)
  if (direction === 'input') return uses.filter((u) => u.receiver).map((u) => u.what)
  if (pdo.exchanged) return []
  return uses.filter((u) => !u.receiver && /TPDO \d+$/.test(u.what)).map((u) => u.what)
}

function checkCobIds(config: CanopenConfig, out: CanopenCheck[]): void {
  const all = cobUses(config)
  const uses = all.filter((u) => !u.receiver)
  const used = new Set(all.map((u) => u.cobId))
  const sent = new Set(uses.map((u) => u.cobId))
  for (const r of all.filter((u) => u.receiver && !sent.has(u.cobId)))
    out.push({
      level: 'warning',
      nodeId: r.nodeId,
      where: r.what,
      text: `no node sends its COB-ID ${hex(r.cobId, 3)}`,
    })
  const first = new Map<number, CobUse>()
  for (const use of uses) {
    const owner = first.get(use.cobId)
    if (!owner) {
      first.set(use.cobId, use)
      continue
    }
    const free = use.move ? freeCobId(used, use.range[0], use.range[1], use.reservedOk) : null
    out.push({
      level: 'error',
      nodeId: use.nodeId,
      where: '',
      text: `${use.what} and ${owner.what} use the same COB-ID ${hex(use.cobId, 3)}`,
      field: use.what.endsWith('emergency') ? 'emcy' : undefined,
      fix:
        free !== null && use.move ? { label: `Move ${use.what} to ${hex(free, 3)}`, apply: use.move(free) } : undefined,
    })
  }
}

function checkCycle(config: CanopenConfig, cycleUs: number, out: CanopenCheck[]): void {
  const { network, nodes } = config
  const off = (ms: number): boolean => ms > 0 && (ms * 1000) % cycleUs !== 0
  const cycleText = cycleUs % 1000 === 0 ? `${cycleUs / 1000} ms` : `${cycleUs} µs`
  const warn = (
    where: string,
    what: string,
    ms: number,
    nodeId: string | undefined,
    apply: (ms: number) => (c: CanopenConfig) => CanopenConfig,
  ): void => {
    const to = roundUpToCycle(ms, cycleUs)
    out.push({
      level: 'warning',
      nodeId,
      where,
      text: `${what} (${ms} ms) is not a multiple of the PLC cycle (${cycleText})`,
      fix: { label: `Round to ${to} ms`, apply: apply(to) },
    })
  }
  const net = (update: (ms: number) => Partial<CanopenConfig['network']>) => (ms: number) => (c: CanopenConfig) => ({
    ...c,
    network: { ...c.network, ...update(ms) },
  })
  if (network.syncMode === 'period' && network.syncPeriodUs > 0 && network.syncPeriodUs % cycleUs !== 0) {
    const to = Math.ceil(network.syncPeriodUs / cycleUs) * cycleUs
    out.push({
      level: 'warning',
      where: '',
      text: `the SYNC period (${network.syncPeriodUs} µs) is not a multiple of the PLC cycle (${cycleText})`,
      fix: {
        label: `Round to ${to} µs`,
        apply: (c) => ({ ...c, network: { ...c.network, syncPeriodUs: to } }),
      },
    })
  }
  if (off(network.heartbeatProducerMs))
    warn(
      '',
      'the master heartbeat',
      network.heartbeatProducerMs,
      undefined,
      net((ms) => ({ heartbeatProducerMs: ms })),
    )
  if (network.time.enabled && off(network.time.periodMs))
    warn(
      '',
      'the TIME period',
      network.time.periodMs,
      undefined,
      net((ms) => ({ time: { ...network.time, periodMs: ms } })),
    )
  for (const node of nodes) {
    if (!node.configure) continue
    if (node.supervision === 'heartbeat' && off(node.heartbeatProducerMs))
      warn(label(node), 'the heartbeat time', node.heartbeatProducerMs, node.id, (ms) =>
        setNode(node.id, (n) => ({ ...n, heartbeatProducerMs: ms })),
      )
    if (node.supervision === 'guarding' && off(node.guardTimeMs))
      warn(label(node), 'the guard time', node.guardTimeMs, node.id, (ms) =>
        setNode(node.id, (n) => ({ ...n, guardTimeMs: ms })),
      )
    for (const pdo of node.tpdos) {
      if (!pdoConfigured(pdo) || !off(pdo.eventTimerMs)) continue
      warn(`${label(node)} TPDO ${pdo.number}`, 'the event timer', pdo.eventTimerMs, node.id, (ms) =>
        setNode(node.id, (n) => updatePdo(n, 'input', pdo.number, (p) => ({ ...p, eventTimerMs: ms }))),
      )
    }
  }
}

function checkHeartbeats(config: CanopenConfig, out: CanopenCheck[]): void {
  const { network, nodes } = config
  const percent = network.newNodeDefaults.heartbeatTimeoutPercent
  const longer = (producerMs: number): number => Math.max(consumerTimeFor(producerMs, percent), producerMs + 1)
  const byNodeId = new Map(nodes.map((n) => [n.nodeId, n]))
  for (const node of nodes) {
    if (node.supervision === 'heartbeat') {
      const producer = effectiveProducerMs(node)
      if (producer === 0)
        out.push({
          level: 'error',
          nodeId: node.id,
          where: label(node),
          text: node.configure
            ? 'is supervised by heartbeat with a heartbeat time of 0'
            : 'is supervised by heartbeat, but its file default heartbeat time is 0 and the master does not set it',
        })
      else if (node.heartbeatConsumerMs <= producer) {
        const to = longer(producer)
        out.push({
          level: 'error',
          nodeId: node.id,
          where: label(node),
          text: `the heartbeat timeout (${node.heartbeatConsumerMs} ms) must be longer than the node's heartbeat time (${producer} ms)`,
          fix: { label: `Set to ${to} ms`, apply: setNode(node.id, (n) => ({ ...n, heartbeatConsumerMs: to })) },
        })
      }
    }
    if (node.supervision === 'guarding' && node.configure && (node.guardTimeMs === 0 || node.lifeTimeFactor === 0))
      out.push({
        level: 'error',
        nodeId: node.id,
        where: label(node),
        text: 'node guarding needs a guard time and a life time factor above 0',
      })
    if (node.supervision === 'guarding' && !canBeGuarded(node.eds))
      out.push({
        level: 'error',
        nodeId: node.id,
        where: label(node),
        text: 'the device does not support node guarding (no 0x100C and 0x100D)',
        fix: { label: 'Turn supervision off', apply: setNode(node.id, (n) => ({ ...n, supervision: 'none' })) },
      })
    if (!node.configure) continue
    const slots = consumerSlots(node.eds) - (watchesMaster(node) ? 1 : 0)
    node.heartbeatConsumers.forEach((c, k) => {
      const remove = setNode(node.id, (n) => ({
        ...n,
        heartbeatConsumers: n.heartbeatConsumers.filter((x) => x.id !== c.id),
      }))
      const where = label(node)
      if (k >= slots) {
        out.push({
          level: 'error',
          nodeId: node.id,
          where,
          field: 'heartbeatConsumers',
          text: `watches more heartbeats than its 0x1016 has entries for (${Math.max(slots, 0)})`,
          fix: { label: `Stop watching node ${c.producerNodeId}`, apply: remove },
        })
        return
      }
      const producer = byNodeId.get(c.producerNodeId)
      if (c.producerNodeId === node.nodeId || !producer) {
        out.push({
          level: 'error',
          nodeId: node.id,
          where,
          field: 'heartbeatConsumers',
          text:
            c.producerNodeId === node.nodeId
              ? 'watches its own heartbeat'
              : `watches node ${c.producerNodeId}, which is not in the network`,
          fix: { label: `Stop watching node ${c.producerNodeId}`, apply: remove },
        })
        return
      }
      const producerMs = producer.supervision === 'heartbeat' ? effectiveProducerMs(producer) : 0
      if (producerMs === 0) {
        out.push({
          level: 'error',
          nodeId: node.id,
          where,
          field: 'heartbeatConsumers',
          text: `watches ${label(producer)}, which sends no heartbeat`,
          fix: { label: `Stop watching node ${c.producerNodeId}`, apply: remove },
        })
        return
      }
      if (c.consumerMs <= producerMs) {
        const to = longer(producerMs)
        out.push({
          level: 'error',
          nodeId: node.id,
          where,
          field: 'heartbeatConsumers',
          text: `waits ${c.consumerMs} ms for ${label(producer)}, which must be longer than its heartbeat time (${producerMs} ms)`,
          fix: {
            label: `Set to ${to} ms`,
            apply: setNode(node.id, (n) => ({
              ...n,
              heartbeatConsumers: n.heartbeatConsumers.map((x) => (x.id === c.id ? { ...x, consumerMs: to } : x)),
            })),
          },
        })
      }
    })
  }
}

function checkSync(config: CanopenConfig, cycleUs: number | null, out: CanopenCheck[]): void {
  const { network, nodes } = config
  if (network.syncMode !== 'none') {
    for (const node of nodes) {
      for (const sdo of node.sdos) {
        if (sdo.index !== 0x1005 || sdo.subIndex !== 0) continue
        const value = Number(sdo.value)
        if (!Number.isFinite(value) || (value & 0x40000000) === 0) continue
        out.push({
          level: 'error',
          nodeId: node.id,
          where: label(node),
          text: 'a startup SDO makes the node a SYNC producer, but the master already produces SYNC',
          fix: {
            label: 'Remove that startup SDO',
            apply: setNode(node.id, (n) => ({ ...n, sdos: n.sdos.filter((s) => s.id !== sdo.id) })),
          },
        })
      }
    }
  }
  const periodUs =
    network.syncMode === 'period' ? network.syncPeriodUs : network.syncMode === 'plc_cycle' ? cycleUs : null
  if (network.syncWindowUs > 0 && periodUs !== null && network.syncWindowUs >= periodUs) {
    const to = Math.max(periodUs - (cycleUs !== null && cycleUs < periodUs ? cycleUs : Math.ceil(periodUs / 2)), 1)
    out.push({
      level: 'error',
      where: '',
      text: `the SYNC window (${network.syncWindowUs} µs) must be shorter than the SYNC period (${periodUs} µs)`,
      fix: { label: `Set to ${to} µs`, apply: (c) => ({ ...c, network: { ...c.network, syncWindowUs: to } }) },
    })
  }
}

function checkOptions(config: CanopenConfig, out: CanopenCheck[]): void {
  for (const node of config.nodes) {
    if (node.restoreDefaults === 0) continue
    const turnOff = {
      label: 'Turn restore defaults off',
      apply: setNode(node.id, (n) => ({ ...n, restoreDefaults: 0 })),
    }
    if (!node.configure)
      out.push({
        level: 'error',
        nodeId: node.id,
        where: label(node),
        field: 'restoreDefaults',
        text: 'restores its defaults but is not initialized, so nothing is written to it',
        fix: turnOff,
      })
    else if (!restoreChoices(node.eds).includes(node.restoreDefaults))
      out.push({
        level: 'error',
        nodeId: node.id,
        where: label(node),
        field: 'restoreDefaults',
        text: `restores its defaults with 0x1011 sub ${node.restoreDefaults}, which its device file does not define as writable`,
        fix: turnOff,
      })
  }
}

function checkReceiveTimeouts(config: CanopenConfig, cycleUs: number | null, out: CanopenCheck[]): void {
  for (const node of config.nodes) {
    for (const pdo of node.tpdos) {
      if (!pdoExchanged(pdo) || !timeoutOnChangeOnlyPdo(node, pdo)) continue
      const half = Math.floor(pdo.receiveTimeoutMs / 2)
      const timerMs = cycleUs === null ? half : roundDownToCycle(half, cycleUs)
      const setPdo = (change: Partial<CanopenPdo>) =>
        setNode(node.id, (n) => updatePdo(n, 'input', pdo.number, (p) => ({ ...p, ...change })))
      out.push({
        level: 'warning',
        nodeId: node.id,
        where: `${label(node)} TPDO ${pdo.number}`,
        text: `has a receive timeout, but ${changeOnlyTimeoutText(node, pdo)}`,
        fix:
          pdo.transmissionType !== 0 && writesEventTimer(node, pdo) && timerMs > 0
            ? { label: `Set event timer to ${timerMs} ms`, apply: setPdo({ eventTimerMs: timerMs }) }
            : { label: 'Clear the receive timeout', apply: setPdo({ receiveTimeoutMs: 0 }) },
      })
    }
  }
}

function checkGaps(config: CanopenConfig, out: CanopenCheck[]): void {
  for (const node of config.nodes) {
    for (const direction of ['input', 'output'] as const) {
      for (const pdo of direction === 'input' ? node.tpdos : node.rpdos) {
        for (const e of pdo.entries) {
          if (isDummyEntry(e) || !isGapEntry(node.eds, e)) continue
          out.push({
            level: 'warning',
            nodeId: node.id,
            where: `${label(node)} ${direction === 'input' ? 'TPDO' : 'RPDO'} ${pdo.number}`,
            text: `maps ${objectRef(e.index, e.subIndex)}, which the device file does not describe; it is kept as a gap of ${canopenTypeBits(e.dataType)} bits`,
          })
        }
      }
    }
  }
}

/** Every problem of the network that the editor can explain, with its fix where there is one. */
export function checkCanopenNetwork(config: CanopenConfig, cycleUs: number | null): CanopenCheck[] {
  const out: CanopenCheck[] = []
  checkCobIds(config, out)
  checkHeartbeats(config, out)
  checkSync(config, cycleUs, out)
  checkOptions(config, out)
  checkReceiveTimeouts(config, cycleUs, out)
  checkGaps(config, out)
  if (cycleUs !== null) checkCycle(config, cycleUs, out)
  return out
}

/** The configuration with every fixable problem fixed, one fix at a time, as one change. */
export function fixAllCanopenProblems(config: CanopenConfig, cycleUs: number | null): CanopenConfig {
  let current = config
  for (let round = 0; round < 200; round++) {
    const next = checkCanopenNetwork(current, cycleUs).find((p) => p.fix)
    if (!next?.fix) break
    current = next.fix.apply(current)
  }
  return current
}

/** "node 2 (io1): text", or the text alone for the network. */
export function checkText(problem: CanopenCheck): string {
  return problem.where ? `${problem.where}: ${problem.text}` : problem.text
}
