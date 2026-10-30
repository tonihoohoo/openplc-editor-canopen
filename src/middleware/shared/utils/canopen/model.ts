/**
 * CANopen device defaults and node construction from a parsed EDS. Pure: IEC addresses and ids
 * come from callbacks the caller supplies.
 */

import type {
  CanopenConfig,
  CanopenDataType,
  CanopenEdsInfo,
  CanopenEmcy,
  CanopenEntry,
  CanopenNetworkSettings,
  CanopenNewNodeDefaults,
  CanopenNode,
  CanopenObject,
  CanopenPdo,
  CanopenSupervision,
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
export const DEFAULT_BOOT_TIMEOUT_MS = 2000
export const DEFAULT_HEARTBEAT_PRODUCER_MS = 100
export const DEFAULT_GUARD_TIME_MS = 1000
export const DEFAULT_LIFE_TIME_FACTOR = 3
export const DEFAULT_TIME_COB_ID = 0x100

/** The default emergency COB-ID of a node (CiA 301 predefined connection set). */
export function defaultEmcyCobId(nodeId: number): number {
  return 0x80 + nodeId
}

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

/** Whether the node can produce heartbeats at a time the master sets (a writable 0x1017). */
export function canProduceHeartbeat(eds: CanopenEdsInfo): boolean {
  return writableObject(eds, 0x1017, 0)
}

/** Whether the node supports node guarding (guard time 0x100C and life time factor 0x100D). */
export function canBeGuarded(eds: CanopenEdsInfo): boolean {
  return findObject(eds, 0x100c, 0) !== undefined && findObject(eds, 0x100d, 0) !== undefined
}

/** The writable 0x1011 sub-indexes of the EDS (1 all, 2 communication, 3 application, 4+ manufacturer). */
export function restoreChoices(eds: CanopenEdsInfo): number[] {
  return eds.objects
    .filter((o) => o.index === 0x1011 && o.subIndex >= 1 && o.access !== 'ro' && o.access !== 'const')
    .map((o) => o.subIndex)
    .sort((a, b) => a - b)
}

/** The name of a 0x1011 sub-index. */
export function restoreChoiceName(subIndex: number): string {
  if (subIndex === 1) return 'All parameters'
  if (subIndex === 2) return 'Communication parameters'
  if (subIndex === 3) return 'Application parameters'
  return `Manufacturer specific (sub ${subIndex})`
}

/** How a node supports emergency messages (0x1014). */
export type EmcySupport = 'none' | 'fixed' | 'writable'

/**
 * `none` without 0x1014 (or a read-only 0x1014 whose default marks the emergency invalid), `fixed`
 * with a read-only 0x1014, `writable` otherwise.
 */
export function emcySupport(eds: CanopenEdsInfo): EmcySupport {
  if (findObject(eds, 0x1014, 0) === undefined) return 'none'
  if (writableObject(eds, 0x1014, 0)) return 'writable'
  return ((defaultInt(eds, 0x1014, 0, 0) ?? 0) & 0x80000000) !== 0 ? 'none' : 'fixed'
}

/** Whether the emergency COB-ID can be written to the node (a writable 0x1014). */
export function canSetEmcy(eds: CanopenEdsInfo): boolean {
  return emcySupport(eds) === 'writable'
}

/** The emergency COB-ID a read-only 0x1014 gives the node. */
export function fixedEmcyCobId(eds: CanopenEdsInfo, nodeId: number): number {
  return (defaultInt(eds, 0x1014, 0, nodeId) ?? defaultEmcyCobId(nodeId)) & 0x7ff
}

/** The node's emergency as the master uses it: off without 0x1014, the EDS COB-ID with a read-only one. */
export function effectiveEmcy(node: CanopenNode): CanopenEmcy {
  switch (emcySupport(node.eds)) {
    case 'none':
      return { ...node.emcy, enabled: false }
    case 'fixed':
      return { ...node.emcy, cobId: fixedEmcyCobId(node.eds, node.nodeId) }
    case 'writable':
      return node.emcy
  }
}

function newNodeEmcy(eds: CanopenEdsInfo, nodeId: number, enabled: boolean): CanopenEmcy {
  const support = emcySupport(eds)
  if (support === 'none') return { enabled: false, cobId: defaultEmcyCobId(nodeId) }
  return { enabled, cobId: support === 'fixed' ? fixedEmcyCobId(eds, nodeId) : defaultEmcyCobId(nodeId) }
}

/** Whether the node can consume TIME (a writable 0x1012). */
export function canReceiveTime(eds: CanopenEdsInfo): boolean {
  return writableObject(eds, 0x1012, 0)
}

/** Whether the node takes a SYNC window length (a writable 0x1007). */
export function hasSyncWindow(eds: CanopenEdsInfo): boolean {
  return writableObject(eds, 0x1007, 0)
}

/** How many heartbeats the node can watch (the sub-indexes of its writable 0x1016). */
export function consumerSlots(eds: CanopenEdsInfo): number {
  return eds.objects.filter((o) => o.index === 0x1016 && o.subIndex >= 1 && o.access !== 'ro' && o.access !== 'const')
    .length
}

/** The supervision `auto` picks for this EDS. */
export function autoSupervision(eds: CanopenEdsInfo): CanopenSupervision {
  if (canProduceHeartbeat(eds)) return 'heartbeat'
  if (canBeGuarded(eds)) return 'guarding'
  return 'none'
}

/** An integer default value from the EDS, with $NODEID resolved, or null. */
export function edsDefault(eds: CanopenEdsInfo, index: number, subIndex: number, nodeId: number): number | null {
  return defaultInt(eds, index, subIndex, nodeId)
}

/** The node's heartbeat producer time as it will run: its own default when the master does not configure it. */
export function effectiveProducerMs(node: CanopenNode): number {
  return node.configure ? node.heartbeatProducerMs : (edsDefault(node.eds, 0x1017, 0, node.nodeId) ?? 0)
}

/** Guard time and life time factor as they will run. */
export function effectiveGuarding(node: CanopenNode): { guardTimeMs: number; lifeTimeFactor: number } {
  if (node.configure) return { guardTimeMs: node.guardTimeMs, lifeTimeFactor: node.lifeTimeFactor }
  return {
    guardTimeMs: edsDefault(node.eds, 0x100c, 0, node.nodeId) ?? 0,
    lifeTimeFactor: edsDefault(node.eds, 0x100d, 0, node.nodeId) ?? 0,
  }
}

/** The consumer time for a producer time at a percentage, rounded up to a millisecond. */
export function consumerTimeFor(producerMs: number, percent: number): number {
  return Math.ceil((producerMs * percent) / 100)
}

export function defaultNewNodeDefaults(): CanopenNewNodeDefaults {
  return { heartbeatTimeoutPercent: 150, supervision: 'auto', emcy: true }
}

export function defaultNetworkSettings(): CanopenNetworkSettings {
  return {
    enabled: true,
    interface: 'can0',
    bitrate: 500000,
    masterNodeId: 127,
    syncMode: 'none',
    syncPeriodUs: 10000,
    heartbeatProducerMs: DEFAULT_MASTER_HEARTBEAT_MS,
    sdoTimeoutMs: 1000,
    onPlcStop: 'pre_operational',
    priority: DEFAULT_BUS_PRIORITY,
    bootTimeoutMs: DEFAULT_BOOT_TIMEOUT_MS,
    onNodeError: 'restart',
    syncWindowUs: 0,
    time: { enabled: false, cobId: DEFAULT_TIME_COB_ID, periodMs: 1000 },
    newNodeDefaults: defaultNewNodeDefaults(),
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
  /** The network's defaults for new nodes; the built-in ones when absent. */
  defaults?: CanopenNewNodeDefaults
}

/**
 * A node from an EDS: its default PDOs, the supervision the network's defaults pick, and watching
 * the master's heartbeat when it can.
 */
export function createCanopenNode(eds: CanopenEdsInfo, options: CreateNodeOptions): CanopenNode {
  const { nodeId, newId, allocate } = options
  const defaults = options.defaults ?? defaultNewNodeDefaults()
  const wanted = defaults.supervision === 'auto' ? autoSupervision(eds) : defaults.supervision
  const supervision =
    (wanted === 'heartbeat' && !canProduceHeartbeat(eds)) || (wanted === 'guarding' && !canBeGuarded(eds))
      ? 'none'
      : wanted
  return {
    id: options.id,
    name: options.name,
    nodeId,
    eds,
    checkVendorId: eds.vendorId !== 0,
    checkProductCode: eds.productCode !== 0,
    checkRevision: false,
    optional: false,
    configure: true,
    restoreDefaults: 0,
    supervision,
    heartbeatConsumerMs: consumerTimeFor(DEFAULT_HEARTBEAT_PRODUCER_MS, defaults.heartbeatTimeoutPercent),
    heartbeatProducerMs: DEFAULT_HEARTBEAT_PRODUCER_MS,
    guardTimeMs: edsDefault(eds, 0x100c, 0, nodeId) || DEFAULT_GUARD_TIME_MS,
    lifeTimeFactor: edsDefault(eds, 0x100d, 0, nodeId) || DEFAULT_LIFE_TIME_FACTOR,
    heartbeatConsumers: [],
    emcy: newNodeEmcy(eds, nodeId, defaults.emcy),
    receiveTime: false,
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
  const emcyCobId =
    emcySupport(node.eds) === 'fixed'
      ? fixedEmcyCobId(node.eds, nodeId)
      : node.emcy.cobId === defaultEmcyCobId(node.nodeId)
        ? defaultEmcyCobId(nodeId)
        : node.emcy.cobId
  return {
    ...node,
    nodeId,
    emcy: { ...node.emcy, cobId: emcyCobId },
    tpdos: move(node.tpdos, 'input'),
    rpdos: move(node.rpdos, 'output'),
  }
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
