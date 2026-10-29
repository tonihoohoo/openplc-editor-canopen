/**
 * CANopen device defaults and node construction from a parsed EDS. Pure: IEC addresses and ids
 * come from callbacks the caller supplies.
 */

import type {
  CanopenConfig,
  CanopenDataType,
  CanopenEdsInfo,
  CanopenEntry,
  CanopenNetworkSettings,
  CanopenNode,
  CanopenObject,
  CanopenPdo,
} from '../../ports/canopen-types'
import { accessFits, canopenTypeBits, iecPrefixFor, toCanopenDataType } from './data-types'
import { findObject, parseEdsInteger } from './eds-parser'

export type PdoDirection = 'input' | 'output'

/** Allocates a free IEC address with this prefix (e.g. "%IB"); `isBit` for %IX/%QX. */
export type AllocateAddress = (prefix: string, isBit: boolean) => string

export const MAX_PDO_BITS = 64
/** Remote request (RTR) transmission types; not supported by the master. */
export const RTR_TRANSMISSION_TYPES: readonly number[] = [252, 253]

/** The type itself, or 255 for an RTR type. */
export function supportedTransmissionType(type: number): number {
  return RTR_TRANSMISSION_TYPES.includes(type) ? 255 : type
}
export const STATE_CHANNEL_ID = 'state'

/** Real-time priority of a network's bus thread: above every PLC task (at most 49), below 98. */
export const DEFAULT_BUS_PRIORITY = 90
export const MIN_BUS_PRIORITY = 1
export const MAX_BUS_PRIORITY = 97
export const DEFAULT_MASTER_HEARTBEAT_MS = 100
export const DEFAULT_WATCH_MASTER_MS = 300

function writableObject(eds: CanopenEdsInfo, index: number, subIndex: number): boolean {
  const o = findObject(eds, index, subIndex)
  return o !== undefined && o.access !== 'ro' && o.access !== 'const'
}

/** Whether the node can watch the master's heartbeat (a writable 0x1016:1). */
export function canWatchMaster(eds: CanopenEdsInfo): boolean {
  return writableObject(eds, 0x1016, 1)
}

/** Whether the node's reaction to a communication error can be set (a writable 0x1029:1). */
export function hasErrorBehaviour(eds: CanopenEdsInfo): boolean {
  return writableObject(eds, 0x1029, 1)
}

export function defaultNetworkSettings(): CanopenNetworkSettings {
  return {
    interface: 'can0',
    bitrate: 500000,
    masterNodeId: 127,
    syncMode: 'none',
    syncPeriodUs: 10000,
    heartbeatProducerMs: DEFAULT_MASTER_HEARTBEAT_MS,
    sdoTimeoutMs: 1000,
    onPlcStop: 'pre_operational',
    priority: DEFAULT_BUS_PRIORITY,
  }
}

export function defaultCanopenConfig(): CanopenConfig {
  return { network: defaultNetworkSettings(), nodes: [] }
}

/** The lowest node ID no node and not the master uses, or null when all are taken. */
export function lowestFreeNodeId(config: CanopenConfig): number | null {
  const used = new Set(config.nodes.map((n) => n.nodeId))
  used.add(config.network.masterNodeId)
  for (let id = 1; id <= 127; id++) if (!used.has(id)) return id
  return null
}

/** Bits a PDO's entries occupy. */
export function pdoBits(pdo: CanopenPdo): number {
  return pdo.entries.reduce((sum, e) => sum + canopenTypeBits(e.dataType), 0)
}

/** Objects of the node that can be mapped into a PDO in this direction, with a supported type. */
export function mappableObjects(eds: CanopenEdsInfo, direction: PdoDirection): CanopenObject[] {
  return eds.objects.filter(
    (o) => o.pdoMapping && toCanopenDataType(o.dataType) !== undefined && accessFits(o.access, direction),
  )
}

/** Communication and mapping parameter indices of PDO `number` (from 1). */
export function pdoObjectIndices(direction: PdoDirection, number: number): { comm: number; map: number } {
  const n = number - 1
  return direction === 'input' ? { comm: 0x1800 + n, map: 0x1a00 + n } : { comm: 0x1400 + n, map: 0x1600 + n }
}

/** The predefined connection set's COB-ID of PDO `number` (1-4), or 0 beyond it. */
export function predefinedCobId(direction: PdoDirection, number: number, nodeId: number): number {
  if (number < 1 || number > 4) return 0
  return (direction === 'input' ? 0x180 : 0x200) + 0x100 * (number - 1) + nodeId
}

/** Rewrites the node ID part of a predefined COB-ID when the node ID changes. */
export function moveCobId(cobId: number, oldNodeId: number, newNodeId: number, direction: PdoDirection): number {
  for (let number = 1; number <= 4; number++) {
    if (cobId === predefinedCobId(direction, number, oldNodeId)) return predefinedCobId(direction, number, newNodeId)
  }
  return cobId
}

function defaultInt(eds: CanopenEdsInfo, index: number, subIndex: number, nodeId: number): number | null {
  const text = findObject(eds, index, subIndex)?.defaultValue
  return text === undefined ? null : parseEdsInteger(text, nodeId)
}

function isReadOnly(object: CanopenObject | undefined): boolean {
  return object !== undefined && (object.access === 'ro' || object.access === 'const')
}

/** Builds an entry for `object`, with an address when `allocate` is given. */
export function entryFor(
  object: CanopenObject,
  type: CanopenDataType,
  direction: PdoDirection,
  channelId: string,
  allocate?: AllocateAddress,
): CanopenEntry {
  return {
    channelId,
    index: object.index,
    subIndex: object.subIndex,
    name: object.name,
    dataType: type,
    iecLocation: allocate ? allocate(iecPrefixFor(type, direction), type === 'BOOLEAN') : '',
  }
}

/** The PDOs the EDS defines in one direction, with their default COB-IDs and mappings. */
export function defaultPdos(
  eds: CanopenEdsInfo,
  direction: PdoDirection,
  nodeId: number,
  newId: () => string,
  allocate: AllocateAddress,
): CanopenPdo[] {
  const pdos: CanopenPdo[] = []
  for (let number = 1; number <= 512; number++) {
    const { comm, map } = pdoObjectIndices(direction, number)
    if (!findObject(eds, comm, 1)) continue
    const rawCob = defaultInt(eds, comm, 1, nodeId)
    const predefined = predefinedCobId(direction, number, nodeId)
    let cobId = rawCob === null ? predefined : rawCob & 0x7ff
    let enabled = rawCob === null ? predefined !== 0 : (rawCob & 0x80000000) === 0
    if (cobId === 0) {
      cobId = predefined
      enabled = false
    }
    const fixedMapping = isReadOnly(findObject(eds, map, 0)) || isReadOnly(findObject(eds, map, 1))
    const pdo: CanopenPdo = {
      number,
      cobId,
      enabled,
      fixedMapping,
      transmissionType: supportedTransmissionType(defaultInt(eds, comm, 2, nodeId) ?? 255),
      eventTimerMs: direction === 'input' ? (defaultInt(eds, comm, 5, nodeId) ?? 0) : 0,
      inhibitTime: direction === 'input' ? (defaultInt(eds, comm, 3, nodeId) ?? 0) : 0,
      receiveTimeoutMs: 0,
      entries: [],
    }
    const count = defaultInt(eds, map, 0, nodeId) ?? 0
    for (let k = 1; k <= count; k++) {
      const value = defaultInt(eds, map, k, nodeId)
      if (value === null) continue
      const object = findObject(eds, (value >>> 16) & 0xffff, (value >>> 8) & 0xff)
      const type = object ? toCanopenDataType(object.dataType) : undefined
      if (!object || !type) continue
      pdo.entries.push(entryFor(object, type, direction, newId(), enabled ? allocate : undefined))
    }
    if (pdo.entries.length === 0 && !fixedMapping) pdo.enabled = false
    pdos.push(pdo)
  }
  return pdos
}

export interface CreateNodeOptions {
  id: string
  name: string
  nodeId: number
  newId: () => string
  allocate: AllocateAddress
}

/**
 * A node from an EDS: its default PDOs, heartbeat supervision when it can produce heartbeats, and
 * watching the master's heartbeat when it can.
 */
export function createCanopenNode(eds: CanopenEdsInfo, options: CreateNodeOptions): CanopenNode {
  const { nodeId, newId, allocate } = options
  const heartbeat = findObject(eds, 0x1017, 0) !== undefined
  return {
    id: options.id,
    name: options.name,
    nodeId,
    eds,
    checkVendorId: eds.vendorId !== 0,
    checkProductCode: eds.productCode !== 0,
    checkRevision: false,
    supervision: heartbeat ? 'heartbeat' : 'none',
    heartbeatConsumerMs: 300,
    heartbeatProducerMs: 100,
    onLoss: 'hold',
    watchMaster: { enabled: canWatchMaster(eds), consumerMs: DEFAULT_WATCH_MASTER_MS, onError: 'pre_operational' },
    state: {
      channelId: STATE_CHANNEL_ID,
      index: 0,
      subIndex: 0,
      name: 'NMT state',
      dataType: 'UNSIGNED8',
      iecLocation: allocate('%IB', false),
    },
    tpdos: defaultPdos(eds, 'input', nodeId, newId, allocate),
    rpdos: defaultPdos(eds, 'output', nodeId, newId, allocate),
    sdos: [],
  }
}

/** Every entry of the node that holds an address: its state, then its PDO entries. */
export function nodeEntries(node: CanopenNode): CanopenEntry[] {
  return [node.state, ...[...node.tpdos, ...node.rpdos].flatMap((p) => p.entries)]
}

/** The node with a new node ID; COB-IDs of the predefined connection set follow it. */
export function withNodeId(node: CanopenNode, nodeId: number): CanopenNode {
  const move = (pdos: CanopenPdo[], direction: PdoDirection): CanopenPdo[] =>
    pdos.map((p) => ({ ...p, cobId: moveCobId(p.cobId, node.nodeId, nodeId, direction) }))
  return { ...node, nodeId, tpdos: move(node.tpdos, 'input'), rpdos: move(node.rpdos, 'output') }
}

/** `base`, or `base_2`, `base_3`, ... when another node already has the name. */
export function uniqueNodeName(config: CanopenConfig, base: string): string {
  const taken = new Set(config.nodes.map((n) => n.name))
  if (!taken.has(base)) return base
  for (let k = 2; ; k++) if (!taken.has(`${base}_${k}`)) return `${base}_${k}`
}

/** A node name from an EDS product name: letters, digits and underscores, not starting with a digit. */
export function nodeNameFromEds(eds: CanopenEdsInfo): string {
  const cleaned = eds.productName
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (cleaned === '') return 'node'
  return /^[0-9]/.test(cleaned) ? `node_${cleaned}` : cleaned
}

/** The config with one node replaced by `update(node)`. */
export function updateNode(
  config: CanopenConfig,
  nodeId: string,
  update: (node: CanopenNode) => CanopenNode,
): CanopenConfig {
  return { ...config, nodes: config.nodes.map((n) => (n.id === nodeId ? update(n) : n)) }
}

/** The node with one PDO replaced by `update(pdo)`. */
export function updatePdo(
  node: CanopenNode,
  direction: PdoDirection,
  number: number,
  update: (pdo: CanopenPdo) => CanopenPdo,
): CanopenNode {
  const map = (pdos: CanopenPdo[]): CanopenPdo[] => pdos.map((p) => (p.number === number ? update(p) : p))
  return direction === 'input' ? { ...node, tpdos: map(node.tpdos) } : { ...node, rpdos: map(node.rpdos) }
}

/** Why `object` cannot be added to `pdo`, or null when it fits. */
export function cannotMap(pdo: CanopenPdo, object: CanopenObject): string | null {
  if (pdo.fixedMapping) return 'The EDS fixes the mapping of this PDO.'
  const type = toCanopenDataType(object.dataType)
  if (!type) return 'The object has a data type the master does not support.'
  if (pdoBits(pdo) + canopenTypeBits(type) > MAX_PDO_BITS)
    return `A PDO carries at most ${MAX_PDO_BITS / 8} bytes; this entry does not fit.`
  return null
}

/** The PDO switched on or off: an enabled PDO's entries get addresses, a disabled one's give theirs up. */
export function withPdoEnabled(
  pdo: CanopenPdo,
  direction: PdoDirection,
  enabled: boolean,
  allocate: AllocateAddress,
): CanopenPdo {
  return {
    ...pdo,
    enabled,
    entries: pdo.entries.map((e) => ({
      ...e,
      iecLocation: enabled
        ? e.iecLocation || allocate(iecPrefixFor(e.dataType, direction), e.dataType === 'BOOLEAN')
        : '',
      alias: enabled ? e.alias : undefined,
    })),
  }
}

/** Placeholder allocator: an address of the right class, which the project's address recalculation then places. */
export const placeholderAddress: AllocateAddress = (prefix, isBit) => (isBit ? `${prefix}0.0` : `${prefix}0`)

/** The node with the alias of one entry (its state or a PDO entry) set; an empty alias removes it. */
export function withEntryAlias(node: CanopenNode, channelId: string, alias: string): CanopenNode {
  const set = (e: CanopenEntry): CanopenEntry =>
    e.channelId === channelId ? { ...e, alias: alias === '' ? undefined : alias } : e
  const pdos = (list: CanopenPdo[]): CanopenPdo[] => list.map((p) => ({ ...p, entries: p.entries.map(set) }))
  return { ...node, state: set(node.state), tpdos: pdos(node.tpdos), rpdos: pdos(node.rpdos) }
}
