/**
 * conf/canopen.json for the runtime's canopen plugin (format in the runtime's docs/CANOPEN.md):
 * one network per CANopen device, with each node's configuration SDOs (supervision, emergency,
 * SYNC window and TIME objects, PDO communication and mapping parameters, the user's startup SDOs,
 * then the heartbeats it watches) resolved from its EDS. A node that is not initialized gets none.
 */

import type {
  CanopenEdsInfo,
  CanopenNetworkSettings,
  CanopenNode,
  CanopenOnCommError,
  CanopenPdo,
} from '../../ports/canopen-types'
import type { PLCRemoteDevice } from '../../ports/types'
import { canopenTypeBits } from './data-types'
import { findObject, masterMayWrite, OBJ_FLAG_REFUSE_WRITE } from './eds-parser'
import {
  canBeGuarded,
  canProduceHeartbeat,
  canReceiveTime,
  canSetEmcy,
  canWatchMaster,
  defaultCanopenConfig,
  defaultEmcyCobId,
  edsDefault,
  edsPdoNumbers,
  effectiveEmcy,
  effectiveGuarding,
  hasErrorBehaviour,
  hasSyncWindow,
  type PdoDirection,
  pdoObjectIndices,
  predefinedCobId,
} from './model'
import { encodeCanopenValue, toHex } from './sdo-value'

export const CANOPEN_CONFIG_VERSION = 3

interface SdoOut {
  index: number
  subindex: number
  data: string
}

interface PdoOut {
  number: number
  cob_id: number
  receive_timeout_ms?: number
  entries: Array<{ index: number; subindex: number; type: string; location: string }>
}

function le(value: number, bytes: number): string {
  const out: number[] = []
  let v = value >>> 0
  for (let i = 0; i < bytes; i++) {
    out.push(v & 0xff)
    v = Math.floor(v / 256)
  }
  return toHex(out)
}

/** Whether the EDS defines this sub-object and the master may write it. */
export function isWritableObject(eds: CanopenEdsInfo, index: number, subIndex: number): boolean {
  const o = findObject(eds, index, subIndex)
  return o !== undefined && masterMayWrite(o)
}

function writable(node: CanopenNode, index: number, subIndex: number): boolean {
  return isWritableObject(node.eds, index, subIndex)
}

/** COB-ID bit 30: no remote request allowed on this PDO. */
const COB_ID_NO_RTR = 0x40000000

/** Whether the master configures this PDO on the node (it maps at least one entry). */
export function pdoConfigured(pdo: CanopenPdo): boolean {
  return pdo.entries.length > 0
}

/** Whether the master exchanges this PDO with the PLC image. */
export function pdoExchanged(pdo: CanopenPdo): boolean {
  return pdoConfigured(pdo) && pdo.exchanged
}

/** The writes that switch off PDO `number`, which the node does not use: its COB-ID with bit 31. */
function unusedPdoSdos(node: CanopenNode, number: number, direction: PdoDirection): SdoOut[] {
  const { comm } = pdoObjectIndices(direction, number)
  if (!writable(node, comm, 1)) return []
  const cobId = edsDefault(node.eds, comm, 1, node.nodeId) ?? predefinedCobId(direction, number, node.nodeId)
  return [{ index: comm, subindex: 1, data: le(((cobId & 0x7ff) | 0x80000000) >>> 0, 4) }]
}

function pdoSdos(node: CanopenNode, pdo: CanopenPdo, direction: PdoDirection): SdoOut[] {
  const { comm, map } = pdoObjectIndices(direction, pdo.number)
  if (!findObject(node.eds, comm, 1)) return []
  const out: SdoOut[] = []
  const cobWritable = writable(node, comm, 1)
  const cobId = direction === 'input' ? (pdo.cobId | COB_ID_NO_RTR) >>> 0 : pdo.cobId
  if (cobWritable) out.push({ index: comm, subindex: 1, data: le((cobId | 0x80000000) >>> 0, 4) })
  if (!pdoConfigured(pdo)) return out
  if (!pdo.fixedMapping && writable(node, map, 0)) {
    out.push({ index: map, subindex: 0, data: le(0, 1) })
    pdo.entries.forEach((e, k) => {
      const value = ((e.index << 16) | (e.subIndex << 8) | canopenTypeBits(e.dataType)) >>> 0
      out.push({ index: map, subindex: k + 1, data: le(value, 4) })
    })
    out.push({ index: map, subindex: 0, data: le(pdo.entries.length, 1) })
  }
  if (writable(node, comm, 2)) out.push({ index: comm, subindex: 2, data: le(pdo.transmissionType, 1) })
  if (direction === 'input') {
    if (writable(node, comm, 3)) out.push({ index: comm, subindex: 3, data: le(pdo.inhibitTime, 2) })
    if (writable(node, comm, 5)) out.push({ index: comm, subindex: 5, data: le(pdo.eventTimerMs, 2) })
  }
  if (cobWritable) out.push({ index: comm, subindex: 1, data: le(cobId, 4) })
  return out
}

const ON_ERROR_CODE: Record<CanopenOnCommError, number> = { pre_operational: 0, no_change: 1, stopped: 2 }

/** Whether the node is set to watch the master's heartbeat and its EDS allows it. */
export function watchesMaster(node: CanopenNode): boolean {
  return node.watchMaster.enabled && canWatchMaster(node.eds)
}

/** The emergency setting the node's EDS gives it (0x1014), as written to it. */
function edsEmcyValue(node: CanopenNode): number {
  return (edsDefault(node.eds, 0x1014, 0, node.nodeId) ?? defaultEmcyCobId(node.nodeId)) >>> 0
}

/** The node's 0x1014 value for its emergency setting (bit 31: no emergency). */
function emcyValue(node: CanopenNode): number {
  return (node.emcy.cobId | (node.emcy.enabled ? 0 : 0x80000000)) >>> 0
}

/** Whether the node receives the network's TIME object. */
export function receivesTime(node: CanopenNode, network: CanopenNetworkSettings): boolean {
  return node.receiveTime && network.time.enabled && canReceiveTime(node.eds)
}

/** The node's configuration SDOs, in the order the master writes them. */
export function nodeConfigurationSdos(node: CanopenNode, network: CanopenNetworkSettings): SdoOut[] {
  const out: SdoOut[] = []
  if (!node.configure) return out
  if (node.supervision === 'heartbeat' && canProduceHeartbeat(node.eds))
    out.push({ index: 0x1017, subindex: 0, data: le(node.heartbeatProducerMs, 2) })
  if (node.supervision === 'guarding' && canBeGuarded(node.eds)) {
    // A node that produces heartbeats is not guarded (CiA 301).
    if (canProduceHeartbeat(node.eds)) out.push({ index: 0x1017, subindex: 0, data: le(0, 2) })
    if (writable(node, 0x100c, 0)) out.push({ index: 0x100c, subindex: 0, data: le(node.guardTimeMs, 2) })
    if (writable(node, 0x100d, 0)) out.push({ index: 0x100d, subindex: 0, data: le(node.lifeTimeFactor, 1) })
  }
  if (canSetEmcy(node.eds) && emcyValue(node) !== edsEmcyValue(node))
    out.push({ index: 0x1014, subindex: 0, data: le(emcyValue(node), 4) })
  if (network.syncWindowUs > 0 && hasSyncWindow(node.eds))
    out.push({ index: 0x1007, subindex: 0, data: le(network.syncWindowUs, 4) })
  if (receivesTime(node, network))
    out.push({ index: 0x1012, subindex: 0, data: le((network.time.cobId | 0x80000000) >>> 0, 4) })
  for (const direction of ['input', 'output'] as const) {
    const list = direction === 'input' ? node.tpdos : node.rpdos
    for (const number of edsPdoNumbers(node.eds, direction)) {
      const pdo = list.find((p) => p.number === number)
      out.push(...(pdo ? pdoSdos(node, pdo, direction) : unusedPdoSdos(node, number, direction)))
    }
  }
  for (const sdo of node.sdos) {
    const object = findObject(node.eds, sdo.index, sdo.subIndex)
    if (object && ((object.objFlags ?? 0) & OBJ_FLAG_REFUSE_WRITE) !== 0) continue
    const encoded = encodeCanopenValue(sdo.dataType, sdo.value)
    if (encoded.ok) out.push({ index: sdo.index, subindex: sdo.subIndex, data: toHex(encoded.bytes) })
  }
  let consumerSub = 1
  if (watchesMaster(node)) {
    const entry = ((network.masterNodeId << 16) | node.watchMaster.consumerMs) >>> 0
    out.push({ index: 0x1016, subindex: consumerSub++, data: le(entry, 4) })
  }
  for (const c of node.heartbeatConsumers) {
    const entry = ((c.producerNodeId << 16) | c.consumerMs) >>> 0
    out.push({ index: 0x1016, subindex: consumerSub++, data: le(entry, 4) })
  }
  if (watchesMaster(node) && hasErrorBehaviour(node.eds))
    out.push({ index: 0x1029, subindex: 1, data: le(ON_ERROR_CODE[node.watchMaster.onError], 1) })
  return out
}

function emcyOut(node: CanopenNode): { enabled: boolean; cob_id: number } {
  const emcy = effectiveEmcy(node)
  return { enabled: emcy.enabled, cob_id: emcy.cobId }
}

function supervisionOut(node: CanopenNode): Record<string, string | number> {
  if (node.supervision === 'heartbeat') return { type: 'heartbeat', consumer_ms: node.heartbeatConsumerMs }
  if (node.supervision === 'guarding') {
    const g = effectiveGuarding(node)
    return { type: 'guarding', guard_time_ms: g.guardTimeMs, life_time_factor: g.lifeTimeFactor }
  }
  return { type: 'none' }
}

function pdosOut(pdos: CanopenPdo[], direction: PdoDirection): PdoOut[] {
  return pdos.filter(pdoExchanged).map((pdo) => ({
    number: pdo.number,
    cob_id: pdo.cobId,
    ...(direction === 'input' && pdo.receiveTimeoutMs > 0 ? { receive_timeout_ms: pdo.receiveTimeoutMs } : {}),
    entries: pdo.entries.map((e) => ({
      index: e.index,
      subindex: e.subIndex,
      type: e.dataType,
      location: e.iecLocation,
    })),
  }))
}

/** CANopen devices of the project whose network is off; they are left out of conf/canopen.json. */
export function canopenNetworksOff(remoteDevices: readonly PLCRemoteDevice[] | undefined): PLCRemoteDevice[] {
  return (remoteDevices ?? []).filter((d) => d.protocol === 'canopen' && d.canopenConfig?.network.enabled === false)
}

/** The JSON text of conf/canopen.json, or null when the project has no CANopen network that is on. */
export function generateCanopenConfig(remoteDevices: readonly PLCRemoteDevice[] | undefined): string | null {
  const networks = (remoteDevices ?? [])
    .filter((d) => d.protocol === 'canopen' && d.canopenConfig?.network.enabled)
    .map((d) => {
      const { network, nodes } = d.canopenConfig ?? defaultCanopenConfig()
      return {
        name: d.name,
        interface: network.interface,
        bitrate: network.bitrate,
        master_node_id: network.masterNodeId,
        heartbeat_producer_ms: network.heartbeatProducerMs,
        sdo_timeout_ms: network.sdoTimeoutMs,
        sync:
          network.syncMode === 'period'
            ? { mode: 'period', period_us: network.syncPeriodUs }
            : { mode: network.syncMode },
        on_plc_stop: network.onPlcStop,
        priority: network.priority,
        boot_timeout_ms: network.bootTimeoutMs,
        on_node_error: network.onNodeError,
        time: network.time.enabled ? { cob_id: network.time.cobId, period_ms: network.time.periodMs } : null,
        nodes: nodes.map((node) => ({
          node_id: node.nodeId,
          name: node.name,
          optional: node.optional,
          configure: node.configure,
          restore_defaults: node.configure ? node.restoreDefaults : 0,
          emcy: emcyOut(node),
          identity: {
            vendor_id: node.checkVendorId ? node.eds.vendorId : 0,
            product_code: node.checkProductCode ? node.eds.productCode : 0,
            revision: node.checkRevision ? node.eds.revision : 0,
          },
          supervision: supervisionOut(node),
          on_loss: node.onLoss,
          ...(node.state.iecLocation ? { state_location: node.state.iecLocation } : {}),
          sdo: nodeConfigurationSdos(node, network),
          tpdos: pdosOut(node.tpdos, 'input'),
          rpdos: pdosOut(node.rpdos, 'output'),
        })),
      }
    })
  if (networks.length === 0) return null
  return JSON.stringify({ version: CANOPEN_CONFIG_VERSION, networks }, null, 2)
}
