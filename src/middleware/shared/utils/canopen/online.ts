/**
 * The CANopen online tools: SDO reads and writes, NMT commands and service mode through a runtime's
 * request route, and what the editor shows of a node's objects (the project's value, the node's
 * value, typing from the EDS, save and restore scopes).
 */

import type {
  CanopenAnswer,
  CanopenCanInterface,
  CanopenLssDeviceFields,
  CanopenNmtCommand,
  CanopenRequest,
  CanopenScanDeviceFields,
} from '../../ports/canopen-online'
import { parseCanopenAnswer } from '../../ports/canopen-online'
import type { CanopenRuntimeFetch } from '../../ports/canopen-status'
import type { CanopenEdsInfo, CanopenNetworkSettings, CanopenNode, CanopenObject } from '../../ports/canopen-types'
import { canopenTypeBits, toCanopenDataType } from './data-types'
import { hex, sdoAbortText } from './diagnostics/codes'
import { findObject, parseEdsInteger } from './eds-parser'
import { nodeConfigurationSdos } from './generate-canopen-config'
import { edsDefault, restoreChoiceName } from './model'
import { encodeCanopenValue, toHex } from './sdo-value'

/** Sends one request and returns the route's body verbatim (`RuntimePort.canopenRequest`). */
export type CanopenRequestFn = (request: CanopenRequest) => Promise<CanopenRuntimeFetch>

/** The outcome of an SDO read or write, or of an NMT or service mode request. */
export type CanopenOnlineResult =
  | { ok: true; bytes: number[]; network?: number }
  | { ok: false; abortCode: number; message: string }
  | { ok: false; abortCode?: undefined; reason: string; message: string; name?: string }

const REASONS: Readonly<Record<string, string>> = {
  booting: 'the master is booting the node; try again once it is up',
  not_running: 'no CANopen network runs on the runtime',
  unknown_network: 'the runtime runs no network by this name',
  unknown_node: 'the network running on the runtime has no such node',
  queue_full: 'too many requests are waiting; try again',
  too_large: 'the value is too large',
  bad_request: 'the runtime did not accept the request',
  unknown_op: 'the runtime does not offer this request',
  unknown_job: 'the runtime no longer knows the request',
  plc_running: 'the PLC is running; stop it first',
  busy: 'the bus is already open',
  interface_in_use: 'a CANopen network or slave runs on this interface',
  inactive: 'the runtime has no CANopen',
  error: 'the request failed on the runtime',
  timeout: 'the runtime did not finish the request in time',
  unknown_slave: 'the runtime runs no slave by this name',
  lss_off: 'LSS is off in the slave the runtime runs',
  settings_off: 'saving settings is off in the slave the runtime runs',
  not_commissioning: 'only while the bus is open for device commissioning',
  network_on_interface: 'a CANopen network runs on this interface, kept on the bus at PLC stop',
  slave_on_interface: 'a CANopen slave of the runtime runs on this interface',
}

/** A refusal or failure reason in words. */
export function onlineReasonText(reason: string): string {
  return REASONS[reason] ?? reason
}

type ReasonFailure = { ok: false; abortCode?: undefined; reason: string; message: string; name?: string }

function failed(reason: string, detail?: string, name?: string): ReasonFailure {
  if (name === undefined) return { ok: false, reason, message: detail ?? onlineReasonText(reason) }
  const who =
    reason === 'network_on_interface'
      ? `the network ${name} runs on this interface, kept on the bus at PLC stop`
      : reason === 'slave_on_interface'
        ? `the slave ${name} of the runtime runs on this interface; stop it there or use another interface`
        : `${onlineReasonText(reason)} (${name})`
  return { ok: false, reason, message: detail ?? who, name }
}

function fromHex(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i + 1 < text.length; i += 2) out.push(parseInt(text.slice(i, i + 2), 16))
  return out
}

/** Waits between job polls: short at first, since most SDOs end within a few bus cycles. */
export const JOB_POLL_STEPS_MS: readonly number[] = [10, 20, 50]

/** A device's LSS address: the four values of its 0x1018. */
export interface LssDevice {
  vendorId: number
  productCode: number
  revision: number
  serialNumber: number
}

/** A node ID a bus scan found. Values are null when not read. */
export interface ScanDevice {
  nodeId: number
  /** Answered at least the 0x1000 read (an SDO abort counts as an answer). */
  answered: boolean
  heard: ReadonlyArray<'heartbeat' | 'boot_up' | 'emcy'>
  deviceType: number | null
  vendorId: number | null
  productCode: number | null
  revision: number | null
  serialNumber: number | null
}

export type ScanResult = { ok: true; devices: ScanDevice[] } | (LssFailure & { devices: ScanDevice[] })

/** How long a bus scan may run: 127 IDs, five reads of 200 ms each, 8 at a time, with margin. */
export const SCAN_TIMEOUT_MS = 60 * 1000

type LssFailure = { ok: false; reason: string; message: string }
export type LssFindResult = { ok: true; devices: LssDevice[] } | (LssFailure & { devices: LssDevice[] })
export type LssSetIdResult = { ok: true; previousId: number; stored: boolean } | LssFailure
export type LssSetBitrateResult = { ok: true } | LssFailure

const LSS_REASONS: Readonly<Record<string, string>> = {
  busy: 'another LSS request or a search is running; try again',
  not_found: 'no device with this LSS address answered',
  no_answer: 'the device stopped answering',
  refused: 'the device refused the value',
  store_refused: 'the device took the value but refused to store it',
  too_many: 'the search stopped after 64 devices',
  incomplete:
    'a device answered out of turn, so more devices may be waiting; give the devices found a node ID and search again',
  needs_service_mode: 'only while the bus is open in service mode',
  needs_plc_stopped: 'only while the PLC is stopped',
  node_in_use: 'a running node of the network has this node ID',
  not_running: 'no CANopen network runs on the runtime',
}

/** An LSS refusal or failure in words. */
export function lssReasonText(reason: string): string {
  return LSS_REASONS[reason] ?? onlineReasonText(reason)
}

/** The LSS bit rates (bit/s) a device can be set to (CiA 305 bit timing table 0). */
export const LSS_BITRATES: readonly number[] = [1000000, 800000, 500000, 250000, 125000, 50000, 20000, 10000]

/** How long an LSS search may run: about 7 s per device, at most 64 devices. */
export const LSS_FIND_TIMEOUT_MS = 10 * 60 * 1000

type LssDeviceFields = CanopenLssDeviceFields
type FoundFields = CanopenLssDeviceFields | CanopenScanDeviceFields

const isScanFields = (d: FoundFields): d is CanopenScanDeviceFields => 'node_id' in d

function toLssDevices(devices: FoundFields[] | undefined): LssDevice[] {
  return (devices ?? [])
    .flatMap((d) => (isScanFields(d) ? [] : [d]))
    .map((d) => ({
      vendorId: d.vendor_id,
      productCode: d.product_code,
      revision: d.revision,
      serialNumber: d.serial_number,
    }))
}

function toScanDevices(devices: FoundFields[] | undefined): ScanDevice[] {
  return (devices ?? []).filter(isScanFields).map((d) => ({
    nodeId: d.node_id,
    answered: d.answered,
    heard: d.heard,
    deviceType: d.device_type,
    vendorId: d.vendor_id,
    productCode: d.product_code,
    revision: d.revision,
    serialNumber: d.serial_number,
  }))
}

function lssAddress(d: LssDevice): LssDeviceFields {
  return { vendor_id: d.vendorId, product_code: d.productCode, revision: d.revision, serial_number: d.serialNumber }
}

/** The master's node ID in service mode for commissioning; it sends nothing under it there. */
export const COMMISSION_MASTER_NODE_ID = 127
/** SDO timeout of the commissioning window's reads and writes. */
export const COMMISSION_SDO_TIMEOUT_MS = 1000

export interface CanopenOnlineOptions {
  /** The longest wait between job polls, used after `JOB_POLL_STEPS_MS`. */
  pollMs?: number
  /** How long a job may stay pending before it counts as failed. */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface CanopenOnline {
  read(network: number, node: number, index: number, subIndex: number): Promise<CanopenOnlineResult>
  write(network: number, node: number, index: number, subIndex: number, bytes: number[]): Promise<CanopenOnlineResult>
  nmt(network: number, node: number, command: CanopenNmtCommand): Promise<CanopenOnlineResult>
  openService(name: string, network: CanopenNetworkSettings, nodeIds: number[]): Promise<CanopenOnlineResult>
  /**
   * Opens service mode for commissioning on @p iface at @p bitrate: any node ID, bus scans. With
   * @p takeOver a network kept on the bus at PLC stop there leaves it; a refusal names who uses it.
   */
  openCommission(name: string, iface: string, bitrate: number, takeOver: boolean): Promise<CanopenOnlineResult>
  /** Scans node IDs 1-127 in service mode for commissioning; @p onProgress gets the IDs found so far. */
  scan(network: number, onProgress?: (devices: ScanDevice[]) => void): Promise<ScanResult>
  closeService(): Promise<CanopenOnlineResult>
  /** The CAN links of the runtime's computer, sorted by name; a runtime without the request refuses it. */
  interfaces(): Promise<CanInterfacesResult>
  /** Removes the node ID and bit rate an LSS master stored for the slave; the slave restarts. */
  forgetSlaveLss(slave: string): Promise<CanopenOnlineResult>
  /** Removes the settings a master saved into the slave; it restarts with the project's values. */
  forgetSlaveSettings(slave: string): Promise<CanopenOnlineResult>
  /** Finds the devices without a node ID; @p onProgress gets the devices that answered so far. */
  lssFind(network: number, onProgress?: (devices: LssDevice[]) => void): Promise<LssFindResult>
  lssSetId(network: number, device: LssDevice, nodeId: number, store: boolean): Promise<LssSetIdResult>
  /** Sets and stores the device's bit rate; only while the PLC is stopped. */
  lssSetBitrate(network: number, device: LssDevice, bitrate: number): Promise<LssSetBitrateResult>
}

export type CanInterfacesResult = { ok: true; interfaces: CanopenCanInterface[] } | ReasonFailure

type JobEnd = Extract<CanopenAnswer, { state: 'done' } | { state: 'failed' }>
type Pending = Extract<CanopenAnswer, { state: 'pending' }>

/** The online tools over one runtime's request route. SDO requests are jobs, polled until they end. */
export function createCanopenOnline(send: CanopenRequestFn, options: CanopenOnlineOptions = {}): CanopenOnline {
  const pollMs = options.pollMs ?? 100
  const timeoutMs = options.timeoutMs ?? 15000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const ask = async (request: CanopenRequest) => {
    const result = await send(request)
    if (!result.success) return { error: failed('error', result.error) }
    const answer = parseCanopenAnswer(result.body)
    if (!answer) return { error: failed('error', 'the runtime sent an answer this editor does not read') }
    if ('error' in answer) return { error: failed(answer.error, undefined, answer.name) }
    if ('active' in answer) return { error: failed('inactive') }
    return { answer }
  }

  const pollJob = async (
    request: CanopenRequest,
    limitMs: number,
    onPending?: (answer: Pending) => void,
  ): Promise<{ end: JobEnd; error?: undefined } | { error: ReasonFailure }> => {
    const first = await ask(request)
    if (first.error) return { error: first.error }
    if (!('job' in first.answer)) return { error: failed('error', 'the runtime did not start the request') }
    const job = first.answer.job
    let waited = 0
    for (let poll = 0; ; poll++) {
      const next = await ask({ op: 'job', job })
      if (next.error) return { error: next.error }
      const a = next.answer
      if ('state' in a && (a.state === 'done' || a.state === 'failed')) return { end: a }
      if ('state' in a && a.state === 'pending' && onPending) onPending(a)
      if (waited >= limitMs) return { error: failed('timeout') }
      const wait = Math.min(JOB_POLL_STEPS_MS[poll] ?? pollMs, pollMs)
      await sleep(wait)
      waited += wait
    }
  }

  const runJob = async (request: CanopenRequest): Promise<CanopenOnlineResult> => {
    const r = await pollJob(request, timeoutMs)
    if (r.error) return r.error
    const a = r.end
    if (a.state === 'done') return { ok: true, bytes: fromHex(a.data ?? '') }
    if ('abort_code' in a)
      return {
        ok: false,
        abortCode: a.abort_code,
        message: `${sdoAbortText(a.abort_code)} (${hex(a.abort_code, 8)})`,
      }
    return failed(a.reason)
  }

  const lssJob = async (request: CanopenRequest, limitMs: number, onPending?: (answer: Pending) => void) => {
    const r = await pollJob(request, limitMs, onPending)
    if (r.error) {
      return { failure: { ok: false as const, reason: r.error.reason, message: r.error.message }, end: null }
    }
    const a = r.end
    if (a.state === 'done') return { failure: null, end: a }
    const reason = 'reason' in a ? a.reason : 'error'
    return {
      failure: { ok: false as const, reason, message: lssReasonText(reason) },
      end: 'reason' in a ? a : null,
    }
  }

  const simple = async (request: CanopenRequest): Promise<CanopenOnlineResult> => {
    const r = await ask(request)
    if (r.error) return r.error
    if (!('ok' in r.answer)) return failed('error', 'the runtime gave an unexpected answer')
    return r.answer.network === undefined ? { ok: true, bytes: [] } : { ok: true, bytes: [], network: r.answer.network }
  }

  return {
    read: (network, node, index, subIndex) => runJob({ op: 'sdo_read', network, node, index, subindex: subIndex }),
    write: (network, node, index, subIndex, bytes) =>
      runJob({ op: 'sdo_write', network, node, index, subindex: subIndex, data: toHex(bytes) }),
    nmt: (network, node, command) => simple({ op: 'nmt', network, node, command }),
    openService: (name, network, nodeIds) =>
      simple({
        op: 'service_open',
        name,
        interface: network.interface,
        bitrate: network.bitrate,
        master_node_id: network.masterNodeId,
        sdo_timeout_ms: network.sdoTimeoutMs,
        nodes: nodeIds,
      }),
    openCommission: (name, iface, bitrate, takeOver) =>
      simple({
        op: 'service_open',
        name,
        interface: iface,
        bitrate,
        master_node_id: COMMISSION_MASTER_NODE_ID,
        sdo_timeout_ms: COMMISSION_SDO_TIMEOUT_MS,
        commission: true,
        ...(takeOver ? { take_over: true } : {}),
      }),
    closeService: () => simple({ op: 'service_close' }),
    interfaces: async () => {
      const r = await ask({ op: 'interfaces' })
      if (r.error) return r.error
      if (!('interfaces' in r.answer)) return failed('error', 'the runtime gave an unexpected answer')
      return { ok: true, interfaces: r.answer.interfaces }
    },
    scan: async (network, onProgress) => {
      const r = await lssJob({ op: 'scan', network }, SCAN_TIMEOUT_MS, (a) => {
        if (onProgress && a.devices) onProgress(toScanDevices(a.devices))
      })
      const devices = toScanDevices(r.end?.devices)
      return r.failure ? { ...r.failure, devices } : { ok: true, devices }
    },
    forgetSlaveLss: (slave) => simple({ op: 'slave_lss_forget', slave }),
    forgetSlaveSettings: (slave) => simple({ op: 'slave_settings_forget', slave }),
    lssFind: async (network, onProgress) => {
      const r = await lssJob({ op: 'lss', network, action: 'find' }, LSS_FIND_TIMEOUT_MS, (a) => {
        if (onProgress && a.devices) onProgress(toLssDevices(a.devices))
      })
      const devices = toLssDevices(r.end?.devices)
      return r.failure ? { ...r.failure, devices } : { ok: true, devices }
    },
    lssSetId: async (network, device, nodeId, store) => {
      const r = await lssJob(
        { op: 'lss', network, action: 'set_id', node_id: nodeId, store, ...lssAddress(device) },
        timeoutMs,
      )
      if (r.failure) return r.failure
      return { ok: true, previousId: r.end.previous_id ?? 255, stored: r.end.stored ?? false }
    },
    lssSetBitrate: async (network, device, bitrate) => {
      const r = await lssJob({ op: 'lss', network, action: 'set_bitrate', bitrate, ...lssAddress(device) }, timeoutMs)
      return r.failure ?? { ok: true }
    },
  }
}

// --- Values ---

/** EDS data type codes of the string types, which the tab decodes as text. */
const STRING_TYPES: Readonly<Record<string, 'visible' | 'octet' | 'unicode'>> = {
  '0x0009': 'visible',
  '0x000A': 'octet',
  '0x000B': 'unicode',
}

function stringKind(dataType: string): 'visible' | 'octet' | 'unicode' | undefined {
  const m = /^0x([0-9a-f]+)$/i.exec(dataType)
  return m ? STRING_TYPES[`0x${m[1].toUpperCase().padStart(4, '0')}`] : undefined
}

/** The data type's name for display: the basic type, a string type, or the EDS code. */
export function dataTypeLabel(dataType: string): string {
  const kind = stringKind(dataType)
  if (kind === 'visible') return 'VISIBLE_STRING'
  if (kind === 'octet') return 'OCTET_STRING'
  if (kind === 'unicode') return 'UNICODE_STRING'
  return dataType
}

export type ValueDisplay = 'decimal' | 'hex'

/** Bytes of a value as the tab shows them: typed by the EDS, else hex bytes. */
export function formatCanopenValue(dataType: string, bytes: readonly number[], display: ValueDisplay): string {
  const kind = stringKind(dataType)
  if (kind === 'visible') return `"${String.fromCharCode(...bytes.filter((b) => b !== 0))}"`
  if (kind === 'unicode') {
    let s = ''
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
    return `"${s}"`
  }
  const type = toCanopenDataType(dataType)
  if (!type || kind === 'octet') return bytes.length ? toHex([...bytes]) : '(empty)'
  const size = Math.max(1, canopenTypeBits(type) / 8)
  if (bytes.length !== size) return `${toHex([...bytes])} (${bytes.length} bytes, ${type} has ${size})`
  if (type === 'REAL32' || type === 'REAL64') {
    const view = new DataView(new Uint8Array(bytes).buffer)
    return String(type === 'REAL32' ? view.getFloat32(0, true) : view.getFloat64(0, true))
  }
  let v = BigInt(0)
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << BigInt(8)) | BigInt(bytes[i])
  if (display === 'hex')
    return `0x${v
      .toString(16)
      .toUpperCase()
      .padStart(size * 2, '0')}`
  if (type.startsWith('INTEGER') && v >= BigInt(1) << BigInt(size * 8 - 1)) v -= BigInt(1) << BigInt(size * 8)
  return v.toString()
}

/** Text the user typed, encoded by the object's type; strings as text, other types as hex bytes. */
export function encodeOnlineValue(
  dataType: string,
  text: string,
): { ok: true; bytes: number[] } | { ok: false; message: string } {
  const kind = stringKind(dataType)
  if (kind === 'visible') return { ok: true, bytes: Array.from(text, (c) => c.charCodeAt(0) & 0xff) }
  const type = toCanopenDataType(dataType)
  if (type && kind === undefined) return encodeCanopenValue(type, text)
  return encodeRawBytes(text)
}

/** A value typed for an object, encoded by its type and checked against the EDS limits. */
export function encodeForObject(
  object: CanopenObject,
  text: string,
  nodeId: number,
): { ok: true; bytes: number[] } | { ok: false; message: string } {
  const encoded = encodeOnlineValue(object.dataType, text)
  if (!encoded.ok) return encoded
  const type = toCanopenDataType(object.dataType)
  if (!type || type.startsWith('REAL') || type === 'BOOLEAN') return encoded
  const value = Number(formatCanopenValue(object.dataType, encoded.bytes, 'decimal'))
  const low = object.lowLimit !== undefined ? parseEdsInteger(object.lowLimit, nodeId) : null
  const high = object.highLimit !== undefined ? parseEdsInteger(object.highLimit, nodeId) : null
  if ((low !== null && value < low) || (high !== null && value > high))
    return {
      ok: false,
      message: `${text} is outside the range the device file allows (${low ?? '...'} to ${high ?? '...'})`,
    }
  return encoded
}

/** Hex bytes as typed for raw access ("e8 03", "0xE803" or "e803"). */
export function encodeRawBytes(text: string): { ok: true; bytes: number[] } | { ok: false; message: string } {
  const t = text.replace(/^0x/i, '').replace(/[\s:,]/g, '')
  if (t === '' || t.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(t))
    return { ok: false, message: `"${text}" is not whole hex bytes, for example "e8 03"` }
  return { ok: true, bytes: fromHex(t) }
}

// --- Objects of a node ---

export function isWritable(object: CanopenObject): boolean {
  return object.access !== 'ro' && object.access !== 'const'
}

export function isReadable(object: CanopenObject): boolean {
  return object.access !== 'wo'
}

/** One row of the Online tab. */
export interface OnlineObject {
  object: CanopenObject
  /** The value the master writes at boot, else the EDS default; null when neither is known. */
  project: number[] | null
  /** The master writes this object when it boots the node. */
  masterWrites: boolean
}

/** Every object of the node's EDS with its value in the project. */
export function onlineObjects(node: CanopenNode, network: CanopenNetworkSettings): OnlineObject[] {
  const writes = new Map<string, number[]>()
  for (const w of nodeConfigurationSdos(node, network)) writes.set(`${w.index}:${w.subindex}`, fromHex(w.data))
  return [...node.eds.objects]
    .sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)
    .map((object) => {
      const written = writes.get(`${object.index}:${object.subIndex}`)
      return {
        object,
        project: written ?? edsValue(node.eds, object, node.nodeId),
        masterWrites: written !== undefined,
      }
    })
}

/** Every object of a device file with its default, for a device that is not a node of the project. */
export function deviceFileObjects(eds: CanopenEdsInfo, nodeId: number): OnlineObject[] {
  return [...eds.objects]
    .sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)
    .map((object) => ({ object, project: edsValue(eds, object, nodeId), masterWrites: false }))
}

function edsValue(eds: CanopenEdsInfo, object: CanopenObject, nodeId: number): number[] | null {
  const type = toCanopenDataType(object.dataType)
  if (!type) return null
  const value = edsDefault(eds, object.index, object.subIndex, nodeId)
  if (value === null) return null
  const encoded = encodeCanopenValue(type, String(value))
  return encoded.ok ? encoded.bytes : null
}

/** Whether the node's value differs from the project's (unknown project values never differ). */
export function valueDiffers(project: readonly number[] | null, node: readonly number[] | null): boolean {
  if (project === null || node === null) return false
  return project.length !== node.length || project.some((b, i) => b !== node[i])
}

// --- Save and restore (0x1010, 0x1011) ---

export const SAVE_SIGNATURE: readonly number[] = [0x73, 0x61, 0x76, 0x65] // "save"
export const LOAD_SIGNATURE: readonly number[] = [0x6c, 0x6f, 0x61, 0x64] // "load"

export interface NvmScope {
  subIndex: number
  /** The EDS's name of the sub-index, else the CiA 301 name. */
  name: string
}

/** The scopes of 0x1010 (save) or 0x1011 (restore) that the EDS lists as writable sub-indexes. */
export function nvmScopes(eds: CanopenEdsInfo, index: 0x1010 | 0x1011): NvmScope[] {
  return eds.objects
    .filter((o) => o.index === index && o.subIndex >= 1 && isWritable(o))
    .sort((a, b) => a.subIndex - b.subIndex)
    .map((o) => ({ subIndex: o.subIndex, name: o.name || restoreChoiceName(o.subIndex) }))
}

/** How a node saves a scope, read from the scope's sub-index (CiA 301: bit 0 on command, bit 1 by itself). */
export type SaveSupport = 'command' | 'auto' | 'none' | 'unknown'

export function saveSupport(read: CanopenOnlineResult | null): SaveSupport {
  if (!read || !read.ok || read.bytes.length === 0) return 'unknown'
  const flags = read.bytes[0]
  if (flags & 0x01) return 'command'
  if (flags & 0x02) return 'auto'
  return 'none'
}

/** The NMT reset that makes a restore take effect: communication only for that scope. */
export function resetForRestore(subIndex: number): CanopenNmtCommand {
  return subIndex === 2 ? 'reset_communication' : 'reset_node'
}

/** The object, if the EDS has it, for raw access. */
export function rawObject(eds: CanopenEdsInfo, index: number, subIndex: number): CanopenObject | undefined {
  return findObject(eds, index, subIndex)
}

/**
 * Raw access never writes 0x1010 or 0x1011: Save to device and Restore defaults of the device
 * commissioning window do that, with confirmation; @p where is the node Online tab or that window.
 */
export function rawWriteRefusal(index: number, where: 'node' | 'device' = 'node'): string | null {
  if (index !== 0x1010 && index !== 0x1011) return null
  const what = index === 0x1010 ? "Saving to the device's memory" : "Restoring the device's defaults"
  if (where === 'device')
    return `${what} is done with ${index === 0x1010 ? 'Save to device' : 'Restore defaults'} above.`
  return `${what} is done in File > CANopen device commissioning..., one device at a time.`
}
