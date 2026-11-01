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
import { findObject, masterMayWrite, parseEdsInteger } from './eds-parser'

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
  return o !== undefined && masterMayWrite(o)
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
  return eds.objects.filter((o) => o.index === 0x1016 && o.subIndex >= 1 && masterMayWrite(o)).length
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

/** The node settings that decide how a TPDO is sent and what a late TPDO does to its inputs. */
export type PdoNodeContext = Pick<CanopenNode, 'eds' | 'nodeId' | 'configure' | 'onLoss'>

/** Whether the master writes this TPDO's event timer (0x18xx:05). */
export function writesEventTimer(node: PdoNodeContext, pdo: CanopenPdo): boolean {
  if (!node.configure) return false
  const object = findObject(node.eds, pdoObjectIndices('input', pdo.number).comm, 5)
  return object !== undefined && !isReadOnly(object)
}

/** A TPDO's event timer as it will run: the EDS default, or 0, when the master does not write it. */
export function effectiveEventTimerMs(node: PdoNodeContext, pdo: CanopenPdo): number {
  if (writesEventTimer(node, pdo)) return pdo.eventTimerMs
  return defaultInt(node.eds, pdoObjectIndices('input', pdo.number).comm, 5, node.nodeId) ?? 0
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

/** Types of the CiA 301 dummy objects 0x0001-0x0007, by index. */
export const DUMMY_TYPES: Readonly<Record<number, CanopenDataType>> = {
  1: 'BOOLEAN',
  2: 'INTEGER8',
  3: 'INTEGER16',
  4: 'INTEGER32',
  5: 'UNSIGNED8',
  6: 'UNSIGNED16',
  7: 'UNSIGNED32',
}

/** The dummy objects "Add gap" offers, one per size: 1, 8, 16 and 32 bits. */
export const GAP_DUMMIES = [1, 5, 6, 7] as const

/** Whether the entry maps a dummy object: a gap the device skips or fills with zeros. */
export function isDummyEntry(entry: { index: number; subIndex: number }): boolean {
  return entry.index >= 1 && entry.index <= 7 && entry.subIndex === 0
}

/** Whether the entry holds no PLC value: a dummy, or an object the device file does not describe. */
export function isGapEntry(eds: CanopenEdsInfo, entry: CanopenEntry): boolean {
  if (isDummyEntry(entry)) return true
  const object = findObject(eds, entry.index, entry.subIndex)
  return object === undefined || toCanopenDataType(object.dataType) === undefined
}

/** A gap entry of dummy object `dummy` (0x0001-0x0007). */
export function gapEntry(dummy: number, channelId: string): CanopenEntry {
  const dataType = DUMMY_TYPES[dummy] ?? 'UNSIGNED8'
  const bits = canopenTypeBits(dataType)
  return {
    channelId,
    index: dummy,
    subIndex: 0,
    name: `Gap (${bits} bit${bits === 1 ? '' : 's'})`,
    dataType,
    iecLocation: '',
  }
}

const UNKNOWN_TYPES: Readonly<Record<number, CanopenDataType>> = {
  1: 'BOOLEAN',
  8: 'UNSIGNED8',
  16: 'UNSIGNED16',
  32: 'UNSIGNED32',
  64: 'UNSIGNED64',
}

/** PDO numbers the EDS defines in one direction (those with a communication parameter sub 1), ascending. */
export function edsPdoNumbers(eds: CanopenEdsInfo, direction: PdoDirection): number[] {
  const out: number[] = []
  for (let number = 1; number <= 512; number++)
    if (findObject(eds, pdoObjectIndices(direction, number).comm, 1)) out.push(number)
  return out
}

/** Whether the EDS default of this PDO's COB-ID is valid (bit 31 clear and not 0). */
function edsPdoValid(eds: CanopenEdsInfo, direction: PdoDirection, number: number, nodeId: number): boolean {
  const raw = defaultInt(eds, pdoObjectIndices(direction, number).comm, 1, nodeId)
  if (raw === null) return predefinedCobId(direction, number, nodeId) !== 0
  return (raw & 0x80000000) === 0 && (raw & 0x7ff) !== 0
}

/**
 * PDO `number` with the EDS defaults: COB-ID (0 when the file gives none outside the predefined
 * set), transmission settings and default mapping; entries get addresses when `allocate` is given.
 */
export function edsPdo(
  eds: CanopenEdsInfo,
  direction: PdoDirection,
  number: number,
  nodeId: number,
  newId: () => string,
  allocate?: AllocateAddress,
): CanopenPdo {
  const { comm, map } = pdoObjectIndices(direction, number)
  const rawCob = defaultInt(eds, comm, 1, nodeId)
  const predefined = predefinedCobId(direction, number, nodeId)
  const fileCob = rawCob === null ? 0 : rawCob & 0x7ff
  const cobId = fileCob === 0 ? predefined : fileCob
  const fixedMapping = isReadOnly(findObject(eds, map, 0)) || isReadOnly(findObject(eds, map, 1))
  const pdo: CanopenPdo = {
    number,
    cobId,
    followsNodeId: predefined !== 0 && cobId === predefined,
    exchanged: true,
    fixedMapping,
    transmissionType: supportedTransmissionType(defaultInt(eds, comm, 2, nodeId) ?? 255),
    eventTimerMs: direction === 'input' ? (defaultInt(eds, comm, 5, nodeId) ?? 0) : 0,
    inhibitTime: direction === 'input' ? (defaultInt(eds, comm, 3, nodeId) ?? 0) : 0,
    receiveTimeoutMs: 0,
    deadlineMs: 0,
    entries: [],
  }
  const count = defaultInt(eds, map, 0, nodeId) ?? 0
  for (let k = 1; k <= count; k++) {
    const value = defaultInt(eds, map, k, nodeId)
    if (value === null || value === 0) continue
    const index = (value >>> 16) & 0xffff
    const subIndex = (value >>> 8) & 0xff
    // Dummies and objects the file does not describe stay in place, so later entries keep their offsets.
    if (isDummyEntry({ index, subIndex })) {
      pdo.entries.push(gapEntry(index, newId()))
      continue
    }
    const object = findObject(eds, index, subIndex)
    const type = object ? toCanopenDataType(object.dataType) : undefined
    if (object && type) {
      pdo.entries.push(entryFor(object, type, direction, newId(), allocate))
      continue
    }
    const unknownType = UNKNOWN_TYPES[value & 0xff]
    if (unknownType)
      pdo.entries.push({
        channelId: newId(),
        index,
        subIndex,
        name: object ? `${object.name} (not mappable)` : 'Not in the device file',
        dataType: unknownType,
        iecLocation: '',
      })
  }
  return pdo
}

/** The PDOs a new node uses in one direction: those the EDS makes valid by default and that map an entry. */
export function defaultPdos(
  eds: CanopenEdsInfo,
  direction: PdoDirection,
  nodeId: number,
  newId: () => string,
  allocate: AllocateAddress,
): CanopenPdo[] {
  return edsPdoNumbers(eds, direction)
    .filter((number) => edsPdoValid(eds, direction, number, nodeId))
    .map((number) => edsPdo(eds, direction, number, nodeId, newId, allocate))
    .filter((pdo) => pdo.entries.length > 0)
}

/** PDO numbers of the EDS that the node does not use yet, ascending. */
export function addablePdoNumbers(node: CanopenNode, direction: PdoDirection): number[] {
  const used = new Set((direction === 'input' ? node.tpdos : node.rpdos).map((p) => p.number))
  return edsPdoNumbers(node.eds, direction).filter((n) => !used.has(n))
}

/**
 * PDOs the EDS makes valid by default that the node does not use and whose COB-ID the master
 * cannot switch off; the device keeps sending or expecting them.
 */
export function unswitchablePdoNumbers(node: CanopenNode, direction: PdoDirection): number[] {
  if (!node.configure) return []
  return addablePdoNumbers(node, direction).filter((number) => {
    const object = findObject(node.eds, pdoObjectIndices(direction, number).comm, 1)
    return edsPdoValid(node.eds, direction, number, node.nodeId) && (object === undefined || !masterMayWrite(object))
  })
}

/** The node's PDO list in one direction with `pdos` in it, ordered by PDO number. */
export function withPdos(node: CanopenNode, direction: PdoDirection, pdos: CanopenPdo[]): CanopenNode {
  const sorted = [...pdos].sort((a, b) => a.number - b.number)
  return direction === 'input' ? { ...node, tpdos: sorted } : { ...node, rpdos: sorted }
}

/** The node without PDO `number`. */
export function removePdo(node: CanopenNode, direction: PdoDirection, number: number): CanopenNode {
  const list = direction === 'input' ? node.tpdos : node.rpdos
  return withPdos(
    node,
    direction,
    list.filter((p) => p.number !== number),
  )
}

/** The COB-ID of `pdo` shown as node ID plus a base, or null when it does not follow the node ID. */
export function cobIdBase(pdo: CanopenPdo, nodeId: number): number | null {
  return pdo.followsNodeId ? pdo.cobId - nodeId : null
}

/** Why `entry` cannot move to `target`, or null when it can. */
export function cannotMoveEntry(target: CanopenPdo, entry: CanopenEntry): string | null {
  if (target.fixedMapping) return 'The EDS fixes the mapping of this PDO.'
  if (pdoBits(target) + canopenTypeBits(entry.dataType) > MAX_PDO_BITS)
    return `A PDO carries at most ${MAX_PDO_BITS / 8} bytes; this entry does not fit.`
  return null
}

/**
 * The node with entry `channelId` moved from PDO `from` to the end of PDO `to`, keeping its address
 * and alias; unchanged when the move is not allowed. Moving to or from a PDO the master does not
 * exchange gives up or takes an address.
 */
export function moveEntryToPdo(
  node: CanopenNode,
  direction: PdoDirection,
  from: number,
  to: number,
  channelId: string,
  allocate: AllocateAddress,
): CanopenNode {
  const list = direction === 'input' ? node.tpdos : node.rpdos
  const source = list.find((p) => p.number === from)
  const target = list.find((p) => p.number === to)
  const entry = source?.entries.find((e) => e.channelId === channelId)
  if (!source || !target || !entry || from === to || source.fixedMapping || cannotMoveEntry(target, entry)) return node
  const moved: CanopenEntry = isGapEntry(node.eds, entry)
    ? entry
    : target.exchanged
      ? {
          ...entry,
          iecLocation:
            entry.iecLocation || allocate(iecPrefixFor(entry.dataType, direction), entry.dataType === 'BOOLEAN'),
        }
      : { ...entry, iecLocation: '', alias: undefined }
  return withPdos(
    node,
    direction,
    list.map((p) => {
      if (p.number === from) return { ...p, entries: p.entries.filter((e) => e.channelId !== channelId) }
      if (p.number === to) return { ...p, entries: [...p.entries, moved] }
      return p
    }),
  )
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
  const move = (pdos: CanopenPdo[]): CanopenPdo[] =>
    pdos.map((p) => (p.followsNodeId ? { ...p, cobId: p.cobId - node.nodeId + nodeId } : p))
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
    tpdos: move(node.tpdos),
    rpdos: move(node.rpdos),
  }
}

/** `base`, or `base_2`, `base_3`, ... when another node already has the name. */
export function uniqueNodeName(config: CanopenConfig, base: string): string {
  const taken = new Set(config.nodes.map((n) => n.name))
  if (!taken.has(base)) return base
  for (let k = 2; ; k++) if (!taken.has(`${base}_${k}`)) return `${base}_${k}`
}

/** A node name from any text: letters, digits and underscores, not starting with a digit. */
export function toNodeName(text: string): string {
  const cleaned = text
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (cleaned === '') return 'node'
  return /^[0-9]/.test(cleaned) ? `node_${cleaned}` : cleaned
}

/** A node name from an EDS product name. */
export function nodeNameFromEds(eds: CanopenEdsInfo): string {
  return toNodeName(eds.productName)
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

/** The PDO exchanged by the master or not: an exchanged PDO's entries get addresses, another's give theirs up. */
export function withPdoExchanged(
  pdo: CanopenPdo,
  direction: PdoDirection,
  exchanged: boolean,
  allocate: AllocateAddress,
  eds?: CanopenEdsInfo,
): CanopenPdo {
  const gap = (e: CanopenEntry): boolean => (eds ? isGapEntry(eds, e) : isDummyEntry(e))
  return {
    ...pdo,
    exchanged,
    entries: pdo.entries.map((e) => ({
      ...e,
      iecLocation:
        exchanged && !gap(e)
          ? e.iecLocation || allocate(iecPrefixFor(e.dataType, direction), e.dataType === 'BOOLEAN')
          : '',
      alias: exchanged ? e.alias : undefined,
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
