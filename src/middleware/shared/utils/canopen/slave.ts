/**
 * CANopen slave: the runtime as a CiA 301 node on another master's bus, a `canopen-slave` server.
 * The model's defaults, the stored PDO layout and its edits, the `devices` items of
 * conf/canopen.json, the checks before a build, and the description its EDS or XDD is written from.
 * The runtime builds the same object dictionary from the `devices` item (its docs/CANOPEN.md).
 */

import type {
  CanopenDataType,
  CanopenDeviceDetails,
  CanopenEdsInfo,
  CanopenObject,
  CanopenSlaveBit,
  CanopenSlaveConfig,
  CanopenSlaveDataType,
  CanopenSlaveDirection,
  CanopenSlaveLss,
  CanopenSlaveObject,
  CanopenSlavePdo,
} from '../../ports/canopen-types'
import type { PLCRemoteDevice, PLCServer } from '../../ports/types'
import {
  CANOPEN_BITRATES,
  canopenTypeBits,
  iecSizeLetter,
  interfaceNameProblem,
  objectRef,
  outsideImage,
  reservedCobId,
} from './data-types'
import type { DeviceFileExport } from './dcf-export'
import { writeEds, writeXdd } from './device-writer'
import { checkEds } from './eds-check'
import { readEdsDocument } from './eds-document'
import { slaveDeviceDetailProblems, slaveObjectDetailProblems, slaveObjectInfo } from './slave-details'
import { checkXdd, type DeviceFileFinding } from './xdd-check'

/** PDOs of each direction the slave has. */
export const SLAVE_PDO_COUNT = 16

/** PDOs with a pre-defined COB-ID that follows the node ID. */
export const SLAVE_PREDEFINED_PDOS = 4

/** Bytes a PDO carries. */
export const SLAVE_PDO_BYTES = 8

export const SLAVE_DEFAULT_NODE_ID = 5

/** First index of the objects from the master and to the master. */
export const SLAVE_FROM_MASTER_INDEX = 0x2000
export const SLAVE_TO_MASTER_INDEX = 0x2100

export const SLAVE_MAX_STRING = 255

/** The slave's data types, in the order the type pickers list them. */
export const SLAVE_DATA_TYPES: readonly CanopenSlaveDataType[] = [
  'INTEGER8',
  'INTEGER16',
  'INTEGER32',
  'INTEGER64',
  'UNSIGNED8',
  'UNSIGNED16',
  'UNSIGNED32',
  'UNSIGNED64',
  'REAL32',
  'REAL64',
  'VISIBLE_STRING',
]

/** IEC 61131-3 name of a slave data type, as the program declares it. */
export const SLAVE_IEC_TYPE: Readonly<Record<CanopenSlaveDataType, string>> = {
  INTEGER8: 'SINT',
  INTEGER16: 'INT',
  INTEGER32: 'DINT',
  INTEGER64: 'LINT',
  UNSIGNED8: 'USINT',
  UNSIGNED16: 'UINT',
  UNSIGNED32: 'UDINT',
  UNSIGNED64: 'ULINT',
  REAL32: 'REAL',
  REAL64: 'LREAL',
  VISIBLE_STRING: 'STRING',
}

export function isSlaveDataType(value: string): value is CanopenSlaveDataType {
  return SLAVE_DATA_TYPES.some((t) => t === value)
}

/** A new slave: works without changes once the master knows it. */
export function defaultCanopenSlaveConfig(projectName = ''): CanopenSlaveConfig {
  return {
    enabled: true,
    interface: 'can0',
    bitrate: 500000,
    nodeId: SLAVE_DEFAULT_NODE_ID,
    priority: 90,
    vendorName: '',
    deviceName: projectName.slice(0, SLAVE_MAX_STRING),
    softwareVersion: '',
    vendorId: 0,
    productCode: 1,
    revision: 0x00010000,
    heartbeatMs: 1000,
    masterWatch: { nodeId: 127, timeMs: 0 },
    onMasterLost: 'pre_operational',
    onPlcStop: 'hold',
    onPlcStopState: 'none',
    startAlone: false,
    storeSettings: false,
    objects: [],
    pdos: { rpdos: [], tpdos: [] },
  }
}

/** LSS settings of a slave without any: off. */
export const SLAVE_LSS_OFF: Readonly<CanopenSlaveLss> = {
  enabled: false,
  waitForMaster: false,
  serial: null,
  bitrateChange: true,
}

/** The slave's LSS settings, off for projects made before LSS. */
export function slaveLss(config: CanopenSlaveConfig): CanopenSlaveLss {
  return { ...SLAVE_LSS_OFF, ...config.lss }
}

export function isSlaveString(object: Pick<CanopenSlaveObject, 'dataType'>): boolean {
  return object.dataType === 'VISIBLE_STRING'
}

/** Bits of a packed object: an UNSIGNED8 whose bits the program reads or writes as 8 BOOLs. */
export const SLAVE_PACKED_BITS = 8

/** Label of the packed type in the type pickers, and what it means. */
export const SLAVE_PACKED_LABEL = 'UNSIGNED8 (8 × BOOL)'
export const SLAVE_PACKED_HINT = 'One byte in a PDO, 8 %IX/%QX addresses. Works with any master.'

/** An UNSIGNED8 packed as 8 BOOLs: it has bit rows in place of one address. */
export function isSlavePacked(object: Pick<CanopenSlaveObject, 'bits'>): boolean {
  return (object.bits?.length ?? 0) > 0
}

/** Prefix of a packed object's bit addresses: %IX from the master, %QX to the master. */
export function slaveBitPrefix(direction: CanopenSlaveDirection): string {
  return direction === 'from_master' ? '%IX' : '%QX'
}

/** Channel of bit `bit` of a packed object in the address pool and alias registry. */
export function slaveBitChannel(objectId: string, bit: number): string {
  return `${objectId}.${bit}`
}

/** Bit rows of a newly packed object: "Bit 0" to "Bit 7", addresses still to be given. */
export function newSlaveBits(): CanopenSlaveBit[] {
  return Array.from({ length: SLAVE_PACKED_BITS }, (_, i) => ({ name: `Bit ${i}`, iecLocation: '' }))
}

const BIT_LOCATION = /^%([IQ])X(\d+)\.([0-7])$/

/** The object's address as shown: the address, or "%IX0.0-0.7" for the bits of a packed object. */
export function slaveAddressText(object: Pick<CanopenSlaveObject, 'iecLocation' | 'bits'>): string {
  const bits = object.bits ?? []
  if (bits.length === 0) return object.iecLocation
  const parsed = bits.map((b) => BIT_LOCATION.exec(b.iecLocation))
  const first = parsed[0]
  const oneByte =
    first !== null && parsed.every((m, i) => m !== null && m[1] === first[1] && m[2] === first[2] && Number(m[3]) === i)
  if (oneByte) return `%${first[1]}X${first[2]}.0-${first[2]}.${bits.length - 1}`
  return bits.map((b) => b.iecLocation).join(', ')
}

/** Names of the bits a packed object's value has on, bit 0 first. */
export function slaveBitsOn(object: Pick<CanopenSlaveObject, 'bits'>, value: number): string[] {
  return (object.bits ?? []).filter((_, i) => Math.floor(value / 2 ** i) % 2 === 1).map((b) => b.name)
}

/** Bytes the object takes in a PDO, or its text length for a string. */
export function slaveObjectBytes(object: CanopenSlaveObject): number {
  if (object.dataType === 'VISIBLE_STRING') return object.defaultValue.length
  return canopenTypeBits(object.dataType) / 8
}

/** Prefix of the object's location: %I for objects from the master, %Q to the master. */
export function slaveIecPrefix(dataType: CanopenDataType, direction: CanopenSlaveDirection): string {
  return `%${direction === 'from_master' ? 'I' : 'Q'}${iecSizeLetter(dataType)}`
}

/** The pre-defined COB-ID of PDO `number` (1-4): RPDOs from 0x200, TPDOs from 0x180, plus the node ID. */
export function slavePdoCobId(direction: CanopenSlaveDirection, number: number, nodeId: number): number {
  return (direction === 'from_master' ? 0x200 : 0x180) + 0x100 * (number - 1) + nodeId
}

/** "RPDO 3" or "TPDO 3". */
export function slavePdoName(direction: CanopenSlaveDirection, number: number): string {
  return `${direction === 'from_master' ? 'RPDO' : 'TPDO'} ${number}`
}

/** A PDO of the layout with its objects resolved. */
export interface SlavePdo extends Omit<CanopenSlavePdo, 'objects'> {
  direction: CanopenSlaveDirection
  /** The COB-ID in use: pre-defined for PDO 1-4, the fixed one, or 0 when the master gives it. */
  effectiveCobId: number
  objects: CanopenSlaveObject[]
  bytes: number
}

export interface SlavePdoLayout {
  /** RPDOs: objects from the master, as the master sends them. */
  rpdos: SlavePdo[]
  /** TPDOs: objects to the master. */
  tpdos: SlavePdo[]
  /** PDO objects that do not fit in any PDO of their direction. */
  overflow: CanopenSlaveObject[]
}

const pdoObjects = (config: CanopenSlaveConfig, direction: CanopenSlaveDirection): CanopenSlaveObject[] =>
  config.objects.filter(
    (o) => o.direction === direction && o.exchange === 'pdo' && !o.mappedByMaster && !isSlaveString(o),
  )

/** PDO objects in no default PDO, which the master maps itself. */
export function slaveMasterMappedObjects(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
): CanopenSlaveObject[] {
  return config.objects.filter(
    (o) => o.direction === direction && o.exchange === 'pdo' && o.mappedByMaster === true && !isSlaveString(o),
  )
}

const withMappedByMaster = (config: CanopenSlaveConfig, ids: ReadonlySet<string>, on: boolean): CanopenSlaveConfig => ({
  ...config,
  objects: config.objects.map((o) => {
    if (!ids.has(o.id)) return o
    const { mappedByMaster: _was, ...rest } = o
    return on ? { ...rest, mappedByMaster: true } : rest
  }),
})

const pdoKey = (direction: CanopenSlaveDirection): 'rpdos' | 'tpdos' =>
  direction === 'from_master' ? 'rpdos' : 'tpdos'

/** A new, empty PDO with the default settings, or a project's old TPDO settings. */
function newPdo(config: CanopenSlaveConfig, direction: CanopenSlaveDirection, number: number): CanopenSlavePdo {
  const old = direction === 'to_master' && !config.pdos ? config.tpdos?.[number - 1] : undefined
  return {
    number,
    objects: [],
    cobId: null,
    transmissionType: old?.transmissionType ?? 255,
    inhibitTime: old?.inhibitTime ?? 0,
    eventTimerMs: old?.eventTimerMs ?? 0,
  }
}

function resolvePdo(
  stored: CanopenSlavePdo,
  direction: CanopenSlaveDirection,
  nodeId: number,
  objects: CanopenSlaveObject[],
): SlavePdo {
  const predefined = stored.number <= SLAVE_PREDEFINED_PDOS
  return {
    ...stored,
    cobId: predefined ? null : stored.cobId,
    direction,
    effectiveCobId: predefined ? slavePdoCobId(direction, stored.number, nodeId) : (stored.cobId ?? 0),
    objects,
    bytes: objects.reduce((n, o) => n + slaveObjectBytes(o), 0),
  }
}

function resolveDirection(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
  overflow: CanopenSlaveObject[],
): SlavePdo[] {
  const objects = pdoObjects(config, direction)
  const byId = new Map(objects.map((o) => [o.id, o]))
  const placed = new Set<string>()
  const stored: CanopenSlavePdo[] = []
  for (const p of [...(config.pdos?.[pdoKey(direction)] ?? [])].sort((a, b) => a.number - b.number))
    if (p.number >= 1 && p.number <= SLAVE_PDO_COUNT && !stored.some((q) => q.number === p.number)) stored.push(p)
  const pdos = stored.map((p) => {
    const mapped: CanopenSlaveObject[] = []
    for (const id of p.objects) {
      const o = byId.get(id)
      if (o && !placed.has(id)) {
        placed.add(id)
        mapped.push(o)
      }
    }
    return resolvePdo(p, direction, config.nodeId, mapped)
  })
  const add = (number: number): SlavePdo => {
    const pdo = resolvePdo(newPdo(config, direction, number), direction, config.nodeId, [])
    pdos.push(pdo)
    pdos.sort((a, b) => a.number - b.number)
    return pdo
  }
  const lowestFree = (): number | null => {
    for (let n = 1; n <= SLAVE_PDO_COUNT; n++) if (!pdos.some((p) => p.number === n)) return n
    return null
  }
  // Without a stored layout the objects fill the PDOs in table order; with one, the first PDO with room.
  let current: SlavePdo | null = null
  for (const o of objects) {
    if (placed.has(o.id)) continue
    const size = slaveObjectBytes(o)
    let target: SlavePdo | null = null
    if (config.pdos) target = pdos.find((p) => p.bytes + size <= SLAVE_PDO_BYTES) ?? null
    else if (current && current.bytes + size <= SLAVE_PDO_BYTES) target = current
    if (!target) {
      const free = lowestFree()
      if (free === null) {
        overflow.push(o)
        continue
      }
      target = add(free)
    }
    target.objects.push(o)
    target.bytes += size
    current = target
  }
  return pdos
}

/** The slave's PDO layout: the stored PDOs, with PDO objects not in one placed in the first PDO with room. */
export function slavePdoLayout(config: CanopenSlaveConfig): SlavePdoLayout {
  const overflow: CanopenSlaveObject[] = []
  const rpdos = resolveDirection(config, 'from_master', overflow)
  const tpdos = resolveDirection(config, 'to_master', overflow)
  return { rpdos, tpdos, overflow }
}

const storedPdo = (p: SlavePdo): CanopenSlavePdo => ({
  number: p.number,
  objects: p.objects.map((o) => o.id),
  cobId: p.number <= SLAVE_PREDEFINED_PDOS ? null : p.cobId,
  transmissionType: p.direction === 'to_master' ? p.transmissionType : 255,
  inhibitTime: p.direction === 'to_master' ? p.inhibitTime : 0,
  eventTimerMs: p.eventTimerMs,
})

/** The config with its PDO layout stored as it now resolves, so later edits keep each object where it is. */
export function withSlavePdoLayout(config: CanopenSlaveConfig): CanopenSlaveConfig {
  const layout = slavePdoLayout(config)
  const { tpdos: _old, ...rest } = config
  return { ...rest, pdos: { rpdos: layout.rpdos.map(storedPdo), tpdos: layout.tpdos.map(storedPdo) } }
}

function editPdos(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
  edit: (pdos: CanopenSlavePdo[]) => CanopenSlavePdo[],
): CanopenSlaveConfig {
  const stored = withSlavePdoLayout(config)
  const pdos = stored.pdos ?? { rpdos: [], tpdos: [] }
  const key = pdoKey(direction)
  const next = edit(pdos[key].map((p) => ({ ...p, objects: [...p.objects] }))).sort((a, b) => a.number - b.number)
  return { ...stored, pdos: { ...pdos, [key]: next } }
}

/** The lowest PDO number of the direction the layout does not use, or null when all 16 are used. */
export function freeSlavePdoNumber(config: CanopenSlaveConfig, direction: CanopenSlaveDirection): number | null {
  const used = new Set(slavePdoLayout(config)[pdoKey(direction)].map((p) => p.number))
  for (let n = 1; n <= SLAVE_PDO_COUNT; n++) if (!used.has(n)) return n
  return null
}

/** The config with an empty PDO of the lowest free number added; unchanged when all 16 are used. */
export function addSlavePdo(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
): { config: CanopenSlaveConfig; number: number | null } {
  const number = freeSlavePdoNumber(config, direction)
  if (number === null) return { config, number: null }
  return { config: editPdos(config, direction, (pdos) => [...pdos, newPdo(config, direction, number)]), number }
}

/** The config without the PDO; its objects stay mappable, in no default PDO, so they are not placed again. */
export function removeSlavePdo(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
  number: number,
): CanopenSlaveConfig {
  const stored = withSlavePdoLayout(config)
  const ids = new Set(stored.pdos?.[pdoKey(direction)].find((p) => p.number === number)?.objects ?? [])
  const edited = editPdos(stored, direction, (pdos) => pdos.filter((p) => p.number !== number))
  return withMappedByMaster(edited, ids, true)
}

/** The config with the object taken out of its default PDO: still mappable, the master maps it. */
export function leaveSlaveObjectToMaster(config: CanopenSlaveConfig, objectId: string): CanopenSlaveConfig {
  const object = config.objects.find((o) => o.id === objectId)
  if (!object || object.exchange !== 'pdo' || isSlaveString(object)) return config
  return withSlavePdoLayout(withMappedByMaster(config, new Set([objectId]), true))
}

/** The config with one PDO's settings changed. */
export function updateSlavePdo(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
  number: number,
  update: Partial<Pick<CanopenSlavePdo, 'cobId' | 'transmissionType' | 'inhibitTime' | 'eventTimerMs'>>,
): CanopenSlaveConfig {
  return editPdos(config, direction, (pdos) => pdos.map((p) => (p.number === number ? { ...p, ...update } : p)))
}

/** The PDO the object is in, or null. */
export function slavePdoOf(layout: SlavePdoLayout, objectId: string): SlavePdo | null {
  return [...layout.rpdos, ...layout.tpdos].find((p) => p.objects.some((o) => o.id === objectId)) ?? null
}

/** Why the object cannot move to PDO `number`, or null when it can. */
export function cannotMoveSlaveObject(config: CanopenSlaveConfig, objectId: string, number: number): string | null {
  const layout = slavePdoLayout(config)
  const from = slavePdoOf(layout, objectId)
  const object =
    from?.objects.find((o) => o.id === objectId) ??
    config.objects.find((o) => o.id === objectId && o.exchange === 'pdo' && o.mappedByMaster && !isSlaveString(o))
  if (!object) return 'The object is not a PDO object.'
  if (from?.number === number) return 'It is already there.'
  const to = layout[pdoKey(object.direction)].find((p) => p.number === number)
  if (!to) return null
  const size = slaveObjectBytes(object)
  const free = SLAVE_PDO_BYTES - to.bytes
  if (free >= size) return null
  if (free <= 0) return 'full'
  return `${free} byte${free === 1 ? '' : 's'} free, needs ${size}`
}

/** The config with the object moved to the end of PDO `number`, which is added when the layout has none. */
export function moveSlaveObject(config: CanopenSlaveConfig, objectId: string, number: number): CanopenSlaveConfig {
  if (cannotMoveSlaveObject(config, objectId, number) !== null) return config
  const object = config.objects.find((o) => o.id === objectId)
  if (!object) return config
  const direction = object.direction
  const placed = withSlavePdoLayout(config)
  return editPdos(withMappedByMaster(placed, new Set([objectId]), false), direction, (pdos) => {
    const list = pdos.map((p) => ({ ...p, objects: p.objects.filter((id) => id !== objectId) }))
    const to = list.find((p) => p.number === number)
    if (to) to.objects.push(objectId)
    else list.push({ ...newPdo(config, direction, number), objects: [objectId] })
    return list
  })
}

/** The config with the object one place earlier (-1) or later (+1) in its PDO. */
export function shiftSlaveObject(config: CanopenSlaveConfig, objectId: string, step: -1 | 1): CanopenSlaveConfig {
  const from = slavePdoOf(slavePdoLayout(config), objectId)
  if (!from) return config
  return editPdos(config, from.direction, (pdos) =>
    pdos.map((p) => {
      const at = p.objects.indexOf(objectId)
      const to = at + step
      if (at < 0 || to < 0 || to >= p.objects.length) return p
      const objects = [...p.objects]
      objects[at] = objects[to]
      objects[to] = objectId
      return { ...p, objects }
    }),
  )
}

/** The config with the object at place `to` of its PDO, the others shifted to make room. */
export function placeSlaveObject(config: CanopenSlaveConfig, objectId: string, to: number): CanopenSlaveConfig {
  const from = slavePdoOf(slavePdoLayout(config), objectId)
  if (!from) return config
  return editPdos(config, from.direction, (pdos) =>
    pdos.map((p) => {
      const at = p.objects.indexOf(objectId)
      if (at < 0 || to < 0 || to >= p.objects.length || to === at) return p
      const objects = p.objects.filter((id) => id !== objectId)
      objects.splice(to, 0, objectId)
      return { ...p, objects }
    }),
  )
}

/** Problems of the PDO layout: rows that fit nowhere, PDOs too long, fixed COB-IDs reserved or used twice. */
function pdoLayoutProblems(config: CanopenSlaveConfig, add: (where: string, text: string) => void): void {
  const layout = slavePdoLayout(config)
  for (const o of layout.overflow)
    add(
      o.id,
      `${objectRef(o.index, o.subIndex)} "${o.name}": does not fit in ${SLAVE_PDO_COUNT} ${o.direction === 'from_master' ? 'RPDOs' : 'TPDOs'} of 8 bytes`,
    )
  const used = new Map<number, string>()
  for (const pdo of [...layout.rpdos, ...layout.tpdos]) {
    const name = slavePdoName(pdo.direction, pdo.number)
    const where = `${pdoKey(pdo.direction)}${pdo.number}`
    if (pdo.bytes > SLAVE_PDO_BYTES) add(where, `${name}: maps ${pdo.bytes} bytes; a PDO holds at most 8`)
    if (pdo.direction === 'to_master' && pdo.transmissionType > 240 && pdo.transmissionType < 254)
      add(where, `${name}: transmission type ${pdo.transmissionType} is reserved`)
    if (pdo.objects.length === 0 || pdo.effectiveCobId === 0) continue
    const hex = `0x${pdo.effectiveCobId.toString(16).toUpperCase().padStart(3, '0')}`
    const reserved = pdo.number > SLAVE_PREDEFINED_PDOS ? reservedCobId(pdo.effectiveCobId) : null
    if (reserved) add(where, `${name}: COB-ID ${hex} is reserved for ${reserved}`)
    const other = used.get(pdo.effectiveCobId)
    if (other) add(where, `${name}: COB-ID ${hex} is already ${other}'s`)
    else used.set(pdo.effectiveCobId, name)
  }
}

/** Notes on the PDO layout that do not stop a build: PDOs that a master must enable while Start alone is on. */
export function slavePdoWarnings(config: CanopenSlaveConfig): { where: string; text: string }[] {
  if (!config.startAlone) return []
  const layout = slavePdoLayout(config)
  return [...layout.rpdos, ...layout.tpdos]
    .filter((p) => p.objects.length > 0 && p.effectiveCobId === 0)
    .map((p) => ({
      where: `${pdoKey(p.direction)}${p.number}`,
      text: `${slavePdoName(p.direction, p.number)} is not exchanged until a master gives it a COB-ID; Start alone does not wait for one.`,
    }))
}

/** A COB-ID for a PDO made fixed: the lowest of 0x681 - 0x6DF, which the pre-defined set leaves free, that no PDO of the slave uses. */
export function suggestedSlavePdoCobId(config: CanopenSlaveConfig): number {
  const layout = slavePdoLayout(config)
  const used = new Set([...layout.rpdos, ...layout.tpdos].map((p) => p.effectiveCobId))
  for (let id = 0x681; id <= 0x6df; id++) if (!used.has(id)) return id
  return 0x681
}

/** First and last index of the slave's own objects (CiA 301 manufacturer-specific area). */
export const SLAVE_FIRST_INDEX = 0x2000
export const SLAVE_LAST_INDEX = 0x5fff

/** First index of a new group. */
const SLAVE_NEW_GROUP_INDEX = 0x2200

/** The direction an index belongs to: that of all its objects, else its default group's; `both` when mixed. */
export function slaveIndexDirection(
  config: CanopenSlaveConfig,
  index: number,
  ignoreId?: string,
): CanopenSlaveDirection | 'both' | null {
  const directions = new Set(
    config.objects.filter((o) => o.index === index && o.id !== ignoreId).map((o) => o.direction),
  )
  if (directions.size > 1) return 'both'
  const [only] = [...directions]
  if (only) return only
  if (index === SLAVE_FROM_MASTER_INDEX) return 'from_master'
  if (index === SLAVE_TO_MASTER_INDEX) return 'to_master'
  return null
}

const freeSubIndex = (config: CanopenSlaveConfig, index: number, ignoreId?: string): number | null => {
  const used = new Set(config.objects.filter((o) => o.index === index && o.id !== ignoreId).map((o) => o.subIndex))
  for (let sub = 1; sub <= 254; sub++) if (!used.has(sub)) return sub
  return null
}

/** The lowest index from 0x2200 up, in steps of 0x100, that holds no object. */
export function newSlaveGroupIndex(config: CanopenSlaveConfig, ignoreId?: string): number | null {
  const used = new Set(config.objects.filter((o) => o.id !== ignoreId).map((o) => o.index))
  for (let index = SLAVE_NEW_GROUP_INDEX; index <= SLAVE_LAST_INDEX; index += 0x100) if (!used.has(index)) return index
  return null
}

/** The indexes of a direction, ascending: its default group and every index all of whose objects go that way. */
function directionIndexes(config: CanopenSlaveConfig, direction: CanopenSlaveDirection, ignoreId?: string): number[] {
  const candidates = new Set([
    direction === 'from_master' ? SLAVE_FROM_MASTER_INDEX : SLAVE_TO_MASTER_INDEX,
    ...config.objects.filter((o) => o.id !== ignoreId).map((o) => o.index),
  ])
  return [...candidates]
    .filter((i) => i >= SLAVE_FIRST_INDEX && i <= SLAVE_LAST_INDEX)
    .filter((i) => slaveIndexDirection(config, i, ignoreId) === direction)
    .sort((a, b) => a - b)
}

/**
 * The next free place for an object of this direction: the first free sub-index of the direction's
 * indexes (0x2000 from the master, 0x2100 to the master, then the others), else a new empty group.
 * Never an index that holds the other direction.
 */
export function nextSlaveObjectPlace(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
  ignoreId?: string,
): { index: number; subIndex: number } | null {
  for (const index of directionIndexes(config, direction, ignoreId)) {
    const sub = freeSubIndex(config, index, ignoreId)
    if (sub !== null) return { index, subIndex: sub }
  }
  const index = newSlaveGroupIndex(config, ignoreId)
  return index === null ? null : { index, subIndex: 1 }
}

/** One entry of an object's group menu. */
export interface SlaveGroupChoice {
  index: number
  direction: CanopenSlaveDirection | 'both' | null
  /** Where the object would go; null when the group is full or holds the other direction. */
  place: { index: number; subIndex: number } | null
  /** The object is in this group now. */
  current: boolean
  /** The group is new (no objects yet). */
  isNew: boolean
}

/** The group menu of an object: the groups of both directions, its own first, then a new group. */
export function slaveGroupChoices(config: CanopenSlaveConfig, objectId: string): SlaveGroupChoice[] {
  const object = config.objects.find((o) => o.id === objectId)
  if (!object) return []
  const indexes = new Set([
    SLAVE_FROM_MASTER_INDEX,
    SLAVE_TO_MASTER_INDEX,
    ...config.objects.map((o) => o.index).filter((i) => i >= SLAVE_FIRST_INDEX && i <= SLAVE_LAST_INDEX),
  ])
  const choices: SlaveGroupChoice[] = [...indexes]
    .sort((a, b) => a - b)
    .map((index) => {
      const direction = slaveIndexDirection(config, index, objectId)
      const current = index === object.index
      const sub = freeSubIndex(config, index, objectId)
      const own = direction === object.direction || (direction === null && current)
      const place = current
        ? { index, subIndex: object.subIndex }
        : own && sub !== null
          ? { index, subIndex: sub }
          : null
      return { index, direction, place, current, isNew: false }
    })
  const fresh = newSlaveGroupIndex(config, objectId)
  if (fresh !== null && !indexes.has(fresh))
    choices.push({
      index: fresh,
      direction: null,
      place: { index: fresh, subIndex: 1 },
      current: false,
      isNew: true,
    })
  return choices.sort((a, b) => Number(b.current) - Number(a.current))
}

/** Why an object number cannot be used, by the CiA 301 area it falls in, or null when it can. */
export function slaveObjectNumberProblem(index: number, subIndex: number): string | null {
  const allowed = 'Use 0x2000:01 - 0x5FFF:FE.'
  const hex = `0x${index.toString(16).toUpperCase().padStart(4, '0')}`
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) return `${hex} is not an object index. ${allowed}`
  if (index < 0x1000) return `${hex} is in 0x0000 - 0x0FFF, the area of data types. ${allowed}`
  if (index < SLAVE_FIRST_INDEX)
    return `${hex} is a communication object (0x1000 - 0x1FFF); the slave fills these in itself. ${allowed}`
  if (index > 0xafff) return `${hex} is in a standardized or reserved area (0xB000 - 0xFFFF). ${allowed}`
  if (index > 0x9fff) return `${hex} is in 0xA000 - 0xAFFF, the area of standardized network variables. ${allowed}`
  if (index > SLAVE_LAST_INDEX)
    return `${hex} belongs to device profiles (0x6000 - 0x9FFF), so a master may treat it as a standard object. ${allowed}`
  if (!Number.isInteger(subIndex) || subIndex < 1 || subIndex > 254)
    return `Sub-index 00 holds the highest sub-index and FF is reserved; use 01 - FE.`
  return null
}

const OBJECT_NUMBER = /^(?:0x)?([0-9a-f]{1,4}):(?:0x)?([0-9a-f]{1,2})$/i

/** The place a typed object number names for the object, or why it is refused. */
export function parseSlaveObjectNumber(
  config: CanopenSlaveConfig,
  objectId: string,
  typed: string,
): { place: { index: number; subIndex: number } } | { refusal: string } {
  const m = OBJECT_NUMBER.exec(typed.trim())
  if (!m) return { refusal: 'Write the object as 0x2000:01.' }
  const index = parseInt(m[1] ?? '', 16)
  const subIndex = parseInt(m[2] ?? '', 16)
  const problem = slaveObjectNumberProblem(index, subIndex)
  if (problem) return { refusal: problem }
  const other = config.objects.find((o) => o.id !== objectId && o.index === index && o.subIndex === subIndex)
  if (other) return { refusal: `"${other.name}" uses it.` }
  return { place: { index, subIndex } }
}

/** The direction an index is named after: its default group's, else that of its lowest sub-index. */
function indexOwner(config: CanopenSlaveConfig, index: number): CanopenSlaveDirection | null {
  if (index === SLAVE_FROM_MASTER_INDEX) return 'from_master'
  if (index === SLAVE_TO_MASTER_INDEX) return 'to_master'
  const first = config.objects.filter((o) => o.index === index).sort((a, b) => a.subIndex - b.subIndex)[0]
  return first?.direction ?? null
}

/** Notes on object numbers that do not stop a build: objects in a group of the other direction. */
export function slaveObjectNumberWarnings(
  config: CanopenSlaveConfig,
): { where: string; text: string; moveTo: { index: number; subIndex: number } | null }[] {
  const out: { where: string; text: string; moveTo: { index: number; subIndex: number } | null }[] = []
  for (const o of config.objects) {
    const direction = indexOwner(config, o.index)
    if (direction === null || direction === o.direction) continue
    const hex = `0x${o.index.toString(16).toUpperCase()}`
    const group = direction === 'from_master' ? 'from the master' : 'to the master'
    out.push({
      where: o.id,
      text: `${hex} is the group of objects ${group}. The slave works, but the device file names the group "Objects" and the master's user may read it the wrong way.`,
      moveTo: nextSlaveObjectPlace(config, o.direction, o.id),
    })
  }
  return out
}

/** Free sub-indexes below the highest one of an index, as "03, 05-07"; '' when none. */
export function slaveFreeSubIndexText(config: CanopenSlaveConfig, index: number): string {
  const used = new Set(config.objects.filter((o) => o.index === index).map((o) => o.subIndex))
  const highest = Math.max(0, ...used)
  const parts: string[] = []
  const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
  for (let sub = 1; sub < highest; sub++) {
    if (used.has(sub)) continue
    let end = sub
    while (end + 1 < highest && !used.has(end + 1)) end++
    parts.push(end === sub ? hex2(sub) : `${hex2(sub)}-${hex2(end)}`)
    sub = end
  }
  return parts.join(', ')
}

/** "Setpoint", "Setpoint_2", ...: a name no object of the slave uses yet. */
export function nextSlaveObjectName(config: CanopenSlaveConfig, base: string): string {
  const names = new Set(config.objects.map((o) => o.name.toLowerCase()))
  if (!names.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!names.has(`${base}_${n}`.toLowerCase())) return `${base}_${n}`
}

/** Text of the slave's PDO layout, compared with the last export to suggest a new revision. */
export function slaveLayoutText(config: CanopenSlaveConfig): string {
  const objects = [...config.objects]
    .sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)
    .map((o) =>
      [
        objectRef(o.index, o.subIndex),
        o.name,
        o.dataType,
        o.direction,
        o.exchange,
        o.defaultValue,
        o.min,
        o.max,
        ...(o.bits ?? []).map((b) => b.name),
      ].join('|'),
    )
  const layout = slavePdoLayout(config)
  const pdos = [...layout.rpdos, ...layout.tpdos]
    .filter((p) => p.objects.length > 0)
    .map(
      (p) =>
        `${slavePdoName(p.direction, p.number)}/${p.effectiveCobId}/${p.transmissionType}/${p.inhibitTime}/${p.eventTimerMs}:${p.objects.map((o) => o.id).join(',')}`,
    )
  return JSON.stringify({ objects, pdos })
}

/** The revision the export dialog suggests: one higher when the objects or PDOs changed since the last export. */
export function suggestedSlaveRevision(config: CanopenSlaveConfig): number {
  const last = config.lastExport
  if (!last || last.revision !== config.revision) return config.revision
  return last.layout === slaveLayoutText(config) ? config.revision : Math.min(config.revision + 1, 0xffffffff)
}

// ---- values ----

const INTEGER_RANGES: Partial<Record<CanopenSlaveDataType, [bigint, bigint]>> = {
  INTEGER8: [-128n, 127n],
  INTEGER16: [-32768n, 32767n],
  INTEGER32: [-2147483648n, 2147483647n],
  INTEGER64: [BigInt(Number.MIN_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER)],
  UNSIGNED8: [0n, 255n],
  UNSIGNED16: [0n, 65535n],
  UNSIGNED32: [0n, 4294967295n],
  UNSIGNED64: [0n, BigInt(Number.MAX_SAFE_INTEGER)],
}

/** The number a value text holds for the type, or null when it is not one (or out of range). */
export function parseSlaveValue(text: string, dataType: CanopenSlaveDataType): number | null {
  const t = text.trim()
  if (dataType === 'VISIBLE_STRING' || t === '') return null
  if (dataType === 'REAL32' || dataType === 'REAL64') {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null
    const v = Number(t)
    return Number.isFinite(v) ? v : null
  }
  let big: bigint
  if (/^[-+]?\d+$/.test(t)) big = BigInt(t)
  else if (/^0x[0-9a-f]+$/i.test(t)) big = BigInt(t)
  else return null
  const range = INTEGER_RANGES[dataType]
  if (!range || big < range[0] || big > range[1]) return null
  return Number(big)
}

/** The values a whole-number type takes, as text, or null for REAL and STRING types. */
export function slaveTypeLimits(dataType: CanopenSlaveDataType): [string, string] | null {
  const range = INTEGER_RANGES[dataType]
  return range ? [String(range[0]), String(range[1])] : null
}

/** Why a value text does not suit the type, or null. */
export function slaveValueProblem(text: string, dataType: CanopenSlaveDataType): string | null {
  if (dataType === 'VISIBLE_STRING') {
    if (text.length > SLAVE_MAX_STRING) return `is longer than ${SLAVE_MAX_STRING} characters`
    return /^[\x20-\x7e]*$/.test(text) ? null : 'has characters other than printable ASCII'
  }
  if (parseSlaveValue(text, dataType) !== null) return null
  const range = INTEGER_RANGES[dataType]
  if (range) return `is not a whole number from ${range[0]} to ${range[1]}`
  return 'is not a number'
}

// ---- conf/canopen.json ----

const valueOut = (text: string, dataType: CanopenSlaveDataType): number => parseSlaveValue(text, dataType) ?? 0

function lssOut(config: CanopenSlaveConfig): object | null {
  const lss = slaveLss(config)
  if (!lss.enabled) return null
  return {
    enabled: true,
    wait_for_master: lss.waitForMaster,
    ...(lss.serial !== null ? { serial: lss.serial } : {}),
    bitrate_change: lss.bitrateChange,
  }
}

/** The `devices` items of conf/canopen.json: the slaves that are on. */
export function slaveDevicesOut(servers: readonly PLCServer[] | undefined): object[] {
  return slavesOn(servers).map(({ name, config }) => {
    const layout = slavePdoLayout(config)
    const pdoOut = (p: SlavePdo) => ({
      number: p.number,
      ...(p.effectiveCobId !== 0 ? { cob_id: p.effectiveCobId } : {}),
      transmission: p.transmissionType,
      ...(p.direction === 'to_master' ? { inhibit_100us: p.inhibitTime } : {}),
      event_timer_ms: p.eventTimerMs,
      entries: p.objects.map((o) => ({ index: o.index, subindex: o.subIndex })),
    })
    return {
      name,
      interface: config.interface.trim(),
      bitrate: config.bitrate,
      node_id: config.nodeId,
      priority: config.priority,
      identity: {
        device_name: config.deviceName,
        hardware_version: config.hardwareVersion ?? '',
        software_version: config.softwareVersion,
        vendor_id: config.vendorId,
        product_code: config.productCode,
        revision: config.revision,
      },
      heartbeat_ms: config.heartbeatMs,
      master_watch:
        config.masterWatch.timeMs > 0
          ? { node_id: config.masterWatch.nodeId, time_ms: config.masterWatch.timeMs }
          : null,
      on_master_lost: config.onMasterLost,
      on_plc_stop: config.onPlcStop,
      on_plc_stop_state: config.onPlcStopState,
      start_alone: config.startAlone,
      store_settings: config.storeSettings,
      lss: lssOut(config),
      objects: config.objects.map((o) => {
        const base = {
          index: o.index,
          subindex: o.subIndex,
          name: o.name,
          type: o.dataType,
          direction: o.direction,
          exchange: o.exchange,
        }
        if (o.exchange === 'constant')
          return { ...base, value: isSlaveString(o) ? o.defaultValue : valueOut(o.defaultValue, o.dataType) }
        if (isSlavePacked(o))
          return {
            ...base,
            bits: (o.bits ?? []).map((b) => b.iecLocation),
            default: valueOut(o.defaultValue, o.dataType),
          }
        const ranged = o.direction === 'from_master'
        return {
          ...base,
          location: o.iecLocation,
          default: valueOut(o.defaultValue, o.dataType),
          ...(ranged && o.min !== undefined && o.min.trim() !== '' ? { min: valueOut(o.min, o.dataType) } : {}),
          ...(ranged && o.max !== undefined && o.max.trim() !== '' ? { max: valueOut(o.max, o.dataType) } : {}),
        }
      }),
      rpdos: layout.rpdos.filter((p) => p.objects.length > 0).map(pdoOut),
      tpdos: layout.tpdos.filter((p) => p.objects.length > 0).map(pdoOut),
    }
  })
}

/** The project's slaves that are on, with their configuration. */
export function slavesOn(servers: readonly PLCServer[] | undefined): { name: string; config: CanopenSlaveConfig }[] {
  return canopenSlaves(servers).filter((s) => s.config.enabled)
}

/** Every slave of the project with its configuration. */
export function canopenSlaves(
  servers: readonly PLCServer[] | undefined,
): { name: string; config: CanopenSlaveConfig }[] {
  const out: { name: string; config: CanopenSlaveConfig }[] = []
  for (const s of servers ?? [])
    if (s.protocol === 'canopen-slave' && s.canopenSlaveConfig) out.push({ name: s.name, config: s.canopenSlaveConfig })
  return out
}

// ---- checks ----

export interface SlaveProblem {
  /** Field or object the problem concerns: 'interface', 'heartbeat', 'details', or an object id. */
  where: string
  text: string
  /** A field of the expert view: the basic view offers to turn it on. */
  expert?: boolean
}

/** Problems of one slave, each naming the field or object; `others` are the other slaves that are on. */
export function checkCanopenSlave(
  name: string,
  config: CanopenSlaveConfig,
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
  others: readonly { name: string; config: CanopenSlaveConfig }[] = [],
): SlaveProblem[] {
  const problems: SlaveProblem[] = []
  const add = (where: string, text: string, expert?: boolean): void => {
    problems.push(expert ? { where, text, expert } : { where, text })
  }
  const iface = config.interface.trim()
  if (iface === '') add('interface', 'no CAN interface')
  else if (interfaceNameProblem(iface) !== null) add('interface', interfaceNameProblem(iface) ?? '')
  else {
    for (const d of remoteDevices ?? [])
      if (
        d.protocol === 'canopen' &&
        d.canopenConfig?.network.enabled &&
        d.canopenConfig.network.interface.trim() === iface
      )
        add(
          'interface',
          `interface ${iface} is used by the CANopen master "${d.name}"; a master and a slave cannot share an interface`,
        )
    for (const o of others)
      if (o.name !== name && o.config.interface.trim() === iface)
        add('interface', `interface ${iface} is also used by the CANopen slave "${o.name}"`)
  }
  if (config.bitrate !== 0 && !CANOPEN_BITRATES.some((b) => b === config.bitrate))
    add('bitrate', `bit rate ${config.bitrate} is not a CANopen bit rate`)
  if (!Number.isInteger(config.nodeId) || config.nodeId < 1 || config.nodeId > 127)
    add('nodeId', 'the node ID must be 1 - 127')
  if (!Number.isInteger(config.heartbeatMs) || config.heartbeatMs < 1 || config.heartbeatMs > 65535)
    add('heartbeat', 'the heartbeat time must be 1 - 65535 ms; the slave always sends a heartbeat')
  const lss = slaveLss(config)
  if (
    lss.enabled &&
    lss.serial !== null &&
    (!Number.isInteger(lss.serial) || lss.serial < 1 || lss.serial > 0xffffffff)
  )
    add('lss', 'the fixed LSS serial number must be 1 - 0xFFFFFFFF; it is part of the LSS address')
  if (config.masterWatch.timeMs > 0 && config.masterWatch.nodeId === config.nodeId)
    add('masterWatch', "the master's node ID is the slave's own")
  if (
    config.deviceName.length > SLAVE_MAX_STRING ||
    config.softwareVersion.length > SLAVE_MAX_STRING ||
    config.vendorName.length > SLAVE_MAX_STRING
  )
    add('identity', `names are at most ${SLAVE_MAX_STRING} characters`)
  for (const text of slaveDeviceDetailProblems(config)) add('details', `Device file details: ${text}`, true)

  const places = new Map<number, string>()
  const locations = new Map<string, string>()
  for (const o of config.objects) {
    const ref = `${objectRef(o.index, o.subIndex)} "${o.name}"`
    for (const text of slaveObjectDetailProblems(o)) add(o.id, `${ref}: ${text}`, true)
    const numberProblem = slaveObjectNumberProblem(o.index, o.subIndex)
    if (numberProblem) add(o.id, `${ref}: ${numberProblem}`)
    const key = o.index * 256 + o.subIndex
    if (places.has(key)) add(o.id, `${ref}: the object is also used by "${places.get(key)}"`)
    else places.set(key, o.name)
    const dataType = o.dataType
    if (dataType === 'VISIBLE_STRING') {
      if (o.exchange !== 'constant') add(o.id, `${ref}: a STRING object must be a constant`)
      const problem = slaveValueProblem(o.defaultValue, dataType)
      if (problem) add(o.id, `${ref}: the value ${problem}`)
      continue
    }
    const what = o.exchange === 'constant' ? 'value' : 'default'
    const problem = slaveValueProblem(o.defaultValue, o.dataType)
    if (problem) add(o.id, `${ref}: the ${what} ${problem}`)
    if (o.bits !== undefined) {
      checkPackedBits(o, ref, locations, add)
      continue
    }
    if (o.exchange === 'constant') continue
    const prefix = slaveIecPrefix(dataType, o.direction)
    if (o.iecLocation === '') add(o.id, `${ref}: no address`)
    else if (!o.iecLocation.startsWith(prefix) || !/^%[IQ][BWDL]\d+$/.test(o.iecLocation))
      add(o.id, `${ref}: address ${o.iecLocation} must be a ${prefix} address`)
    else if (outsideImage(o.iecLocation) !== null)
      add(o.id, `${ref}: address ${o.iecLocation} ${outsideImage(o.iecLocation) ?? ''}`)
    else if (locations.has(o.iecLocation))
      add(o.id, `${ref}: address ${o.iecLocation} is also used by "${locations.get(o.iecLocation)}"`)
    else locations.set(o.iecLocation, o.name)
    const hasMin = o.min !== undefined && o.min.trim() !== ''
    const hasMax = o.max !== undefined && o.max.trim() !== ''
    if ((hasMin || hasMax) && o.direction !== 'from_master')
      add(o.id, `${ref}: only an object from the master has a range`)
    else if (hasMin || hasMax) {
      const lo = hasMin ? parseSlaveValue(o.min ?? '', o.dataType) : null
      const hi = hasMax ? parseSlaveValue(o.max ?? '', o.dataType) : null
      const value = parseSlaveValue(o.defaultValue, o.dataType)
      if (hasMin && lo === null)
        add(o.id, `${ref}: the minimum ${slaveValueProblem(o.min ?? '', o.dataType) ?? 'is not valid'}`)
      if (hasMax && hi === null)
        add(o.id, `${ref}: the maximum ${slaveValueProblem(o.max ?? '', o.dataType) ?? 'is not valid'}`)
      if (lo !== null && hi !== null && lo > hi) add(o.id, `${ref}: the minimum is above the maximum`)
      else if (value !== null && ((lo !== null && value < lo) || (hi !== null && value > hi)))
        add(o.id, `${ref}: the default ${o.defaultValue} is outside the range ${o.min ?? ''} - ${o.max ?? ''}`)
    }
  }
  pdoLayoutProblems(config, add)
  return problems
}

/** Problems of a packed object: an UNSIGNED8 by PDO or SDO with 8 named bits at free bit addresses. */
function checkPackedBits(
  o: CanopenSlaveObject,
  ref: string,
  locations: Map<string, string>,
  add: (where: string, text: string) => void,
): void {
  const bits = o.bits ?? []
  if (o.dataType !== 'UNSIGNED8') add(o.id, `${ref}: only an UNSIGNED8 has 8 bits`)
  if (o.exchange === 'constant') add(o.id, `${ref}: an object of 8 bits cannot be a constant`)
  if ((o.min ?? '').trim() !== '' || (o.max ?? '').trim() !== '') add(o.id, `${ref}: an object of 8 bits has no range`)
  if (bits.length !== SLAVE_PACKED_BITS) {
    add(o.id, `${ref}: it has ${bits.length} bits, not ${SLAVE_PACKED_BITS}`)
    return
  }
  const prefix = slaveBitPrefix(o.direction)
  const names = new Set<string>()
  bits.forEach((b, i) => {
    const at = `${ref} bit ${i}`
    if (b.name.trim() === '') add(o.id, `${at}: no name`)
    else if (names.has(b.name.toLowerCase())) add(o.id, `${at}: another bit is named "${b.name}"`)
    names.add(b.name.toLowerCase())
    const m = BIT_LOCATION.exec(b.iecLocation)
    if (b.iecLocation === '') add(o.id, `${at}: no address`)
    else if (!m || `%${m[1]}X` !== prefix) add(o.id, `${at}: address ${b.iecLocation} must be a ${prefix} address`)
    else if (locations.has(b.iecLocation))
      add(o.id, `${at}: address ${b.iecLocation} is also used by "${locations.get(b.iecLocation)}"`)
    else locations.set(b.iecLocation, `${o.name} bit ${i}`)
  })
}

/** Errors that stop the build, one per problem, each naming the slave. */
export function validateCanopenSlaves(
  servers: readonly PLCServer[] | undefined,
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
): string[] {
  const on = slavesOn(servers)
  return on.flatMap(({ name, config }) =>
    checkCanopenSlave(name, config, remoteDevices, on).map((p) => `CANopen slave "${name}": ${p.text}`),
  )
}

// ---- device file ----

const hex8 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`

function commObject(
  index: number,
  subIndex: number,
  name: string,
  dataType: string,
  access: CanopenObject['access'],
  defaultValue: string,
  parentName?: string,
  pdoMapping = false,
): CanopenObject {
  return {
    index,
    subIndex,
    name,
    dataType,
    access,
    pdoMapping,
    defaultValue,
    ...(parentName ? { parentName } : {}),
  }
}

/** 0x1010 and 0x1011 of a slave that keeps the settings a master saves: sub 1 all, 2 communication, 3 application. */
function storeObjects(): CanopenObject[] {
  const out: CanopenObject[] = []
  for (const [index, parent, what] of [
    [0x1010, 'Store parameters', 'Save'],
    [0x1011, 'Restore default parameters', 'Restore'],
  ] as const) {
    out.push(commObject(index, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', '3', parent))
    for (const [sub, area] of [
      [1, 'all parameters'],
      [2, 'communication parameters'],
      [3, 'application parameters'],
    ] as const)
      out.push(commObject(index, sub, `${what} ${area}`, 'UNSIGNED32', 'rw', '1', parent))
  }
  return out
}

function pdoParameters(layout: SlavePdoLayout): CanopenObject[] {
  const out: CanopenObject[] = []
  for (const direction of ['from_master', 'to_master'] as const) {
    const tpdo = direction === 'to_master'
    const pdos = tpdo ? layout.tpdos : layout.rpdos
    const kind = tpdo ? 'TPDO' : 'RPDO'
    for (let n = 1; n <= SLAVE_PDO_COUNT; n++) {
      const found = pdos.find((p) => p.number === n)
      const pdo = found && found.objects.length > 0 ? found : undefined
      const comm = (tpdo ? 0x1800 : 0x1400) + n - 1
      const parent = `${kind} ${n} communication parameter`
      let cob: string
      if (n <= SLAVE_PREDEFINED_PDOS) cob = `$NODEID+${hex8(slavePdoCobId(direction, n, 0) + (pdo ? 0 : 0x80000000))}`
      else cob = hex8(pdo && pdo.effectiveCobId !== 0 ? pdo.effectiveCobId : 0x80000000)
      out.push(commObject(comm, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', tpdo ? '6' : '5', parent))
      out.push(commObject(comm, 1, `COB-ID used by ${kind}`, 'UNSIGNED32', 'rw', cob, parent))
      out.push(
        commObject(
          comm,
          2,
          'Transmission type',
          'UNSIGNED8',
          'rw',
          String(tpdo ? (pdo?.transmissionType ?? 255) : 255),
          parent,
        ),
      )
      if (tpdo) {
        out.push(commObject(comm, 3, 'Inhibit time', 'UNSIGNED16', 'rw', String(pdo?.inhibitTime ?? 0), parent))
        out.push(commObject(comm, 4, 'Reserved', 'UNSIGNED8', 'rw', '0', parent))
      }
      out.push(commObject(comm, 5, 'Event timer', 'UNSIGNED16', 'rw', String(pdo?.eventTimerMs ?? 0), parent))
      if (tpdo) out.push(commObject(comm, 6, 'SYNC start value', 'UNSIGNED8', 'rw', '0', parent))
    }
    for (let n = 1; n <= SLAVE_PDO_COUNT; n++) {
      const found = pdos.find((p) => p.number === n)
      const pdo = found && found.objects.length > 0 ? found : undefined
      const map = (tpdo ? 0x1a00 : 0x1600) + n - 1
      const parent = `${kind} ${n} mapping parameter`
      out.push(
        commObject(map, 0, 'Number of mapped objects', 'UNSIGNED8', 'rw', String(pdo?.objects.length ?? 0), parent),
      )
      for (let s = 1; s <= SLAVE_PDO_BYTES; s++) {
        const o = pdo?.objects[s - 1]
        const value = o ? o.index * 0x10000 + o.subIndex * 0x100 + slaveObjectBytes(o) * 8 : 0
        out.push(commObject(map, s, `Mapped object ${s}`, 'UNSIGNED32', 'rw', hex8(value), parent))
      }
    }
  }
  return out
}

/**
 * The slave as a device description, the same object dictionary the runtime builds: the CiA 301
 * communication objects, the PDO parameters with the default layout, and the application objects.
 * The EDS and XDD writers write the file from it.
 */
export function slaveDeviceInfo(name: string, config: CanopenSlaveConfig, fileName: string): CanopenEdsInfo {
  const lss = slaveLss(config)
  const objects: CanopenObject[] = [
    commObject(0x1000, 0, 'Device type', 'UNSIGNED32', 'ro', '0x00000000'),
    commObject(0x1001, 0, 'Error register', 'UNSIGNED8', 'ro', '0', undefined, true),
    commObject(0x1003, 0, 'Number of errors', 'UNSIGNED8', 'rw', '0', 'Pre-defined error field'),
    ...Array.from({ length: 8 }, (_, i) =>
      commObject(0x1003, i + 1, `Standard error field ${i + 1}`, 'UNSIGNED32', 'ro', '0', 'Pre-defined error field'),
    ),
    commObject(0x1005, 0, 'COB-ID SYNC message', 'UNSIGNED32', 'rw', '0x00000080'),
    commObject(0x1006, 0, 'Communication cycle period', 'UNSIGNED32', 'rw', '0'),
    commObject(0x1007, 0, 'Synchronous window length', 'UNSIGNED32', 'rw', '0'),
    ...(config.deviceName !== ''
      ? [commObject(0x1008, 0, 'Manufacturer device name', 'VISIBLE_STRING', 'const', config.deviceName)]
      : []),
    ...((config.hardwareVersion ?? '') !== ''
      ? [
          commObject(
            0x1009,
            0,
            'Manufacturer hardware version',
            'VISIBLE_STRING',
            'const',
            config.hardwareVersion ?? '',
          ),
        ]
      : []),
    ...(config.softwareVersion !== ''
      ? [commObject(0x100a, 0, 'Manufacturer software version', 'VISIBLE_STRING', 'const', config.softwareVersion)]
      : []),
    ...(config.storeSettings ? storeObjects() : []),
    commObject(0x1014, 0, 'COB-ID EMCY', 'UNSIGNED32', 'rw', '$NODEID+0x80'),
    commObject(0x1016, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', '1', 'Consumer heartbeat time'),
    commObject(
      0x1016,
      1,
      'Consumer heartbeat time 1',
      'UNSIGNED32',
      'rw',
      hex8(config.masterWatch.timeMs > 0 ? config.masterWatch.nodeId * 0x10000 + config.masterWatch.timeMs : 0),
      'Consumer heartbeat time',
    ),
    commObject(0x1017, 0, 'Producer heartbeat time', 'UNSIGNED16', 'rw', String(config.heartbeatMs)),
    commObject(0x1018, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', '4', 'Identity object'),
    commObject(0x1018, 1, 'Vendor-ID', 'UNSIGNED32', 'ro', hex8(config.vendorId), 'Identity object'),
    commObject(0x1018, 2, 'Product code', 'UNSIGNED32', 'ro', hex8(config.productCode), 'Identity object'),
    commObject(0x1018, 3, 'Revision number', 'UNSIGNED32', 'ro', hex8(config.revision), 'Identity object'),
    commObject(
      0x1018,
      4,
      'Serial number',
      'UNSIGNED32',
      'ro',
      hex8(lss.enabled ? (lss.serial ?? 0) : 0),
      'Identity object',
    ),
    commObject(0x1029, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', '2', 'Error behavior object'),
    commObject(
      0x1029,
      1,
      'Communication error',
      'UNSIGNED8',
      'rw',
      String({ pre_operational: 0, no_change: 1, stopped: 2 }[config.onMasterLost]),
      'Error behavior object',
    ),
    commObject(
      0x1029,
      2,
      'PLC stopped',
      'UNSIGNED8',
      'rw',
      String({ pre_operational: 0, none: 1, stopped: 2 }[config.onPlcStopState]),
      'Error behavior object',
    ),
    commObject(0x1200, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', '2', 'SDO server parameter'),
    commObject(0x1200, 1, 'COB-ID client to server', 'UNSIGNED32', 'ro', '$NODEID+0x600', 'SDO server parameter'),
    commObject(0x1200, 2, 'COB-ID server to client', 'UNSIGNED32', 'ro', '$NODEID+0x580', 'SDO server parameter'),
  ]
  const layout = slavePdoLayout(config)
  objects.push(...pdoParameters(layout))

  const byIndex = new Map<number, CanopenSlaveObject[]>()
  for (const o of config.objects) byIndex.set(o.index, [...(byIndex.get(o.index) ?? []), o])
  for (const [index, list] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
    const sorted = [...list].sort((a, b) => a.subIndex - b.subIndex)
    const parent =
      index >= SLAVE_TO_MASTER_INDEX && sorted.every((o) => o.direction === 'to_master')
        ? 'To the master'
        : 'From the master'
    const group = sorted.every((o) => o.direction === sorted[0].direction) ? parent : 'Objects'
    const groupName = `${group} 0x${index.toString(16).toUpperCase()}`
    objects.push(
      commObject(
        index,
        0,
        'Highest sub-index supported',
        'UNSIGNED8',
        'const',
        String(sorted[sorted.length - 1].subIndex),
        groupName,
      ),
    )
    for (const o of sorted) {
      const constant = o.exchange === 'constant'
      const access: CanopenObject['access'] = constant ? 'const' : o.direction === 'from_master' ? 'rw' : 'ro'
      const ranged = !constant && o.direction === 'from_master'
      const value = isSlaveString(o) ? o.defaultValue : String(parseSlaveValue(o.defaultValue, o.dataType) ?? 0)
      const info = slaveObjectInfo(o)
      objects.push({
        index,
        subIndex: o.subIndex,
        name: o.name,
        dataType: o.dataType,
        access,
        pdoMapping: o.exchange === 'pdo',
        defaultValue: value,
        parentName: groupName,
        ...(info ? { info } : {}),
        ...(ranged && o.min !== undefined && o.min.trim() !== '' ? { lowLimit: o.min.trim() } : {}),
        ...(ranged && o.max !== undefined && o.max.trim() !== '' ? { highLimit: o.max.trim() } : {}),
      })
    }
  }
  return {
    fileName,
    vendorName: config.vendorName !== '' ? config.vendorName : 'OpenPLC',
    productName: config.deviceName !== '' ? config.deviceName : name,
    details: slaveDeviceDetails(name, config),
    deviceType: 0,
    vendorId: config.vendorId,
    productCode: config.productCode,
    revision: config.revision,
    rxPdoCount: SLAVE_PDO_COUNT,
    txPdoCount: SLAVE_PDO_COUNT,
    ...(lss.enabled ? { lssSupported: true } : {}),
    objects,
  }
}

function slaveDeviceDetails(name: string, config: CanopenSlaveConfig): CanopenDeviceDetails {
  const order = (config.orderNumber ?? '').trim()
  const product = (config.productText ?? '').trim()
  const characteristics = (config.characteristics ?? [])
    .filter((c) => c.value.trim() !== '' && c.label.trim() !== '')
    .map((c) => ({ value: c.value.trim(), label: c.label.trim() }))
  return {
    orderNumber: order !== '' ? order : config.deviceName !== '' ? config.deviceName : name,
    ...(product !== '' ? { productText: product } : {}),
    ...(characteristics.length > 0 ? { characteristics } : {}),
  }
}

/** File name of the slave's device file: the device name (or server name), safe for a file system. */
export function slaveFileName(name: string, config: CanopenSlaveConfig, format: 'eds' | 'xdd'): string {
  const base = (config.deviceName !== '' ? config.deviceName : name)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${base === '' ? 'canopen-slave' : base}.${format}`
}

/** The slave's EDS or XDD with the device file check's findings: errors stop the export. */
export function buildSlaveExport(
  name: string,
  config: CanopenSlaveConfig,
  format: 'eds' | 'xdd',
  now: Date,
): DeviceFileExport & { warnings: DeviceFileFinding[] } {
  const fileName = slaveFileName(name, config, format)
  const info = slaveDeviceInfo(name, config, fileName)
  const text = format === 'eds' ? writeEds(info, { fileName, now }) : writeXdd(info, { fileName, now })
  const findings: DeviceFileFinding[] =
    format === 'eds' ? checkEds(readEdsDocument(text)).findings : checkXdd(text, info).findings
  const layout = slavePdoLayout(config)
  const used = (pdos: SlavePdo[]) => pdos.filter((p) => p.objects.length > 0).length
  const rpdos = used(layout.rpdos)
  const tpdos = used(layout.tpdos)
  const objects = config.objects.length
  return {
    fileName,
    text,
    summary: `${objects} object${objects === 1 ? '' : 's'}, ${rpdos} RPDO${rpdos === 1 ? '' : 's'} and ${tpdos} TPDO${tpdos === 1 ? '' : 's'} in the default layout`,
    errors: findings.filter((f) => f.severity === 'error'),
    warnings: findings.filter((f) => f.severity !== 'error'),
    problems: [],
  }
}
