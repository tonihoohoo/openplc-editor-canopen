/**
 * DBC export: the configured CANopen network as CAN frames and signals for CAN analysers. Holds the
 * PDOs as the master configures them, NMT, SYNC, TIME, heartbeats, EMCY and SDO frames multiplexed
 * by their command byte so that every SDO frame decodes. Export only: a DBC is never read back.
 */

import type {
  CanopenConfig,
  CanopenDataType,
  CanopenDbcExportOptions,
  CanopenNode,
  CanopenObject,
  CanopenPdo,
} from '../../ports/canopen-types'
import { canopenTypeBits, toCanopenDataType } from './data-types'
import type { DcfExportProblem, DeviceFileExport } from './dcf-export'
import { findObject } from './eds-parser'
import { nodeConfigurationSdos, pdoConfigured, pdoExchanged, rpdoSendPeriodMs } from './generate-canopen-config'
import { effectiveEmcy, effectiveEventTimerMs, effectiveProducerMs, isDummyEntry } from './model'

export type DbcFrameType = 'pdo' | 'nmt' | 'sync' | 'time' | 'heartbeat' | 'emcy' | 'sdo'

export const DBC_FRAME_TYPES: ReadonlyArray<{ type: DbcFrameType; label: string }> = [
  { type: 'pdo', label: 'PDOs' },
  { type: 'nmt', label: 'NMT' },
  { type: 'sync', label: 'SYNC' },
  { type: 'time', label: 'TIME' },
  { type: 'heartbeat', label: 'Heartbeat' },
  { type: 'emcy', label: 'EMCY' },
  { type: 'sdo', label: 'SDO' },
]

const FRAME_LOSS: Record<DbcFrameType, string> = {
  pdo: 'PDO frames',
  nmt: 'NMT frames',
  sync: 'SYNC frames',
  time: 'TIME frames',
  heartbeat: 'heartbeat and node guarding frames',
  emcy: 'EMCY frames',
  sdo: 'SDO frames',
}

const MASTER = 'PLC'
/** DBC's name for "no node". */
const NO_NODE = 'Vector__XXX'
const NAME_MAX = 32

export function defaultDbcExportOptions(): CanopenDbcExportOptions {
  return { pdo: true, nmt: true, sync: true, time: true, heartbeat: true, emcy: true, sdo: true, sdoValues: 'all' }
}

/** The network's DBC options, or the defaults when the project has none. */
export function dbcExportOptions(config: CanopenConfig): CanopenDbcExportOptions {
  return { ...defaultDbcExportOptions(), ...config.export?.dbc }
}

/** The config with new DBC options. */
export function withDbcExportOptions(config: CanopenConfig, options: CanopenDbcExportOptions): CanopenConfig {
  return { ...config, export: { ...config.export, dbc: options } }
}

/** Why a frame type has nothing to export in this network, or null when it has. */
export function dbcFrameUnavailable(config: CanopenConfig, type: DbcFrameType): string | null {
  if (type === 'sync' && config.network.syncMode === 'none') return 'SYNC is off in this network'
  if (type === 'time' && !config.network.time.enabled) return 'TIME is off in this network'
  return null
}

/** The frame types left out of the DBC by the options, as lines for the export dialog. */
export function dbcOptionLosses(config: CanopenConfig): string[] {
  const options = dbcExportOptions(config)
  return DBC_FRAME_TYPES.filter((f) => !options[f.type] && dbcFrameUnavailable(config, f.type) === null).map(
    (f) => `left out above: ${FRAME_LOSS[f.type]}`,
  )
}

export function dbcNodeFileName(nodeId: number): string {
  return `node_${nodeId}.dbc`
}

export function dbcNetworkFileName(networkName: string): string {
  const safe = networkName.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return `${safe === '' ? 'canopen' : safe}.dbc`
}

// ---- Model ----

type Range = [number, number]

interface DbcSignal {
  name: string
  longName?: string
  start: number
  length: number
  signed: boolean
  /** 0 integer, 1 REAL32, 2 REAL64. */
  valueType: 0 | 1 | 2
  factor: number
  offset: number
  min: string
  max: string
  unit: string
  receivers: string[]
  comment?: string
  iecLocation?: string
  values?: Array<[string, string]>
  /** This signal is a multiplexer. */
  muxer?: boolean
  /** Multiplexed: the multiplexer and the values it selects this signal for. */
  muxedBy?: { muxer: string; ranges: Range[] }
}

interface DbcMessage {
  id: number
  name: string
  longName?: string
  dlc: number
  transmitter: string
  comment?: string
  cycleMs?: number
  delayMs?: number
  signals: DbcSignal[]
}

interface DbcNode {
  name: string
  longName?: string
  nodeId?: number
  comment: string
}

/** A DBC identifier; `taken` keeps names unique, cut to 32 characters with a hash when longer. */
class Names {
  private readonly taken = new Set<string>()

  name(raw: string): { name: string; longName?: string } {
    let base = raw.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
    if (base === '') base = 'S'
    if (!/^[A-Za-z_]/.test(base)) base = `S_${base}`
    let full = base
    for (let n = 2; this.taken.has(full.toLowerCase()); n++) full = `${base}_${n}`
    if (full.length <= NAME_MAX) {
      this.taken.add(full.toLowerCase())
      return { name: full }
    }
    let short = `${full.slice(0, NAME_MAX - 5)}_${hash4(full)}`
    for (let n = 2; this.taken.has(short.toLowerCase()); n++)
      short = `${full.slice(0, NAME_MAX - 7)}_${hash4(full + n)}`
    this.taken.add(short.toLowerCase())
    return { name: short, longName: full }
  }
}

function hash4(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return (h & 0xffff).toString(16).toUpperCase().padStart(4, '0')
}

/** Shortest decimal text of a number. */
export function dbcNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(15)))
}

function rawRange(length: number, signed: boolean): [bigint, bigint] {
  if (signed) return [-(1n << BigInt(length - 1)), (1n << BigInt(length - 1)) - 1n]
  return [0n, (1n << BigInt(length)) - 1n]
}

function physical(raw: bigint, factor: number, offset: number): string {
  if (factor === 1 && offset === 0) return raw.toString()
  return dbcNumber(Number(raw) * factor + offset)
}

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')

function objectLabel(object: CanopenObject | undefined, index: number, subIndex: number): string {
  return object?.info?.label ?? object?.name ?? `0x${hex4(index)}:${subIndex}`
}

interface SignalSpec {
  name: string
  start: number
  length: number
  type: CanopenDataType
  receivers: string[]
  object?: CanopenObject
  comment?: string
}

function rangeOf(type: CanopenDataType) {
  const signed = type.startsWith('INTEGER')
  const valueType: 0 | 1 | 2 = type === 'REAL32' ? 1 : type === 'REAL64' ? 2 : 0
  return { signed, valueType }
}

// ---- Builder ----

const NMT_STATES: Array<[string, string]> = [
  ['0', 'Boot-up'],
  ['4', 'Stopped'],
  ['5', 'Operational'],
  ['127', 'Pre-operational'],
]

const NMT_COMMANDS: Array<[string, string]> = [
  ['1', 'Start'],
  ['2', 'Stop'],
  ['128', 'Enter pre-operational'],
  ['129', 'Reset node'],
  ['130', 'Reset communication'],
]

const EMCY_CODES: Array<[number, string]> = [
  [0x0000, 'Error reset or no error'],
  [0x1000, 'Generic error'],
  [0x2000, 'Current'],
  [0x2100, 'Current, device input side'],
  [0x2200, 'Current inside the device'],
  [0x2300, 'Current, device output side'],
  [0x3000, 'Voltage'],
  [0x3100, 'Mains voltage'],
  [0x3200, 'Voltage inside the device'],
  [0x3300, 'Output voltage'],
  [0x4000, 'Temperature'],
  [0x4100, 'Ambient temperature'],
  [0x4200, 'Device temperature'],
  [0x5000, 'Device hardware'],
  [0x6000, 'Device software'],
  [0x6100, 'Internal software'],
  [0x6200, 'User software'],
  [0x6300, 'Data set'],
  [0x7000, 'Additional modules'],
  [0x8000, 'Monitoring'],
  [0x8100, 'Communication'],
  [0x8110, 'CAN overrun (objects lost)'],
  [0x8120, 'CAN in error passive mode'],
  [0x8130, 'Life guard or heartbeat error'],
  [0x8140, 'Recovered from bus off'],
  [0x8150, 'CAN-ID collision'],
  [0x8200, 'Protocol error'],
  [0x8210, 'PDO not processed due to length error'],
  [0x8220, 'PDO length exceeded'],
  [0x8230, 'DAM MPDO not processed, destination object not available'],
  [0x8240, 'Unexpected SYNC data length'],
  [0x8250, 'RPDO timeout'],
  [0x9000, 'External error'],
  [0xf000, 'Additional functions'],
  [0xff00, 'Device specific'],
]

const ERROR_REGISTER_BITS = [
  'Generic error',
  'Current',
  'Voltage',
  'Temperature',
  'Communication error',
  'Device profile specific',
  'Reserved',
  'Manufacturer specific',
]

export const SDO_ABORT_CODES: Array<[number, string]> = [
  [0x05030000, 'Toggle bit not alternated'],
  [0x05040000, 'SDO protocol timed out'],
  [0x05040001, 'Command specifier not valid or unknown'],
  [0x05040002, 'Invalid block size'],
  [0x05040003, 'Invalid sequence number'],
  [0x05040004, 'CRC error'],
  [0x05040005, 'Out of memory'],
  [0x06010000, 'Unsupported access to an object'],
  [0x06010001, 'Attempt to read a write only object'],
  [0x06010002, 'Attempt to write a read only object'],
  [0x06020000, 'Object does not exist in the object dictionary'],
  [0x06040041, 'Object cannot be mapped to the PDO'],
  [0x06040042, 'Number and length of objects to be mapped would exceed PDO length'],
  [0x06040043, 'General parameter incompatibility'],
  [0x06040047, 'General internal incompatibility in the device'],
  [0x06060000, 'Access failed due to a hardware error'],
  [0x06070010, 'Data type does not match, length of service parameter does not match'],
  [0x06070012, 'Data type does not match, length of service parameter too high'],
  [0x06070013, 'Data type does not match, length of service parameter too low'],
  [0x06090011, 'Sub-index does not exist'],
  [0x06090030, 'Invalid value for parameter'],
  [0x06090031, 'Value of parameter written too high'],
  [0x06090032, 'Value of parameter written too low'],
  [0x06090036, 'Maximum value is less than minimum value'],
  [0x060a0023, 'Resource not available: SDO connection'],
  [0x08000000, 'General error'],
  [0x08000020, 'Data cannot be transferred or stored to the application'],
  [0x08000021, 'Data cannot be transferred or stored because of local control'],
  [0x08000022, 'Data cannot be transferred or stored because of the present device state'],
  [0x08000023, 'Object dictionary not present or dynamic generation failed'],
  [0x08000024, 'No data available'],
]

type SdoBranch = { suffix: string; start: number; length: number; ranges: Range[]; meaning: string; role: Role }
type Role = 'value' | 'object' | 'size' | 'abort' | 'raw'

const r = (a: number, b: number): Range => [a, b]
/** Command byte values of one command specifier with the expedited bit (bit 1) set or clear. */
function withBit1(base: number, set: boolean): Range[] {
  const out: Range[] = []
  for (let v = base; v < base + 32; v += 4) out.push(set ? r(v + 2, v + 3) : r(v, v + 1))
  return out
}

/** Client to server (0x600 + node ID): every command byte value has one meaning. */
const SDO_TO_NODE: SdoBranch[] = [
  { suffix: 'SegData', start: 8, length: 56, ranges: [r(0, 31)], meaning: 'download segment', role: 'raw' },
  {
    suffix: 'SegObject',
    start: 8,
    length: 24,
    ranges: withBit1(32, false),
    meaning: 'initiate segmented download',
    role: 'object',
  },
  { suffix: 'SegSize', start: 32, length: 32, ranges: withBit1(32, false), meaning: 'bytes to download', role: 'size' },
  { suffix: 'IndexHi', start: 16, length: 8, ranges: withBit1(32, true), meaning: 'expedited download', role: 'value' },
  {
    suffix: 'ReadObject',
    start: 8,
    length: 24,
    ranges: [r(64, 95)],
    meaning: 'initiate upload request',
    role: 'object',
  },
  { suffix: 'SegRequest', start: 8, length: 56, ranges: [r(96, 127)], meaning: 'upload segment request', role: 'raw' },
  { suffix: 'AbortObject', start: 8, length: 24, ranges: [r(128, 159)], meaning: 'abort', role: 'object' },
  { suffix: 'AbortCode', start: 32, length: 32, ranges: [r(128, 159)], meaning: 'abort', role: 'abort' },
  { suffix: 'Block', start: 8, length: 56, ranges: [r(160, 255)], meaning: 'block transfer, not decoded', role: 'raw' },
]

/** Server to client (0x580 + node ID). */
const SDO_FROM_NODE: SdoBranch[] = [
  { suffix: 'SegData', start: 8, length: 56, ranges: [r(0, 31)], meaning: 'upload segment', role: 'raw' },
  {
    suffix: 'SegConfirm',
    start: 8,
    length: 56,
    ranges: [r(32, 63)],
    meaning: 'download segment response',
    role: 'raw',
  },
  {
    suffix: 'SegObject',
    start: 8,
    length: 24,
    ranges: withBit1(64, false),
    meaning: 'initiate segmented upload response',
    role: 'object',
  },
  { suffix: 'SegSize', start: 32, length: 32, ranges: withBit1(64, false), meaning: 'bytes to upload', role: 'size' },
  {
    suffix: 'IndexHi',
    start: 16,
    length: 8,
    ranges: withBit1(64, true),
    meaning: 'expedited upload response',
    role: 'value',
  },
  {
    suffix: 'WriteConfirmed',
    start: 8,
    length: 24,
    ranges: [r(96, 127)],
    meaning: 'initiate download response',
    role: 'object',
  },
  { suffix: 'AbortObject', start: 8, length: 24, ranges: [r(128, 159)], meaning: 'abort', role: 'object' },
  { suffix: 'AbortCode', start: 32, length: 32, ranges: [r(128, 159)], meaning: 'abort', role: 'abort' },
  { suffix: 'Block', start: 8, length: 56, ranges: [r(160, 255)], meaning: 'block transfer, not decoded', role: 'raw' },
]

/** The values in [0, max] not in `keys`, as ranges. */
function complement(keys: Iterable<number>, max: number): Range[] {
  const out: Range[] = []
  let from = 0
  for (const k of [...new Set(keys)].sort((a, b) => a - b)) {
    if (k > from) out.push([from, k - 1])
    from = k + 1
  }
  if (from <= max) out.push([from, max])
  return out
}

interface SdoObject {
  index: number
  subIndex: number
  type: CanopenDataType
  object: CanopenObject | undefined
}

/** Objects the SDO frames name: every described object, or the ones the project writes, reads or maps. */
function sdoObjectKeys(node: CanopenNode, config: CanopenConfig, which: 'all' | 'configured'): [number, number][] {
  const out = new Map<number, [number, number]>()
  const add = (index: number, subIndex: number) => out.set(index + subIndex * 0x10000, [index, subIndex])
  if (which === 'all') for (const o of node.eds.objects) add(o.index, o.subIndex)
  else {
    for (const s of node.sdos) add(s.index, s.subIndex)
    for (const w of nodeConfigurationSdos(node, config.network)) add(w.index, w.subindex)
    for (const p of [...node.tpdos, ...node.rpdos])
      for (const e of p.entries) if (!isDummyEntry(e)) add(e.index, e.subIndex)
  }
  return [...out.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

/** Objects whose SDO values the DBC decodes: typed objects of 32 bits or less. */
function sdoObjects(keys: [number, number][], node: CanopenNode): SdoObject[] {
  const out: SdoObject[] = []
  for (const [index, subIndex] of keys) {
    const object = findObject(node.eds, index, subIndex)
    const type = object ? toCanopenDataType(object.dataType) : undefined
    if (type && canopenTypeBits(type) <= 32) out.push({ index, subIndex, type, object })
  }
  return out
}

class DbcBuilder {
  readonly names = new Names()
  readonly messages: DbcMessage[] = []
  readonly nodes: DbcNode[] = []
  private readonly nodeNames = new Map<string, string>()

  constructor(
    private readonly config: CanopenConfig,
    private readonly exported: readonly CanopenNode[],
    private readonly options: CanopenDbcExportOptions,
  ) {
    const master = this.names.name(MASTER)
    this.nodes.push({ name: master.name, comment: `CANopen master, node ${config.network.masterNodeId}` })
    for (const node of exported) {
      const n = this.names.name(node.name)
      this.nodeNames.set(node.id, n.name)
      this.nodes.push({ ...n, nodeId: node.nodeId, comment: `CANopen node ${node.nodeId}` })
    }
  }

  private nodeName(node: CanopenNode): string {
    return this.nodeNames.get(node.id) ?? NO_NODE
  }

  private get slaves(): string[] {
    return this.exported.map((n) => this.nodeName(n))
  }

  private message(id: number, raw: string, dlc: number, transmitter: string, extra: Partial<DbcMessage> = {}) {
    const n = this.names.name(raw)
    const m: DbcMessage = { id, name: n.name, longName: n.longName, dlc, transmitter, signals: [], ...extra }
    this.messages.push(m)
    return m
  }

  private signal(
    m: DbcMessage,
    raw: string,
    start: number,
    length: number,
    receivers: string[],
    extra: Partial<DbcSignal> & { type?: CanopenDataType } = {},
  ): DbcSignal {
    const n = this.names.name(raw)
    const { type, ...rest } = extra
    const kind = type ? rangeOf(type) : { signed: false, valueType: 0 as const }
    const [lo, hi] = rawRange(length, kind.signed)
    const s: DbcSignal = {
      name: n.name,
      longName: n.longName,
      start,
      length,
      signed: kind.signed,
      valueType: kind.valueType,
      factor: 1,
      offset: 0,
      min: kind.valueType ? '0' : lo.toString(),
      max: kind.valueType ? '0' : hi.toString(),
      unit: '',
      receivers: receivers.length > 0 ? receivers : [NO_NODE],
      ...rest,
    }
    m.signals.push(s)
    return s
  }

  /** A typed signal for an object, scaled and named from its XDD/XDC details when it has them. */
  private objectSignal(m: DbcMessage, spec: SignalSpec, extra: Partial<DbcSignal> = {}): DbcSignal[] {
    const info = spec.object?.info
    const bits = spec.type === 'REAL32' || spec.type === 'REAL64' ? undefined : info?.bits
    if (bits && bits.length > 0 && !extra.muxedBy) {
      return bits.map((b) => {
        const bit = Number(b.value)
        const width = b.width ?? 1
        return this.signal(m, `${spec.name}_${b.label}`, spec.start + bit, width, spec.receivers, {
          comment: [spec.comment, `bit ${bit}${width > 1 ? `-${bit + width - 1}` : ''} ${b.label}`]
            .filter(Boolean)
            .join(', '),
          ...extra,
        })
      })
    }
    const factor = info?.multiplier ?? 1
    const offset = (info?.offset ?? 0) * factor
    const kind = rangeOf(spec.type)
    const [rawLo, rawHi] = rawRange(spec.length, kind.signed)
    const min =
      info?.min !== undefined && !Number.isNaN(Number(info.min)) ? BigInt(Math.round(Number(info.min))) : rawLo
    const max =
      info?.max !== undefined && !Number.isNaN(Number(info.max)) ? BigInt(Math.round(Number(info.max))) : rawHi
    const values = info?.values
      ?.filter((v) => v.value.trim() !== '' && !Number.isNaN(Number(v.value)))
      .map((v): [string, string] => [BigInt(Number(v.value)).toString(), v.label])
    return [
      this.signal(m, spec.name, spec.start, spec.length, spec.receivers, {
        type: spec.type,
        factor,
        offset,
        unit: info?.unit ?? '',
        min: kind.valueType ? '0' : physical(min, factor, offset),
        max: kind.valueType ? '0' : physical(max, factor, offset),
        comment: spec.comment,
        values: values && values.length > 0 ? values : undefined,
        ...extra,
      }),
    ]
  }

  build(): void {
    const { options, config } = this
    if (options.nmt) this.nmt()
    if (options.sync && config.network.syncMode !== 'none') this.sync()
    if (options.time && config.network.time.enabled) this.time()
    if (options.heartbeat && config.network.heartbeatProducerMs > 0) this.masterHeartbeat()
    for (const node of this.exported) {
      if (options.pdo) this.pdos(node)
      if (options.heartbeat) this.heartbeat(node)
      if (options.emcy) this.emcy(node)
      if (options.sdo) this.sdo(node)
    }
    this.messages.sort((a, b) => a.id - b.id)
  }

  private nmt() {
    const m = this.message(0x000, 'NMT', 2, MASTER, { comment: 'NMT node control' })
    this.signal(m, 'NMT_Command', 0, 8, this.slaves, { values: NMT_COMMANDS })
    this.signal(m, 'NMT_NodeId', 8, 8, this.slaves, { values: [['0', 'All nodes']] })
  }

  private sync() {
    const { network } = this.config
    const periodic = network.syncMode === 'period'
    this.message(0x080, 'SYNC', 0, MASTER, {
      comment: periodic ? 'SYNC' : 'SYNC, sent once per PLC cycle',
      cycleMs: periodic ? Math.round(network.syncPeriodUs / 1000) : undefined,
    })
  }

  private time() {
    const { time } = this.config.network
    const m = this.message(time.cobId, 'TIME', 6, MASTER, { comment: 'TIME stamp', cycleMs: time.periodMs })
    this.signal(m, 'TIME_Ms', 0, 28, this.slaves, { unit: 'ms', comment: 'Milliseconds after midnight' })
    this.signal(m, 'TIME_Days', 32, 16, this.slaves, { unit: 'd', comment: 'Days since 1 January 1984' })
  }

  private masterHeartbeat() {
    const { network } = this.config
    const m = this.message(0x700 + network.masterNodeId, `${MASTER}_Heartbeat`, 1, MASTER, {
      cycleMs: network.heartbeatProducerMs,
    })
    this.signal(m, `${MASTER}_NmtState`, 0, 7, this.slaves, { values: NMT_STATES })
  }

  private heartbeat(node: CanopenNode) {
    const name = this.nodeName(node)
    const producer = effectiveProducerMs(node)
    const m = this.message(0x700 + node.nodeId, `${node.name}_Heartbeat`, 1, name, {
      cycleMs: producer > 0 ? producer : undefined,
      comment: `Heartbeat and node guarding of node ${node.nodeId}`,
    })
    this.signal(m, `${node.name}_NmtState`, 0, 7, [MASTER], { values: NMT_STATES })
    this.signal(m, `${node.name}_Toggle`, 7, 1, [MASTER], { comment: 'Node guarding toggle bit, 0 in a heartbeat' })
  }

  private emcy(node: CanopenNode) {
    const emcy = effectiveEmcy(node)
    if (!emcy.enabled) return
    const m = this.message(emcy.cobId, `${node.name}_EMCY`, 8, this.nodeName(node), {
      comment: `Emergency of node ${node.nodeId}`,
    })
    this.signal(m, `${node.name}_EmcyCode`, 0, 16, [MASTER], {
      values: EMCY_CODES.map(([c, t]): [string, string] => [String(c), t]),
    })
    ERROR_REGISTER_BITS.forEach((label, bit) =>
      this.signal(m, `${node.name}_ER_${label}`, 16 + bit, 1, [MASTER], { comment: `Error register bit ${bit}` }),
    )
    this.signal(m, `${node.name}_EmcyManufacturer`, 24, 40, [MASTER])
  }

  /** Nodes of the export whose RPDO consumes this COB-ID without the master. */
  private consumers(cobId: number, except: CanopenNode): string[] {
    return this.exported
      .filter((n) => n.id !== except.id && n.rpdos.some((p) => pdoConfigured(p) && !p.exchanged && p.cobId === cobId))
      .map((n) => this.nodeName(n))
  }

  private pdos(node: CanopenNode) {
    const name = this.nodeName(node)
    const producedCobIds = new Set(
      this.exported.flatMap((n) => n.tpdos.filter((p) => pdoConfigured(p)).map((p) => p.cobId)),
    )
    for (const pdo of node.tpdos) {
      if (!pdoConfigured(pdo)) continue
      const receivers = [...(pdoExchanged(pdo) ? [MASTER] : []), ...this.consumers(pdo.cobId, node)]
      const timer = effectiveEventTimerMs(node, pdo)
      this.pdo(node, pdo, 'TPDO', name, receivers, {
        cycleMs: timer > 0 ? timer : this.syncCycleMs(pdo),
        delayMs: pdo.inhibitTime > 0 ? pdo.inhibitTime / 10 : undefined,
      })
    }
    for (const pdo of node.rpdos) {
      if (!pdoConfigured(pdo)) continue
      // A PDO between nodes is the producer's TPDO message when the producer is exported.
      if (!pdo.exchanged && producedCobIds.has(pdo.cobId)) continue
      const period = rpdoSendPeriodMs(pdo, null)
      this.pdo(node, pdo, 'RPDO', pdo.exchanged ? MASTER : NO_NODE, [name], {
        cycleMs: period ?? this.syncCycleMs(pdo),
      })
    }
  }

  private syncCycleMs(pdo: CanopenPdo): number | undefined {
    const { network } = this.config
    if (network.syncMode !== 'period' || pdo.transmissionType < 1 || pdo.transmissionType > 240) return undefined
    return Math.round((network.syncPeriodUs * pdo.transmissionType) / 1000)
  }

  private pdo(
    node: CanopenNode,
    pdo: CanopenPdo,
    kind: 'TPDO' | 'RPDO',
    transmitter: string,
    receivers: string[],
    timing: { cycleMs?: number; delayMs?: number },
  ) {
    let bit = 0
    const specs: Array<{ spec: SignalSpec; alias?: string; iec?: string }> = []
    for (const e of pdo.entries) {
      const length = canopenTypeBits(e.dataType)
      if (!isDummyEntry(e)) {
        const object = findObject(node.eds, e.index, e.subIndex)
        const where = `0x${hex4(e.index)}:${e.subIndex} ${objectLabel(object, e.index, e.subIndex)}`
        specs.push({
          spec: {
            name: e.alias ?? `${node.name}_${objectLabel(object, e.index, e.subIndex)}`,
            start: bit,
            length,
            type: e.dataType,
            receivers,
            object,
            comment: [where, e.iecLocation].filter(Boolean).join(', '),
          },
          iec: e.iecLocation || undefined,
        })
      }
      bit += length
    }
    const transmission = pdo.transmissionType <= 240 ? `synchronous, type ${pdo.transmissionType}` : 'event-driven'
    const m = this.message(pdo.cobId, `${node.name}_${kind}${pdo.number}`, Math.ceil(bit / 8), transmitter, {
      comment: `${kind} ${pdo.number} of node ${node.nodeId}, ${transmission}${pdo.exchanged ? '' : ', not exchanged by the master'}`,
      ...timing,
    })
    for (const { spec, iec } of specs) this.objectSignal(m, spec, { iecLocation: iec })
  }

  private sdo(node: CanopenNode) {
    const keys = sdoObjectKeys(node, this.config, this.options.sdoValues)
    const objects = sdoObjects(keys, node)
    const name = this.nodeName(node)
    const objectNames = keys.map(([index, subIndex]): [string, string] => [
      String(index + subIndex * 0x10000),
      `0x${hex4(index)}:${subIndex} ${objectLabel(findObject(node.eds, index, subIndex), index, subIndex)}`,
    ])
    for (const [base, label, branches, tx, rx, prefix] of [
      [0x600, 'SDO_Rx', SDO_TO_NODE, MASTER, name, 'W'],
      [0x580, 'SDO_Tx', SDO_FROM_NODE, name, MASTER, 'R'],
    ] as const) {
      const m = this.message(base + node.nodeId, `${node.name}_${label}`, 8, tx, {
        comment: `SDO ${base === 0x600 ? 'requests to' : 'responses from'} node ${node.nodeId}, decoded by the command byte`,
      })
      const commandNames: string[] = []
      for (const b of branches)
        for (const [a, z] of b.ranges) for (let v = a; v <= z; v++) commandNames[v] ??= b.meaning
      const cmd = this.signal(m, `${node.name}_${label}_Cmd`, 0, 8, [rx], {
        muxer: true,
        values: commandNames.map((t, v): [string, string] => [String(v), t]),
      })
      for (const b of branches) {
        const s = this.signal(m, `${node.name}_${label}_${b.suffix}`, b.start, b.length, [rx], {
          muxer: b.role === 'value',
          muxedBy: { muxer: cmd.name, ranges: b.ranges },
          comment: b.meaning,
          values:
            b.role === 'object'
              ? objectNames
              : b.role === 'abort'
                ? SDO_ABORT_CODES.map(([c, t]): [string, string] => [String(c), t])
                : undefined,
        })
        if (b.role === 'value') this.sdoValues(m, s, objects, `${node.name}_${prefix}`, [rx])
      }
    }
  }

  /** Index high byte, then index low byte, then sub-index, then the typed value; raw data elsewhere. */
  private sdoValues(m: DbcMessage, indexHi: DbcSignal, objects: SdoObject[], prefix: string, rx: string[]) {
    const raw = (muxer: string, keys: number[], label: string) => {
      const ranges = complement(keys, 255)
      if (ranges.length === 0) return
      this.signal(m, `${prefix}_Data${label}`, 32, 32, rx, {
        muxedBy: { muxer, ranges },
        comment: 'Data bytes of an object the export does not describe',
      })
    }
    const his = [...new Set(objects.map((o) => o.index >> 8))]
    raw(indexHi.name, his, '')
    for (const hi of his) {
      const inHi = objects.filter((o) => o.index >> 8 === hi)
      const lo = this.signal(m, `${prefix}_Idx${hex2(hi)}`, 8, 8, rx, {
        muxer: true,
        muxedBy: { muxer: indexHi.name, ranges: [[hi, hi]] },
      })
      const los = [...new Set(inHi.map((o) => o.index & 0xff))]
      raw(lo.name, los, `_${hex2(hi)}`)
      for (const l of los) {
        const index = (hi << 8) | l
        const subs = inHi.filter((o) => o.index === index)
        const sub = this.signal(m, `${prefix}_Sub${hex4(index)}`, 24, 8, rx, {
          muxer: true,
          muxedBy: { muxer: lo.name, ranges: [[l, l]] },
        })
        raw(
          sub.name,
          subs.map((o) => o.subIndex),
          `_${hex4(index)}`,
        )
        for (const o of subs) {
          this.objectSignal(
            m,
            {
              name: `${prefix}_${objectLabel(o.object, o.index, o.subIndex)}_${hex4(o.index)}_${o.subIndex}`,
              start: 32,
              length: canopenTypeBits(o.type) === 1 ? 8 : canopenTypeBits(o.type),
              type: o.type,
              receivers: rx,
              object: o.object,
              comment: `0x${hex4(o.index)}:${o.subIndex} ${objectLabel(o.object, o.index, o.subIndex)}`,
            },
            { muxedBy: { muxer: sub.name, ranges: [[o.subIndex, o.subIndex]] } },
          )
        }
      }
    }
  }
}

// ---- Check ----

/** The rules a DBC must meet before it is saved; each finding names the message and signal. */
function checkDbc(messages: readonly DbcMessage[]): DcfExportProblem[] {
  const out: DcfExportProblem[] = []
  const ids = new Map<number, string>()
  for (const m of messages) {
    const where = `message 0x${m.id.toString(16).toUpperCase()} ${m.name}`
    const other = ids.get(m.id)
    if (other !== undefined)
      out.push({
        section: where,
        message: `COB-ID 0x${m.id.toString(16).toUpperCase()} is used by ${other} and ${m.name}`,
      })
    ids.set(m.id, m.name)
    if (m.id > 0x7ff) out.push({ section: where, message: 'the ID is not an 11-bit CAN ID' })
    if (m.dlc > 8) out.push({ section: where, message: `the message is ${m.dlc} bytes long, more than 8` })
    const byName = new Map(m.signals.map((s) => [s.name, s]))
    const conditions = new Map<string, Map<string, Range[]>>()
    const conditionOf = (s: DbcSignal): Map<string, Range[]> => {
      const known = conditions.get(s.name)
      if (known) return known
      const c = new Map<string, Range[]>()
      if (s.muxedBy) {
        const parent = byName.get(s.muxedBy.muxer)
        if (parent) for (const [k, v] of conditionOf(parent)) c.set(k, v)
        c.set(s.muxedBy.muxer, s.muxedBy.ranges)
      }
      conditions.set(s.name, c)
      return c
    }
    for (const s of m.signals) {
      if (s.start + s.length > m.dlc * 8)
        out.push({ section: where, key: s.name, message: 'the signal does not fit in the message' })
      if (s.muxedBy && !byName.get(s.muxedBy.muxer)?.muxer)
        out.push({ section: where, key: s.name, message: `its multiplexer ${s.muxedBy.muxer} is not defined` })
    }
    const exclusive = (a: Map<string, Range[]>, b: Map<string, Range[]>) => {
      for (const [k, ra] of a) {
        const rb = b.get(k)
        if (rb && !ra.some(([a0, a1]) => rb.some(([b0, b1]) => a0 <= b1 && b0 <= a1))) return true
      }
      return false
    }
    for (let i = 0; i < m.signals.length; i++)
      for (let j = i + 1; j < m.signals.length; j++) {
        const a = m.signals[i]
        const b = m.signals[j]
        if (a.start >= b.start + b.length || b.start >= a.start + a.length) continue
        if (exclusive(conditionOf(a), conditionOf(b))) continue
        out.push({ section: where, key: `${a.name}, ${b.name}`, message: 'the signals overlap' })
      }
  }
  return out
}

// ---- Writer ----

const q = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
/** DBC texts are 8-bit; letters outside ASCII are written without their marks or as `?`. */
const ascii = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?')

const ranges = (rs: Range[]) => rs.map(([a, b]) => `${a}-${b}`).join(', ')

function writeDbc(networkName: string, bitrate: number, nodes: DbcNode[], messages: DbcMessage[]): string {
  const L: string[] = []
  L.push('VERSION ""', '', 'NS_ :')
  for (const ns of ['CM_', 'BA_DEF_', 'BA_', 'VAL_', 'BA_DEF_DEF_', 'SIG_VALTYPE_', 'SG_MUL_VAL_']) L.push(`\t${ns}`)
  L.push('', 'BS_:', '', `BU_: ${nodes.map((n) => n.name).join(' ')}`, '')
  const cm: string[] = [`CM_ ${q(ascii(`CANopen network ${networkName}, exported by OpenPLC Editor`))};`]
  const ba: string[] = [`BA_ "BusType" "CAN";`, `BA_ "Baudrate" ${bitrate};`, `BA_ "DBName" ${q(ascii(networkName))};`]
  const val: string[] = []
  const valType: string[] = []
  const mul: string[] = []
  for (const n of nodes) {
    cm.push(`CM_ BU_ ${n.name} ${q(n.comment)};`)
    if (n.nodeId !== undefined) ba.push(`BA_ "CANopenNodeId" BU_ ${n.name} ${n.nodeId};`)
    if (n.longName) ba.push(`BA_ "SystemNodeLongSymbol" BU_ ${n.name} ${q(n.longName)};`)
  }
  for (const m of messages) {
    L.push(`BO_ ${m.id} ${m.name}: ${m.dlc} ${m.transmitter}`)
    for (const s of m.signals) {
      const mux = s.muxedBy ? `m${s.muxedBy.ranges[0][0]}${s.muxer ? 'M' : ''} ` : s.muxer ? 'M ' : ''
      L.push(
        ` SG_ ${s.name} ${mux}: ${s.start}|${s.length}@1${s.signed ? '-' : '+'} (${dbcNumber(s.factor)},${dbcNumber(s.offset)}) [${s.min}|${s.max}] ${q(ascii(s.unit))} ${s.receivers.join(',')}`,
      )
      if (s.comment) cm.push(`CM_ SG_ ${m.id} ${s.name} ${q(ascii(s.comment))};`)
      if (s.iecLocation) ba.push(`BA_ "IecLocation" SG_ ${m.id} ${s.name} ${q(s.iecLocation)};`)
      if (s.longName) ba.push(`BA_ "SystemSignalLongSymbol" SG_ ${m.id} ${s.name} ${q(s.longName)};`)
      if (s.valueType) valType.push(`SIG_VALTYPE_ ${m.id} ${s.name} : ${s.valueType};`)
      if (s.values && s.values.length > 0)
        val.push(`VAL_ ${m.id} ${s.name} ${s.values.map(([v, t]) => `${v} ${q(ascii(t))}`).join(' ')} ;`)
      if (s.muxedBy) mul.push(`SG_MUL_VAL_ ${m.id} ${s.name} ${s.muxedBy.muxer} ${ranges(s.muxedBy.ranges)};`)
    }
    L.push('')
    if (m.comment) cm.push(`CM_ BO_ ${m.id} ${q(ascii(m.comment))};`)
    if (m.cycleMs) ba.push(`BA_ "GenMsgCycleTime" BO_ ${m.id} ${Math.round(m.cycleMs)};`)
    if (m.delayMs) ba.push(`BA_ "GenMsgDelayTime" BO_ ${m.id} ${Math.round(m.delayMs)};`)
    if (m.longName) ba.push(`BA_ "SystemMessageLongSymbol" BO_ ${m.id} ${q(m.longName)};`)
  }
  L.push(...cm, '')
  L.push(
    'BA_DEF_ "BusType" STRING ;',
    'BA_DEF_ "Baudrate" INT 0 1000000;',
    'BA_DEF_ "DBName" STRING ;',
    'BA_DEF_ BU_ "CANopenNodeId" INT 0 127;',
    'BA_DEF_ BU_ "SystemNodeLongSymbol" STRING ;',
    'BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535;',
    'BA_DEF_ BO_ "GenMsgDelayTime" INT 0 65535;',
    'BA_DEF_ BO_ "SystemMessageLongSymbol" STRING ;',
    'BA_DEF_ SG_ "IecLocation" STRING ;',
    'BA_DEF_ SG_ "SystemSignalLongSymbol" STRING ;',
    'BA_DEF_DEF_ "BusType" "CAN";',
    'BA_DEF_DEF_ "Baudrate" 0;',
    'BA_DEF_DEF_ "DBName" "";',
    'BA_DEF_DEF_ "CANopenNodeId" 0;',
    'BA_DEF_DEF_ "SystemNodeLongSymbol" "";',
    'BA_DEF_DEF_ "GenMsgCycleTime" 0;',
    'BA_DEF_DEF_ "GenMsgDelayTime" 0;',
    'BA_DEF_DEF_ "SystemMessageLongSymbol" "";',
    'BA_DEF_DEF_ "IecLocation" "";',
    'BA_DEF_DEF_ "SystemSignalLongSymbol" "";',
  )
  L.push(...ba, '', ...val, '', ...valType, '', ...mul, '')
  return L.join('\r\n')
}

export interface DbcExportOptions {
  networkName: string
  /** Export these nodes only (a node export); the network frames are always in the file. */
  nodes?: readonly CanopenNode[]
}

/** The DBC of the network, or of the given nodes, with the network's DBC options. */
export function buildDbc(config: CanopenConfig, options: DbcExportOptions): DeviceFileExport {
  const nodes = options.nodes ?? config.nodes
  const builder = new DbcBuilder(config, nodes, dbcExportOptions(config))
  builder.build()
  const signals = builder.messages.reduce((n, m) => n + m.signals.length, 0)
  const fileName =
    options.nodes && options.nodes.length === 1
      ? dbcNodeFileName(options.nodes[0].nodeId)
      : dbcNetworkFileName(options.networkName)
  return {
    fileName,
    text: writeDbc(options.networkName, config.network.bitrate, builder.nodes, builder.messages),
    summary: `${builder.messages.length} frame${builder.messages.length === 1 ? '' : 's'}, ${signals} signals, ${nodes.length} node${nodes.length === 1 ? '' : 's'}`,
    errors: [],
    problems: checkDbc(builder.messages),
  }
}
