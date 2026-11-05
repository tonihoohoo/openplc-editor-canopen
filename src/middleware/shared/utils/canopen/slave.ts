/**
 * CANopen slave: the runtime as a CiA 301 node on another master's bus, a `canopen-slave` server.
 * The model's defaults, the PDO layout that follows from the objects, the `devices` items of
 * conf/canopen.json, the checks before a build, and the description its EDS or XDD is written from.
 * The runtime builds the same object dictionary from the `devices` item (its docs/CANOPEN.md).
 */

import type {
  CanopenDataType,
  CanopenEdsInfo,
  CanopenObject,
  CanopenSlaveConfig,
  CanopenSlaveDataType,
  CanopenSlaveDirection,
  CanopenSlaveLss,
  CanopenSlaveObject,
  CanopenSlaveTpdoSettings,
} from '../../ports/canopen-types'
import type { PLCRemoteDevice, PLCServer } from '../../ports/types'
import { CANOPEN_BITRATES, canopenTypeBits, iecSizeLetter, objectRef } from './data-types'
import type { DeviceFileExport } from './dcf-export'
import { writeEds, writeXdd } from './device-writer'
import { checkEds } from './eds-check'
import { readEdsDocument } from './eds-document'
import { checkXdd, type DeviceFileFinding } from './xdd-check'

/** PDOs of each direction the slave has. */
export const SLAVE_PDO_COUNT = 4

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

const DEFAULT_TPDO: CanopenSlaveTpdoSettings = { transmissionType: 255, inhibitTime: 0, eventTimerMs: 0 }

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
    startAlone: false,
    objects: [],
    tpdos: Array.from({ length: SLAVE_PDO_COUNT }, () => ({ ...DEFAULT_TPDO })),
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

/** The slave's TPDO settings, one per PDO, filling any the project lacks. */
export function slaveTpdoSettings(config: CanopenSlaveConfig): CanopenSlaveTpdoSettings[] {
  return Array.from({ length: SLAVE_PDO_COUNT }, (_, i) => config.tpdos[i] ?? { ...DEFAULT_TPDO })
}

export function isSlaveString(object: Pick<CanopenSlaveObject, 'dataType'>): boolean {
  return object.dataType === 'VISIBLE_STRING'
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

export interface SlavePdo {
  number: number
  cobId: number
  objects: CanopenSlaveObject[]
  bytes: number
}

export interface SlavePdoLayout {
  /** RPDOs: objects from the master, as the master sends them. */
  rpdos: SlavePdo[]
  /** TPDOs: objects to the master. */
  tpdos: SlavePdo[]
  /** PDO objects that do not fit in four PDOs of their direction. */
  overflow: CanopenSlaveObject[]
}

const pdoObjects = (config: CanopenSlaveConfig, direction: CanopenSlaveDirection): CanopenSlaveObject[] =>
  config.objects.filter((o) => o.direction === direction && o.exchange === 'pdo' && !isSlaveString(o))

function fill(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
  overflow: CanopenSlaveObject[],
): SlavePdo[] {
  const pdos: SlavePdo[] = []
  let current: SlavePdo | null = null
  for (const object of pdoObjects(config, direction)) {
    const size = slaveObjectBytes(object)
    if (!current || current.bytes + size > SLAVE_PDO_BYTES) {
      if (pdos.length === SLAVE_PDO_COUNT) {
        overflow.push(object)
        continue
      }
      current = { number: pdos.length + 1, cobId: 0, objects: [], bytes: 0 }
      current.cobId = slavePdoCobId(direction, current.number, config.nodeId)
      pdos.push(current)
    }
    current.objects.push(object)
    current.bytes += size
  }
  return pdos
}

/** The default PDO layout: the PDO objects of each direction, in table order, packed into PDO 1-4. */
export function slavePdoLayout(config: CanopenSlaveConfig): SlavePdoLayout {
  const overflow: CanopenSlaveObject[] = []
  const rpdos = fill(config, 'from_master', overflow)
  const tpdos = fill(config, 'to_master', overflow)
  return { rpdos, tpdos, overflow }
}

/** The next free sub-index for a new object of this direction: in 0x2000 (from) or 0x2100 (to), then on. */
export function nextSlaveObjectPlace(
  config: CanopenSlaveConfig,
  direction: CanopenSlaveDirection,
): { index: number; subIndex: number } | null {
  const used = new Set(config.objects.map((o) => o.index * 256 + o.subIndex))
  const start = direction === 'from_master' ? SLAVE_FROM_MASTER_INDEX : SLAVE_TO_MASTER_INDEX
  for (let index = start; index <= 0x5fff; index += 0x100) {
    for (let sub = 1; sub <= 254; sub++) if (!used.has(index * 256 + sub)) return { index, subIndex: sub }
  }
  return null
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
      [objectRef(o.index, o.subIndex), o.name, o.dataType, o.direction, o.exchange, o.defaultValue, o.min, o.max].join(
        '|',
      ),
    )
  const tpdos = slaveTpdoSettings(config).map((t) => `${t.transmissionType}/${t.inhibitTime}/${t.eventTimerMs}`)
  const layout = slavePdoLayout(config)
  const pdos = [...layout.rpdos, ...layout.tpdos].map((p) => p.objects.map((o) => o.id).join(','))
  return JSON.stringify({ objects, tpdos, pdos })
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
    const tpdoSettings = slaveTpdoSettings(config)
    return {
      name,
      interface: config.interface.trim(),
      bitrate: config.bitrate,
      node_id: config.nodeId,
      priority: config.priority,
      identity: {
        device_name: config.deviceName,
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
      start_alone: config.startAlone,
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
        const ranged = o.direction === 'from_master'
        return {
          ...base,
          location: o.iecLocation,
          default: valueOut(o.defaultValue, o.dataType),
          ...(ranged && o.min !== undefined && o.min.trim() !== '' ? { min: valueOut(o.min, o.dataType) } : {}),
          ...(ranged && o.max !== undefined && o.max.trim() !== '' ? { max: valueOut(o.max, o.dataType) } : {}),
        }
      }),
      rpdos: layout.rpdos.map((p) => ({
        number: p.number,
        cob_id: p.cobId,
        transmission: 255,
        entries: p.objects.map((o) => ({ index: o.index, subindex: o.subIndex })),
      })),
      tpdos: layout.tpdos.map((p) => {
        const s = tpdoSettings[p.number - 1]
        return {
          number: p.number,
          cob_id: p.cobId,
          transmission: s.transmissionType,
          inhibit_100us: s.inhibitTime,
          event_timer_ms: s.eventTimerMs,
          entries: p.objects.map((o) => ({ index: o.index, subindex: o.subIndex })),
        }
      }),
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
  /** Field or object the problem concerns: 'interface', 'heartbeat', or an object id. */
  where: string
  text: string
}

/** Problems of one slave, each naming the field or object; `others` are the other slaves that are on. */
export function checkCanopenSlave(
  name: string,
  config: CanopenSlaveConfig,
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
  others: readonly { name: string; config: CanopenSlaveConfig }[] = [],
): SlaveProblem[] {
  const problems: SlaveProblem[] = []
  const add = (where: string, text: string): void => {
    problems.push({ where, text })
  }
  const iface = config.interface.trim()
  if (iface === '') add('interface', 'no CAN interface')
  else if (iface.length > 15) add('interface', `interface name "${iface}" is longer than 15 characters`)
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

  const places = new Map<number, string>()
  const locations = new Map<string, string>()
  for (const o of config.objects) {
    const ref = `${objectRef(o.index, o.subIndex)} "${o.name}"`
    if (o.index < 0x2000 || o.index > 0x5fff || o.subIndex < 1 || o.subIndex > 254)
      add(o.id, `${ref}: the object must be in 0x2000:01 - 0x5FFF:FE`)
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
    if (o.exchange === 'constant') continue
    const prefix = slaveIecPrefix(dataType, o.direction)
    if (o.iecLocation === '') add(o.id, `${ref}: no address`)
    else if (!o.iecLocation.startsWith(prefix) || !/^%[IQ][BWDL]\d+$/.test(o.iecLocation))
      add(o.id, `${ref}: address ${o.iecLocation} must be a ${prefix} address`)
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
  for (const o of slavePdoLayout(config).overflow)
    add(o.id, `${objectRef(o.index, o.subIndex)} "${o.name}": does not fit in four PDOs of 8 bytes`)
  const tpdos = slaveTpdoSettings(config)
  tpdos.forEach((t, i) => {
    if (t.transmissionType > 240 && t.transmissionType < 254)
      add(`tpdo${i + 1}`, `TPDO ${i + 1}: transmission type ${t.transmissionType} is reserved`)
  })
  return problems
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

function pdoParameters(config: CanopenSlaveConfig, layout: SlavePdoLayout): CanopenObject[] {
  const out: CanopenObject[] = []
  const tpdoSettings = slaveTpdoSettings(config)
  for (const direction of ['from_master', 'to_master'] as const) {
    const tpdo = direction === 'to_master'
    const pdos = tpdo ? layout.tpdos : layout.rpdos
    const kind = tpdo ? 'TPDO' : 'RPDO'
    for (let n = 1; n <= SLAVE_PDO_COUNT; n++) {
      const pdo = pdos.find((p) => p.number === n)
      const comm = (tpdo ? 0x1800 : 0x1400) + n - 1
      const parent = `${kind} ${n} communication parameter`
      const base = slavePdoCobId(direction, n, 0) + (pdo ? 0 : 0x80000000)
      out.push(commObject(comm, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', tpdo ? '6' : '5', parent))
      out.push(commObject(comm, 1, `COB-ID used by ${kind}`, 'UNSIGNED32', 'rw', `$NODEID+${hex8(base)}`, parent))
      const s = tpdoSettings[n - 1]
      out.push(
        commObject(comm, 2, 'Transmission type', 'UNSIGNED8', 'rw', String(tpdo ? s.transmissionType : 255), parent),
      )
      if (tpdo) {
        out.push(commObject(comm, 3, 'Inhibit time', 'UNSIGNED16', 'rw', String(s.inhibitTime), parent))
        out.push(commObject(comm, 4, 'Reserved', 'UNSIGNED8', 'rw', '0', parent))
      }
      out.push(commObject(comm, 5, 'Event timer', 'UNSIGNED16', 'rw', String(tpdo ? s.eventTimerMs : 0), parent))
      if (tpdo) out.push(commObject(comm, 6, 'SYNC start value', 'UNSIGNED8', 'rw', '0', parent))
    }
    for (let n = 1; n <= SLAVE_PDO_COUNT; n++) {
      const pdo = pdos.find((p) => p.number === n)
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
    ...(config.softwareVersion !== ''
      ? [commObject(0x100a, 0, 'Manufacturer software version', 'VISIBLE_STRING', 'const', config.softwareVersion)]
      : []),
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
    commObject(0x1029, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', '1', 'Error behavior object'),
    commObject(
      0x1029,
      1,
      'Communication error',
      'UNSIGNED8',
      'rw',
      String({ pre_operational: 0, no_change: 1, stopped: 2 }[config.onMasterLost]),
      'Error behavior object',
    ),
    commObject(0x1200, 0, 'Highest sub-index supported', 'UNSIGNED8', 'const', '2', 'SDO server parameter'),
    commObject(0x1200, 1, 'COB-ID client to server', 'UNSIGNED32', 'ro', '$NODEID+0x600', 'SDO server parameter'),
    commObject(0x1200, 2, 'COB-ID server to client', 'UNSIGNED32', 'ro', '$NODEID+0x580', 'SDO server parameter'),
  ]
  const layout = slavePdoLayout(config)
  objects.push(...pdoParameters(config, layout))

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
      objects.push({
        index,
        subIndex: o.subIndex,
        name: o.name,
        dataType: o.dataType,
        access,
        pdoMapping: o.exchange === 'pdo',
        defaultValue: value,
        parentName: groupName,
        ...(ranged && o.min !== undefined && o.min.trim() !== '' ? { lowLimit: o.min.trim() } : {}),
        ...(ranged && o.max !== undefined && o.max.trim() !== '' ? { highLimit: o.max.trim() } : {}),
      })
    }
  }
  return {
    fileName,
    vendorName: config.vendorName !== '' ? config.vendorName : 'OpenPLC',
    productName: config.deviceName !== '' ? config.deviceName : name,
    details: { orderNumber: config.deviceName !== '' ? config.deviceName : name },
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
  const objects = config.objects.length
  return {
    fileName,
    text,
    summary: `${objects} object${objects === 1 ? '' : 's'}, ${layout.rpdos.length} RPDO${layout.rpdos.length === 1 ? '' : 's'} and ${layout.tpdos.length} TPDO${layout.tpdos.length === 1 ? '' : 's'} in the default layout`,
    errors: findings.filter((f) => f.severity === 'error'),
    warnings: findings.filter((f) => f.severity !== 'error'),
    problems: [],
  }
}
