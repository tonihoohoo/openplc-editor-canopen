/**
 * The LSS tools of the network's Online tab: what a device without a node ID matches in the project,
 * the node IDs to offer it, and the LSS node "Add as node" creates.
 */

import type { CanopenConfig, CanopenEdsInfo, CanopenNode } from '../../ports/canopen-types'
import { type AllocateAddress, createCanopenNode, nodeNameFromEds, uniqueNodeName } from './model'
import type { LssDevice } from './online'

/** What a found device matches: a project node given over LSS, a device file of the project, or nothing. */
export type LssMatch =
  | { kind: 'node'; node: CanopenNode }
  | { kind: 'file'; eds: CanopenEdsInfo; fileName: string }
  | { kind: 'none' }

function sameProduct(eds: CanopenEdsInfo, device: LssDevice): boolean {
  return eds.vendorId === device.vendorId && eds.productCode === device.productCode
}

/**
 * The project node with this LSS serial number, vendor ID and product code; else a device file of a
 * project node (any CANopen network of @p others too) with the device's vendor ID and product code.
 */
export function lssMatch(device: LssDevice, config: CanopenConfig, others: readonly CanopenConfig[] = []): LssMatch {
  const node = config.nodes.find(
    (n) => n.lss?.enabled === true && n.lss.serialNumber === device.serialNumber && sameProduct(n.eds, device),
  )
  if (node) return { kind: 'node', node }
  for (const c of [config, ...others]) {
    const withFile = c.nodes.find((n) => sameProduct(n.eds, device))
    if (withFile)
      return { kind: 'file', eds: withFile.eds, fileName: withFile.eds.source?.fileName ?? withFile.eds.productName }
  }
  return { kind: 'none' }
}

/** The name a found device is listed by: the product name of the device file it matches. */
export function lssDeviceName(match: LssMatch): string {
  if (match.kind === 'node') return match.node.eds.productName
  if (match.kind === 'file') return match.eds.productName
  return 'Unknown device'
}

const hex8 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`

/** A found device's full LSS address in one line, for a tooltip or a dialog. */
export function lssAddressText(device: LssDevice): string {
  return `Vendor ${hex8(device.vendorId)}, product ${hex8(device.productCode)}, revision ${hex8(device.revision)}, serial ${hex8(device.serialNumber)}`
}

/** Node IDs to offer: the free ones first, then those the project's nodes use; never the master's. */
export function lssNodeIdChoices(config: CanopenConfig): { free: number[]; taken: number[] } {
  const used = new Set(config.nodes.map((n) => n.nodeId))
  const free: number[] = []
  const taken: number[] = []
  for (let id = 1; id <= 127; id++) {
    if (id === config.network.masterNodeId) continue
    if (used.has(id)) taken.push(id)
    else free.push(id)
  }
  return { free, taken }
}

/**
 * A node for the found device, given its node ID by the master over LSS at every start when its
 * device file lists LSS support; otherwise a plain node with that node ID.
 */
export function lssNodeForDevice(
  config: CanopenConfig,
  eds: CanopenEdsInfo,
  device: LssDevice,
  nodeId: number,
  store: boolean,
  options: { id: string; newId: () => string; allocate: AllocateAddress },
): CanopenNode {
  const node = createCanopenNode(eds, {
    ...options,
    name: uniqueNodeName(config, nodeNameFromEds(eds)),
    nodeId,
    defaults: config.network.newNodeDefaults,
  })
  if (!eds.lssSupported) return node
  return { ...node, lss: { enabled: true, serialNumber: device.serialNumber, revision: device.revision, store } }
}

const kbit = (bitrate: number) => `${bitrate / 1000} kbit/s`

/** The note in the network header while the bus is open at @p open (bit/s), another rate than the network's. */
export function serviceBitrateNote(open: number | null, networkBitrate: number): string | null {
  if (open === null || open === networkBitrate) return null
  return networkBitrate > 0
    ? `The bus is open at ${kbit(open)}, not at the network's ${kbit(networkBitrate)}. Nodes at the network's bit rate do not answer.`
    : `The bus is open at ${kbit(open)}, not at the interface's own bit rate.`
}
