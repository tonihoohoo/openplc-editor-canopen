/**
 * The CANopen online tools: SDO reads and writes, NMT commands and service mode through a runtime's
 * request route, and what the editor shows of a node's objects (the project's value, the node's
 * value, typing from the EDS, save and restore scopes).
 */

import type { CanopenNmtCommand, CanopenRequest } from '../../ports/canopen-online'
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
  | { ok: true; bytes: number[] }
  | { ok: false; abortCode: number; message: string }
  | { ok: false; abortCode?: undefined; reason: string; message: string }

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
  inactive: 'the runtime has no CANopen',
  error: 'the request failed on the runtime',
  timeout: 'the runtime did not finish the request in time',
}

/** A refusal or failure reason in words. */
export function onlineReasonText(reason: string): string {
  return REASONS[reason] ?? reason
}

function failed(reason: string, detail?: string): CanopenOnlineResult {
  return { ok: false, reason, message: detail ?? onlineReasonText(reason) }
}

function fromHex(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i + 1 < text.length; i += 2) out.push(parseInt(text.slice(i, i + 2), 16))
  return out
}

export interface CanopenOnlineOptions {
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
  closeService(): Promise<CanopenOnlineResult>
}

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
    if ('error' in answer) return { error: failed(answer.error) }
    if ('active' in answer) return { error: failed('inactive') }
    return { answer }
  }

  const runJob = async (request: CanopenRequest): Promise<CanopenOnlineResult> => {
    const first = await ask(request)
    if (first.error) return first.error
    if (!('job' in first.answer)) return failed('error', 'the runtime did not start the request')
    const job = first.answer.job
    let waited = 0
    for (;;) {
      const next = await ask({ op: 'job', job })
      if (next.error) return next.error
      const a = next.answer
      if ('state' in a && a.state === 'done') return { ok: true, bytes: fromHex(a.data ?? '') }
      if ('state' in a && a.state === 'failed') {
        if ('abort_code' in a)
          return {
            ok: false,
            abortCode: a.abort_code,
            message: `${sdoAbortText(a.abort_code)} (${hex(a.abort_code, 8)})`,
          }
        return failed(a.reason)
      }
      if (waited >= timeoutMs) return failed('timeout')
      await sleep(pollMs)
      waited += pollMs
    }
  }

  const simple = async (request: CanopenRequest): Promise<CanopenOnlineResult> => {
    const r = await ask(request)
    if (r.error) return r.error
    return 'ok' in r.answer ? { ok: true, bytes: [] } : failed('error', 'the runtime gave an unexpected answer')
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
    closeService: () => simple({ op: 'service_close' }),
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
    return { ok: false, message: `${text} is outside the range the EDS allows (${low ?? '...'} to ${high ?? '...'})` }
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

/** Raw access never writes 0x1010 or 0x1011: Save to node and Restore defaults do that, with confirmation. */
export function rawWriteRefusal(index: number): string | null {
  if (index === 0x1010) return "Use Save to node to save to the node's memory."
  if (index === 0x1011) return "Use Restore defaults to restore the node's defaults."
  return null
}
