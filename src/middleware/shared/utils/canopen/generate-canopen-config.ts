/**
 * conf/canopen.json for the runtime's canopen plugin (format in the runtime's docs/CANOPEN.md):
 * one network per CANopen device, with each node's configuration SDOs (heartbeat producer, PDO
 * communication and mapping parameters, then the user's startup SDOs) resolved from its EDS.
 */

import type { CanopenEdsInfo, CanopenNode, CanopenPdo } from '../../ports/canopen-types'
import type { PLCRemoteDevice } from '../../ports/types'
import { canopenTypeBits } from './data-types'
import { findObject } from './eds-parser'
import { type PdoDirection, pdoObjectIndices } from './model'
import { encodeCanopenValue, toHex } from './sdo-value'

export const CANOPEN_CONFIG_VERSION = 1

interface SdoOut {
  index: number
  subindex: number
  data: string
}

interface PdoOut {
  number: number
  cob_id: number
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
  return o !== undefined && o.access !== 'ro' && o.access !== 'const'
}

function writable(node: CanopenNode, index: number, subIndex: number): boolean {
  return isWritableObject(node.eds, index, subIndex)
}

/** COB-ID bit 30: no remote request allowed on this PDO. */
const COB_ID_NO_RTR = 0x40000000

/** Whether the master exchanges this PDO. */
export function pdoActive(pdo: CanopenPdo): boolean {
  return pdo.enabled && pdo.entries.length > 0
}

function pdoSdos(node: CanopenNode, pdo: CanopenPdo, direction: PdoDirection): SdoOut[] {
  const { comm, map } = pdoObjectIndices(direction, pdo.number)
  if (!findObject(node.eds, comm, 1)) return []
  const out: SdoOut[] = []
  const cobWritable = writable(node, comm, 1)
  const active = pdoActive(pdo)
  const cobId = direction === 'input' ? (pdo.cobId | COB_ID_NO_RTR) >>> 0 : pdo.cobId
  if (cobWritable) out.push({ index: comm, subindex: 1, data: le((cobId | 0x80000000) >>> 0, 4) })
  if (!active) return out
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

/** The node's configuration SDOs, in the order the master writes them. */
export function nodeConfigurationSdos(node: CanopenNode): SdoOut[] {
  const out: SdoOut[] = []
  if (node.supervision === 'heartbeat' && writable(node, 0x1017, 0))
    out.push({ index: 0x1017, subindex: 0, data: le(node.heartbeatProducerMs, 2) })
  for (const pdo of node.tpdos) out.push(...pdoSdos(node, pdo, 'input'))
  for (const pdo of node.rpdos) out.push(...pdoSdos(node, pdo, 'output'))
  for (const sdo of node.sdos) {
    const encoded = encodeCanopenValue(sdo.dataType, sdo.value)
    if (encoded.ok) out.push({ index: sdo.index, subindex: sdo.subIndex, data: toHex(encoded.bytes) })
  }
  return out
}

function pdosOut(pdos: CanopenPdo[]): PdoOut[] {
  return pdos.filter(pdoActive).map((pdo) => ({
    number: pdo.number,
    cob_id: pdo.cobId,
    entries: pdo.entries.map((e) => ({
      index: e.index,
      subindex: e.subIndex,
      type: e.dataType,
      location: e.iecLocation,
    })),
  }))
}

/** The JSON text of conf/canopen.json, or null when the project has no CANopen device. */
export function generateCanopenConfig(remoteDevices: readonly PLCRemoteDevice[] | undefined): string | null {
  const networks = (remoteDevices ?? [])
    .filter((d) => d.protocol === 'canopen' && d.canopenConfig)
    .map((d) => {
      const { network, nodes } = d.canopenConfig ?? { network: undefined, nodes: [] }
      return {
        name: d.name,
        interface: network?.interface ?? '',
        bitrate: network?.bitrate ?? 0,
        master_node_id: network?.masterNodeId ?? 127,
        heartbeat_producer_ms: network?.heartbeatProducerMs ?? 0,
        sdo_timeout_ms: network?.sdoTimeoutMs ?? 1000,
        sync:
          network?.syncMode === 'period'
            ? { mode: 'period', period_us: network.syncPeriodUs }
            : { mode: network?.syncMode ?? 'none' },
        on_plc_stop: network?.onPlcStop ?? 'pre_operational',
        nodes: nodes.map((node) => ({
          node_id: node.nodeId,
          name: node.name,
          identity: {
            vendor_id: node.checkVendorId ? node.eds.vendorId : 0,
            product_code: node.checkProductCode ? node.eds.productCode : 0,
            revision: node.checkRevision ? node.eds.revision : 0,
          },
          supervision:
            node.supervision === 'heartbeat'
              ? { type: 'heartbeat', consumer_ms: node.heartbeatConsumerMs }
              : { type: 'none' },
          on_loss: node.onLoss,
          ...(node.state.iecLocation ? { state_location: node.state.iecLocation } : {}),
          sdo: nodeConfigurationSdos(node),
          tpdos: pdosOut(node.tpdos),
          rpdos: pdosOut(node.rpdos),
        })),
      }
    })
  if (networks.length === 0) return null
  return JSON.stringify({ version: CANOPEN_CONFIG_VERSION, networks }, null, 2)
}
