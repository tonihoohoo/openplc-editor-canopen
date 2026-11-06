/**
 * A device file read into a CANopen slave: the slave made from an EDS, DCF, XDD or XDC (identity,
 * communication settings, application objects and default PDO layout), or objects of the file added
 * to a slave, with the list of what the slave cannot take. The inverse of `slaveDeviceInfo`.
 */

import type {
  CanopenEdsInfo,
  CanopenObject,
  CanopenSlaveConfig,
  CanopenSlaveDataType,
  CanopenSlaveDirection,
  CanopenSlaveObject,
  CanopenSlaveOnMasterLost,
  CanopenSlaveOnPlcStopState,
  CanopenSlavePdo,
  CanopenValueMeaning,
} from '../../ports/canopen-types'
import { CANOPEN_BITRATES, objectRef, reservedCobId, toCanopenDataType } from './data-types'
import type { DcfContent } from './dcf-import'
import { findObject, parseEdsInteger } from './eds-parser'
import {
  isSlaveDataType,
  parseSlaveValue,
  SLAVE_FIRST_INDEX,
  SLAVE_LAST_INDEX,
  SLAVE_LSS_OFF,
  SLAVE_MAX_STRING,
  SLAVE_PACKED_BITS,
  SLAVE_PDO_BYTES,
  SLAVE_PDO_COUNT,
  SLAVE_PREDEFINED_PDOS,
  slaveObjectBytes,
  slavePdoCobId,
  slavePdoLayout,
  slavePdoName,
  slaveTypeLimits,
  withSlavePdoLayout,
} from './slave'

export type SlaveImportMode = 'replace' | 'add'

/** Groups of the list of what is not imported, in the order the dialog shows them. */
export type SlaveImportGroup = 'outside' | 'type' | 'pdo' | 'setting'

export const SLAVE_IMPORT_GROUPS: readonly { group: SlaveImportGroup; title: string }[] = [
  { group: 'outside', title: 'Outside 0x2000:01 - 0x5FFF:FE' },
  { group: 'type', title: 'Types the slave does not hold' },
  { group: 'pdo', title: 'PDOs' },
  { group: 'setting', title: 'Settings and values' },
]

export interface SlaveImportLine {
  group: SlaveImportGroup
  what: string
  detail: string
}

/** An application object of the file the slave can hold. */
export interface SlaveImportCandidate {
  /** "0x2000:01": the key the dialog picks it by. */
  ref: string
  object: CanopenSlaveObject
  /** Add objects: why it cannot be added (its number is used), or null. */
  blocked: string | null
}

export interface SlaveImportResult {
  config: CanopenSlaveConfig
  candidates: SlaveImportCandidate[]
  notImported: SlaveImportLine[]
  summary: string
}

export interface SlaveImportFile {
  eds: CanopenEdsInfo
  dcf: DcfContent
}

export interface SlaveImportOptions {
  newId: () => string
  /** Add objects: the refs of the ticked objects; all that can be added when absent. */
  picked?: ReadonlySet<string>
}

const OTHER_TYPE_NAMES: Readonly<Record<string, string>> = {
  '0x000A': 'OCTET_STRING',
  '0x000B': 'UNICODE_STRING',
  '0x000C': 'TIME_OF_DAY',
  '0x000D': 'TIME_DIFFERENCE',
  '0x000F': 'DOMAIN',
  '0x0010': 'INTEGER24',
  '0x0012': 'INTEGER40',
  '0x0013': 'INTEGER48',
  '0x0014': 'INTEGER56',
  '0x0016': 'UNSIGNED24',
  '0x0018': 'UNSIGNED40',
  '0x0019': 'UNSIGNED48',
  '0x001A': 'UNSIGNED56',
}

const typeLabel = (dataType: string): string => OTHER_TYPE_NAMES[dataType.toUpperCase().replace('0X', '0x')] ?? dataType

/** The slave type of a file type, or null for types the slave does not hold. */
function slaveTypeOf(dataType: string): CanopenSlaveDataType | null {
  if (dataType === 'VISIBLE_STRING' || dataType.toLowerCase() === '0x0009') return 'VISIBLE_STRING'
  const t = toCanopenDataType(dataType)
  return t && isSlaveDataType(t) ? t : null
}

const directionOf = (access: CanopenObject['access']): CanopenSlaveDirection =>
  access === 'ro' || access === 'rwr' || access === 'const' ? 'to_master' : 'from_master'

const hex = (n: number, digits: number): string => `0x${n.toString(16).toUpperCase().padStart(digits, '0')}`

/** The file's value of an object: the DCF or XDC value when there is one, else the default. */
function fileText(file: SlaveImportFile, index: number, subIndex: number): string | undefined {
  const dcf = file.dcf.values.find((v) => v.index === index && v.subIndex === subIndex)
  return dcf?.value ?? findObject(file.eds, index, subIndex)?.defaultValue
}

function fileInt(file: SlaveImportFile, index: number, subIndex: number, nodeId: number): number | null {
  const text = fileText(file, index, subIndex)
  return text === undefined ? null : parseEdsInteger(text, nodeId)
}

/** A numeric value as the slave writes it, or null when it cannot hold it. */
function slaveNumberText(text: string, dataType: CanopenSlaveDataType, nodeId: number): string | null {
  const t = text.trim()
  if (parseSlaveValue(t, dataType) !== null) return t
  const n = parseEdsInteger(t, nodeId)
  if (n !== null && parseSlaveValue(String(n), dataType) !== null) return String(n)
  return null
}

const filled = (text: string | undefined): text is string => text !== undefined && text.trim() !== ''

function packedBits(info: CanopenObject['info']): CanopenSlaveObject['bits'] {
  const bits = info?.bits ?? []
  if (bits.length === 0) return undefined
  return Array.from({ length: SLAVE_PACKED_BITS }, (_, i) => {
    const label = bits.find((b) => Number(b.value) === i)?.label
    return { name: filled(label) ? label.trim() : `Bit ${i}`, iecLocation: '' }
  })
}

/** The object as a slave object, or a line saying why the slave cannot hold it. */
function readObject(
  o: CanopenObject,
  file: SlaveImportFile,
  nodeId: number,
  newId: () => string,
): { object: CanopenSlaveObject; lines: SlaveImportLine[] } | { line: SlaveImportLine } {
  const ref = objectRef(o.index, o.subIndex)
  const what = `${ref} ${o.name}`
  const dataType = slaveTypeOf(o.dataType)
  if (!dataType) {
    const hint = o.dataType === 'BOOLEAN' ? '; an UNSIGNED8 of 8 bits holds BOOLs' : ''
    return { line: { group: 'type', what, detail: `${typeLabel(o.dataType)}${hint}` } }
  }
  const lines: SlaveImportLine[] = []
  const text = fileText(file, o.index, o.subIndex) ?? ''
  const name = filled(o.name) ? o.name.trim() : `Object ${ref}`
  if (dataType === 'VISIBLE_STRING') {
    if (o.access !== 'ro' && o.access !== 'const')
      return {
        line: {
          group: 'type',
          what,
          detail: 'VISIBLE_STRING the master writes; the slave holds text only as a constant',
        },
      }
    if (text.length > SLAVE_MAX_STRING)
      return { line: { group: 'type', what, detail: `text of ${text.length} characters; at most ${SLAVE_MAX_STRING}` } }
    const object: CanopenSlaveObject = {
      id: newId(),
      index: o.index,
      subIndex: o.subIndex,
      name,
      dataType,
      direction: 'to_master',
      exchange: 'constant',
      iecLocation: '',
      defaultValue: text,
    }
    return { object: withDetails(object, o.info), lines }
  }
  const direction = directionOf(o.access)
  const exchange = o.access === 'const' ? 'constant' : o.pdoMapping ? 'pdo' : 'sdo'
  let defaultValue = slaveNumberText(text, dataType, nodeId)
  if (defaultValue === null) {
    if (text.trim() !== '') lines.push({ group: 'setting', what, detail: `default "${text}" does not fit; 0 used` })
    defaultValue = '0'
  }
  const object: CanopenSlaveObject = {
    id: newId(),
    index: o.index,
    subIndex: o.subIndex,
    name,
    dataType,
    direction,
    exchange,
    iecLocation: '',
    defaultValue,
  }
  const bits = dataType === 'UNSIGNED8' && exchange !== 'constant' ? packedBits(o.info) : undefined
  if (bits) return { object: withDetails({ ...object, bits }, o.info), lines }
  if (direction === 'from_master' && exchange !== 'constant') {
    const limit = (raw: string | undefined, label: string): string | undefined => {
      if (!filled(raw)) return undefined
      const v = slaveNumberText(raw, dataType, nodeId)
      if (v === null) lines.push({ group: 'setting', what, detail: `${label} "${raw}" does not fit; left out` })
      return v ?? undefined
    }
    const full = slaveTypeLimits(dataType)
    const min = limit(o.lowLimit, 'low limit')
    const max = limit(o.highLimit, 'high limit')
    // A limit at the end of the type's range limits nothing, as the export writes for value meanings.
    if (min !== undefined && !(full && parseSlaveValue(min, dataType) === parseSlaveValue(full[0], dataType)))
      object.min = min
    if (max !== undefined && !(full && parseSlaveValue(max, dataType) === parseSlaveValue(full[1], dataType)))
      object.max = max
  }
  return { object: withDetails(object, o.info), lines }
}

const WHOLE_TYPES: ReadonlySet<CanopenSlaveDataType> = new Set([
  'INTEGER8',
  'INTEGER16',
  'INTEGER32',
  'INTEGER64',
  'UNSIGNED8',
  'UNSIGNED16',
  'UNSIGNED32',
  'UNSIGNED64',
])

/** The object with the XDD details that fit its kind (as the Data tab offers them). */
function withDetails(object: CanopenSlaveObject, info: CanopenObject['info']): CanopenSlaveObject {
  if (!info) return object
  const out: CanopenSlaveObject = { ...object }
  if (filled(info.description)) out.description = info.description.trim()
  if (filled(info.group)) out.group = info.group.trim()
  const numeric = object.dataType !== 'VISIBLE_STRING' && !object.bits
  if (numeric) {
    if (filled(info.unit)) out.unit = info.unit.trim()
    if (info.multiplier !== undefined && info.multiplier !== 1) out.multiplier = info.multiplier
    if (info.offset !== undefined && info.offset !== 0) out.offset = info.offset
  }
  if (numeric && WHOLE_TYPES.has(object.dataType) && info.values && info.values.length > 0)
    out.values = info.values.map((v: CanopenValueMeaning) => ({ value: v.value, label: v.label }))
  return out
}

/** Application objects of the file the slave can hold, and lines for those it cannot. */
function readObjects(
  file: SlaveImportFile,
  nodeId: number,
  newId: () => string,
): { objects: CanopenSlaveObject[]; lines: SlaveImportLine[] } {
  const objects: CanopenSlaveObject[] = []
  const lines: SlaveImportLine[] = []
  const subs = new Map<number, number>()
  for (const o of file.eds.objects) subs.set(o.index, (subs.get(o.index) ?? 0) + 1)
  for (const o of [...file.eds.objects].sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)) {
    if (o.index >= 0x1000 && o.index < SLAVE_FIRST_INDEX) continue
    const single = (subs.get(o.index) ?? 0) === 1
    if (o.subIndex === 0 && !single) continue
    const what = `${objectRef(o.index, o.subIndex)} ${o.name}`
    if (o.index < SLAVE_FIRST_INDEX || o.index > SLAVE_LAST_INDEX) {
      lines.push({
        group: 'outside',
        what,
        detail: o.index > SLAVE_LAST_INDEX && o.index < 0xa000 ? 'device profile object' : 'outside the slave’s area',
      })
      continue
    }
    if (o.subIndex === 0 || o.subIndex === 0xff) {
      lines.push({
        group: 'outside',
        what,
        detail:
          o.subIndex === 0
            ? 'a single value at sub-index 00; the slave’s objects use sub-indexes 01 - FE'
            : 'sub-index FF; the slave’s objects use sub-indexes 01 - FE',
      })
      continue
    }
    const read = readObject(o, file, nodeId, newId)
    if ('line' in read) lines.push(read.line)
    else {
      objects.push(read.object)
      lines.push(...read.lines)
    }
  }
  return { objects, lines }
}

const commIndex = (direction: CanopenSlaveDirection, n: number): number =>
  (direction === 'from_master' ? 0x1400 : 0x1800) + n - 1
const mapIndex = (direction: CanopenSlaveDirection, n: number): number =>
  (direction === 'from_master' ? 0x1600 : 0x1a00) + n - 1

/** The file's default PDO layout for the imported objects; PDO objects in no PDO are left to the master. */
function readPdos(
  file: SlaveImportFile,
  objects: CanopenSlaveObject[],
  nodeId: number,
  lines: SlaveImportLine[],
): { objects: CanopenSlaveObject[]; pdos: { rpdos: CanopenSlavePdo[]; tpdos: CanopenSlavePdo[] } } {
  const byRef = new Map(objects.map((o) => [objectRef(o.index, o.subIndex), o]))
  const placed = new Set<string>()
  const pdos = { rpdos: [] as CanopenSlavePdo[], tpdos: [] as CanopenSlavePdo[] }
  for (const direction of ['from_master', 'to_master'] as const) {
    const tpdo = direction === 'to_master'
    for (let n = 1; n <= 512; n++) {
      const count = fileInt(file, mapIndex(direction, n), 0, nodeId) ?? 0
      if (count <= 0) continue
      const name = slavePdoName(direction, n)
      if (n > SLAVE_PDO_COUNT) {
        lines.push({ group: 'pdo', what: name, detail: `the slave has ${SLAVE_PDO_COUNT} ${tpdo ? 'TPDOs' : 'RPDOs'}` })
        continue
      }
      const ids: string[] = []
      let bytes = 0
      for (let k = 1; k <= count; k++) {
        const value = fileInt(file, mapIndex(direction, n), k, nodeId)
        if (value === null || value === 0) continue
        const index = Math.floor(value / 0x10000)
        const subIndex = Math.floor(value / 0x100) % 0x100
        const ref = objectRef(index, subIndex)
        const o = byRef.get(ref)
        if (!o || o.exchange !== 'pdo' || o.direction !== direction) {
          const why = index >= 1 && index <= 7 ? 'a dummy entry' : 'its object is not imported'
          lines.push({ group: 'pdo', what: `${name} entry ${k}`, detail: `${ref}: ${why}` })
          continue
        }
        if (placed.has(o.id)) continue
        if (bytes + slaveObjectBytes(o) > SLAVE_PDO_BYTES) {
          lines.push({ group: 'pdo', what: `${name} entry ${k}`, detail: `${ref}: the mapping is over 8 bytes` })
          continue
        }
        bytes += slaveObjectBytes(o)
        ids.push(o.id)
        placed.add(o.id)
      }
      if (ids.length === 0) continue
      const raw = fileInt(file, commIndex(direction, n), 1, nodeId)
      let cobId: number | null = null
      if (n <= SLAVE_PREDEFINED_PDOS) {
        const own = slavePdoCobId(direction, n, nodeId)
        const id = raw === null ? own : raw % 0x800
        if (raw !== null && raw < 0x80000000 && id !== own)
          lines.push({ group: 'pdo', what: name, detail: `COB-ID ${hex(id, 3)} not taken; PDO 1-4 use ${hex(own, 3)}` })
      } else if (raw !== null && raw < 0x80000000 && raw % 0x800 !== 0) {
        const id = raw % 0x800
        if (reservedCobId(id))
          lines.push({ group: 'pdo', what: name, detail: `COB-ID ${hex(id, 3)} is reserved; the master gives it` })
        else cobId = id
      }
      const type = fileInt(file, commIndex(direction, n), 2, nodeId) ?? 255
      const usable = type <= 240 || type === 254 || type === 255
      if (tpdo && !usable)
        lines.push({ group: 'pdo', what: name, detail: `transmission type ${type} not supported; 255 used` })
      pdos[tpdo ? 'tpdos' : 'rpdos'].push({
        number: n,
        objects: ids,
        cobId,
        transmissionType: tpdo && usable ? type : 255,
        inhibitTime: tpdo ? (fileInt(file, commIndex(direction, n), 3, nodeId) ?? 0) : 0,
        eventTimerMs: fileInt(file, commIndex(direction, n), 5, nodeId) ?? 0,
      })
    }
  }
  const withMaster = objects.map((o) =>
    o.exchange === 'pdo' && !placed.has(o.id) && o.dataType !== 'VISIBLE_STRING' ? { ...o, mappedByMaster: true } : o,
  )
  return { objects: withMaster, pdos }
}

const MASTER_LOST: Readonly<Record<number, CanopenSlaveOnMasterLost>> = {
  0: 'pre_operational',
  1: 'no_change',
  2: 'stopped',
}
const PLC_STOP_STATE: Readonly<Record<number, CanopenSlaveOnPlcStopState>> = {
  0: 'pre_operational',
  1: 'none',
  2: 'stopped',
}

/** Identity and communication settings of the file on top of the current slave (design D2). */
function readSettings(
  current: CanopenSlaveConfig,
  file: SlaveImportFile,
  lines: SlaveImportLine[],
): CanopenSlaveConfig {
  const { eds } = file
  const c = file.dcf.commissioning
  const setting = (what: string, detail: string): void => {
    lines.push({ group: 'setting', what, detail })
  }
  let nodeId = current.nodeId
  if (c?.nodeId !== undefined) {
    if (c.nodeId >= 1 && c.nodeId <= 127) nodeId = c.nodeId
    else setting('Node ID', `${c.nodeId} is not 1 - 127; ${current.nodeId} kept`)
  }
  let bitrate = current.bitrate
  if (c?.baudrateKbit !== undefined) {
    const bps = c.baudrateKbit * 1000
    if (CANOPEN_BITRATES.some((b) => b === bps)) bitrate = bps
    else setting('Bit rate', `${c.baudrateKbit} kbit/s is not a CANopen bit rate; kept`)
  }
  const text = (index: number, label: string, fallback: string): string => {
    const value = fileText(file, index, 0) ?? fallback
    if (value.length <= SLAVE_MAX_STRING) return value
    setting(label, `longer than ${SLAVE_MAX_STRING} characters; left empty`)
    return ''
  }
  const int = (index: number, sub: number): number | null => fileInt(file, index, sub, nodeId)
  const identity = (sub: number, fallback: number): number => {
    const v = int(0x1018, sub)
    return v !== null && v >= 0 && v <= 0xffffffff ? v : fallback
  }
  let heartbeatMs = current.heartbeatMs
  const hb = int(0x1017, 0)
  if (hb !== null) {
    if (hb >= 1 && hb <= 65535) heartbeatMs = hb
    else setting('Heartbeat', `0x1017 is ${hb}; the slave always sends one, ${current.heartbeatMs} ms kept`)
  }
  let masterWatch = { nodeId: current.masterWatch.nodeId, timeMs: 0 }
  const watch = int(0x1016, 1)
  if (watch !== null && watch % 0x10000 !== 0) {
    const id = Math.floor(watch / 0x10000) % 0x100
    if (id >= 1 && id <= 127) masterWatch = { nodeId: id, timeMs: watch % 0x10000 }
    else setting('Master watch', `0x1016:01 watches node ${id}; left off`)
  }
  for (let sub = 2; sub <= 127; sub++) {
    const v = int(0x1016, sub)
    if (v !== null && v % 0x10000 !== 0)
      setting(`Heartbeat consumer ${sub}`, `node ${Math.floor(v / 0x10000) % 0x100}; the slave watches one node`)
  }
  const behaviour = <T>(sub: number, table: Readonly<Record<number, T>>, label: string, kept: T): T => {
    const v = int(0x1029, sub)
    if (v === null) return kept
    const picked = table[v]
    if (picked === undefined) setting(label, `0x1029:0${sub} value ${v} has no choice here; kept`)
    return picked ?? kept
  }
  const serial = int(0x1018, 4)
  const details = eds.details ?? {}
  const deviceName = text(0x1008, 'Device name', eds.productName)
  const order = details.orderNumber?.trim()
  const vendorName = eds.vendorName.length <= SLAVE_MAX_STRING ? eds.vendorName : ''
  const {
    lastExport: _export,
    productText: _product,
    orderNumber: _order,
    characteristics: _characteristics,
    tpdos: _tpdos,
    lss: _lss,
    ...kept
  } = current
  return {
    ...kept,
    nodeId,
    bitrate,
    vendorName,
    deviceName,
    hardwareVersion: text(0x1009, 'Hardware version', ''),
    softwareVersion: text(0x100a, 'Software version', ''),
    vendorId: identity(1, eds.vendorId),
    productCode: identity(2, eds.productCode),
    revision: identity(3, eds.revision),
    heartbeatMs,
    masterWatch,
    onMasterLost: behaviour(1, MASTER_LOST, 'On master lost', current.onMasterLost),
    onPlcStopState: behaviour(2, PLC_STOP_STATE, 'PLC stopped state', current.onPlcStopState),
    lss: eds.lssSupported
      ? { ...SLAVE_LSS_OFF, enabled: true, serial: serial !== null && serial > 0 ? serial : null }
      : { ...SLAVE_LSS_OFF },
    ...(filled(details.productText) ? { productText: details.productText.trim() } : {}),
    ...(filled(order) && order !== deviceName ? { orderNumber: order } : {}),
    ...(details.characteristics && details.characteristics.length > 0
      ? { characteristics: details.characteristics.map((ch) => ({ value: ch.value, label: ch.label })) }
      : {}),
  }
}

/** "12 objects, 2 RPDOs and 1 TPDO in the default layout". */
export function slaveImportSummary(config: CanopenSlaveConfig): string {
  const layout = slavePdoLayout(config)
  const used = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`
  const objects = config.objects.length
  return `${used(objects, 'object')}, ${used(layout.rpdos.filter((p) => p.objects.length > 0).length, 'RPDO')} and ${used(layout.tpdos.filter((p) => p.objects.length > 0).length, 'TPDO')} in the default layout`
}

/**
 * The slave after importing the file: with `replace` the identity, settings, objects and PDO layout
 * come from the file; with `add` the picked objects join the current slave, which keeps the rest.
 */
export function importIntoSlave(
  current: CanopenSlaveConfig,
  file: SlaveImportFile,
  mode: SlaveImportMode,
  options: SlaveImportOptions,
): SlaveImportResult {
  const lines: SlaveImportLine[] = []
  if (mode === 'replace') {
    const settings = readSettings(current, file, lines)
    const read = readObjects(file, settings.nodeId, options.newId)
    lines.push(...read.lines)
    const { objects, pdos } = readPdos(file, read.objects, settings.nodeId, lines)
    const config = withSlavePdoLayout({ ...settings, objects, pdos })
    const candidates = objects.map((object) => ({
      ref: objectRef(object.index, object.subIndex),
      object,
      blocked: null,
    }))
    return { config, candidates, notImported: sortLines(lines), summary: slaveImportSummary(config) }
  }
  const read = readObjects(file, current.nodeId, options.newId)
  lines.push(...read.lines)
  const used = new Map(current.objects.map((o) => [objectRef(o.index, o.subIndex), o.name]))
  const candidates = read.objects.map((object) => {
    const ref = objectRef(object.index, object.subIndex)
    const owner = used.get(ref)
    return { ref, object, blocked: owner !== undefined ? `used by "${owner}"` : null }
  })
  const added = candidates
    .filter((c) => c.blocked === null && (options.picked?.has(c.ref) ?? true))
    .map((c) => c.object)
  const merged = withSlavePdoLayout({ ...current, objects: [...current.objects, ...added] })
  const overflow = new Set(slavePdoLayout(merged).overflow.map((o) => o.id))
  const config =
    overflow.size === 0
      ? merged
      : withSlavePdoLayout({
          ...merged,
          objects: merged.objects.map((o) => (overflow.has(o.id) ? { ...o, mappedByMaster: true } : o)),
        })
  const summary = `Adds ${added.length} object${added.length === 1 ? '' : 's'}; then ${slaveImportSummary(config)}`
  return { config, candidates, notImported: sortLines(lines), summary }
}

function sortLines(lines: SlaveImportLine[]): SlaveImportLine[] {
  const order = (g: SlaveImportGroup): number => SLAVE_IMPORT_GROUPS.findIndex((x) => x.group === g)
  return [...lines].sort((a, b) => order(a.group) - order(b.group))
}
