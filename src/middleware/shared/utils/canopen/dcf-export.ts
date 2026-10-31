/**
 * DCF export (CiA 306 5): the node's stored device file with a ParameterValue on every sub-object
 * the build writes to it (the last value written), Denotation for the aliases of mapped entries,
 * [DeviceComissioning] and the [FileInfo] keys of a DCF. Every other line stays as in the file.
 */

import JSZip from 'jszip'

import type { CanopenConfig, CanopenNetworkSettings, CanopenNode, CanopenObject } from '../../ports/canopen-types'
import { CANOPEN_TYPE_CODES, canopenTypeBits, objectRef } from './data-types'
import { checkEds, type Cia306Finding } from './eds-check'
import { readEdsDocument } from './eds-document'
import { findObject } from './eds-parser'
import { nodeConfigurationSdos, pdoActive } from './generate-canopen-config'
import { pdoObjectIndices, restoreChoiceName } from './model'

/** First word of the comment lines the export puts at the top; a later export replaces them. */
const COMMENT_MARK = '; DCF:'
export const DCF_MODIFIED_BY = 'OpenPLC Editor'
export const DCF_NETWORK_NAME_DEFAULT = 'OpenPLC CANopen'

export function dcfFileName(nodeId: number): string {
  return `node_${nodeId}.dcf`
}

interface Line {
  text: string
  touched: boolean
}

const SECTION = /^\s*\[([^\]]*)\]/
const ENTRY = /^\s*([^=;[\s][^=]*?)\s*=/

class Lines {
  readonly lines: Line[]
  readonly eol: string
  /** "SECTION|key" of every key set. */
  readonly written = new Set<string>()

  constructor(text: string) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n'
    const raw = text.split(/\r\n|\n|\r/)
    if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
    this.lines = raw.map((t) => ({ text: t, touched: false }))
  }

  /** [start, end) of the section: end is past its last entry or comment line. */
  find(name: string): [number, number] | null {
    const want = name.toUpperCase()
    for (let i = 0; i < this.lines.length; i++) {
      const m = SECTION.exec(this.lines[i].text)
      if (!m || m[1].trim().toUpperCase() !== want) continue
      let last = i
      for (let j = i + 1; j < this.lines.length; j++) {
        if (SECTION.test(this.lines[j].text)) break
        if (this.lines[j].text.trim() !== '') last = j
      }
      return [i, last + 1]
    }
    return null
  }

  get(section: string, key: string): string | undefined {
    const where = this.find(section)
    if (!where) return undefined
    for (let i = where[0] + 1; i < where[1]; i++) {
      const m = ENTRY.exec(this.lines[i].text)
      if (m && m[1].toLowerCase() === key.toLowerCase())
        return this.lines[i].text.slice(this.lines[i].text.indexOf('=') + 1).trim()
    }
    return undefined
  }

  /** Sets key=value in the section (replacing the key); appends the section when it is missing. */
  set(section: string, key: string, value: string, after?: string): void {
    this.written.add(`${section.toUpperCase()}|${key.toLowerCase()}`)
    const line = { text: `${key}=${value}`, touched: true }
    const where = this.find(section)
    if (!where) {
      if (this.lines.length > 0 && this.lines[this.lines.length - 1].text.trim() !== '')
        this.lines.push({ text: '', touched: false })
      this.lines.push({ text: `[${section}]`, touched: true }, line)
      return
    }
    let insertAt = where[1]
    for (let i = where[0] + 1; i < where[1]; i++) {
      const m = ENTRY.exec(this.lines[i].text)
      if (!m) continue
      if (m[1].toLowerCase() === key.toLowerCase()) {
        if (this.lines[i].text !== line.text) this.lines[i] = line
        return
      }
      if (after && m[1].toLowerCase() === after.toLowerCase()) insertAt = i + 1
    }
    this.lines.splice(insertAt, 0, line)
  }

  /** Removes the key from every section it appears in when `match` accepts the section. */
  dropKey(key: string, match: (section: string) => boolean): void {
    let section = ''
    for (let i = 0; i < this.lines.length; i++) {
      const s = SECTION.exec(this.lines[i].text)
      if (s) {
        section = s[1].trim()
        continue
      }
      const m = ENTRY.exec(this.lines[i].text)
      if (m && m[1].toLowerCase() === key.toLowerCase() && match(section)) this.lines.splice(i--, 1)
    }
  }

  dropSection(name: string): void {
    const where = this.find(name)
    if (!where) return
    const start = where[0]
    let end = where[1]
    while (end < this.lines.length && this.lines[end].text.trim() === '') end++
    this.lines.splice(start, end - start)
  }

  sectionNames(): string[] {
    return this.lines.flatMap((l) => {
      const m = SECTION.exec(l.text)
      return m ? [m[1].trim()] : []
    })
  }

  text(): string {
    return this.lines.map((l) => l.text).join(this.eol) + this.eol
  }

  /** 1-based numbers of the lines the export added or changed. */
  touchedLines(): Set<number> {
    const out = new Set<number>()
    this.lines.forEach((l, i) => {
      if (l.touched) out.add(i + 1)
    })
    return out
  }
}

function typeCode(dataType: string): number | undefined {
  for (const [code, name] of Object.entries(CANOPEN_TYPE_CODES)) if (name === dataType) return Number(code)
  const m = /^0x([0-9a-f]{4})$/i.exec(dataType)
  return m ? parseInt(m[1], 16) : undefined
}

function shortestReal32(v: number): string {
  for (let digits = 1; digits <= 9; digits++) {
    const text = String(Number(v.toPrecision(digits)))
    if (Math.fround(Number(text)) === v) return text
  }
  return String(v)
}

/** CiA 306 text of the bytes a build writes (hex, little-endian) for the object's data type. */
export function parameterValueText(object: CanopenObject, dataHex: string): string | null {
  const bytes = (dataHex.match(/../g) ?? []).map((b) => parseInt(b, 16))
  let n = 0n
  bytes.forEach((b, i) => (n |= BigInt(b) << BigInt(8 * i)))
  const bits = bytes.length * 8
  switch (object.dataType) {
    case 'BOOLEAN':
      return n === 0n ? '0' : '1'
    case 'INTEGER8':
    case 'INTEGER16':
    case 'INTEGER32':
    case 'INTEGER64':
      return String(BigInt.asIntN(bits, n))
    case 'UNSIGNED8':
    case 'UNSIGNED16':
    case 'UNSIGNED64':
      return String(n)
    case 'UNSIGNED32':
      return object.index >= 0x1000 && object.index <= 0x1fff
        ? `0x${n.toString(16).toUpperCase().padStart(8, '0')}`
        : String(n)
    case 'REAL32': {
      const view = new DataView(new Uint8Array(bytes).buffer)
      return bytes.length === 4 ? shortestReal32(view.getFloat32(0, true)) : null
    }
    case 'REAL64': {
      const view = new DataView(new Uint8Array(bytes).buffer)
      return bytes.length === 8 ? String(view.getFloat64(0, true)) : null
    }
    default:
      return null
  }
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0')
}

export interface DcfExportProblem {
  section?: string
  key?: string
  message: string
}

export interface DcfExport {
  fileName: string
  text: string
  /** CiA 306 findings on lines the export added or changed: errors, which stop the export. */
  errors: Cia306Finding[]
  /** Values the export cannot write. */
  problems: DcfExportProblem[]
}

export interface DcfExportOptions {
  now: Date
  networkName?: string
}

function cia306Date(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}`
}

function cia306Time(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(((d.getHours() + 11) % 12) + 1)}:${p(d.getMinutes())}${d.getHours() < 12 ? 'AM' : 'PM'}`
}

function isCompact(lines: Lines, index: number): boolean {
  const s = hex4(index)
  const compact = lines.get(s, 'CompactSubObj')
  return compact !== undefined && compact !== '' && compact !== '0' && !lines.get(s, 'SubNumber')
}

/** Writes the object and sub-object sections of a PDO CompactPDO implies (CiA 306 5.3.3.1). */
function addImplicitObject(lines: Lines, node: CanopenNode, index: number): void {
  const objects = node.eds.objects.filter((o) => o.index === index)
  if (objects.length === 0) return
  const id = hex4(index)
  const body = [
    `[${id}]`,
    `ParameterName=${objects[0].parentName ?? id}`,
    'ObjectType=0x9',
    `SubNumber=${objects.length}`,
    '',
  ]
  for (const o of objects) {
    body.push(
      `[${id}sub${o.subIndex.toString(16).toUpperCase()}]`,
      `ParameterName=${o.name}`,
      'ObjectType=0x7',
      `DataType=0x${hex4(typeCode(o.dataType) ?? 0)}`,
      `AccessType=${o.access}`,
      ...(o.defaultValue !== undefined ? [`DefaultValue=${o.defaultValue}`] : []),
      'PDOMapping=0',
      '',
    )
  }
  if (lines.lines.length > 0 && lines.lines[lines.lines.length - 1].text.trim() !== '')
    lines.lines.push({ text: '', touched: false })
  lines.lines.push(...body.map((text) => ({ text, touched: text !== '' })))
  const list = 'OptionalObjects'
  const count = Number(lines.get(list, 'SupportedObjects') ?? '0') || 0
  lines.set(list, String(count + 1), `0x${id}`)
  lines.set(list, 'SupportedObjects', String(count + 1))
}

/**
 * The node's DCF from its stored file text. `errors` and `problems` are empty when it can be saved.
 */
export function buildNodeDcf(
  node: CanopenNode,
  storedText: string,
  config: CanopenConfig,
  options: DcfExportOptions,
): DcfExport {
  const network: CanopenNetworkSettings = config.network
  const fileName = dcfFileName(node.nodeId)
  const lines = new Lines(storedText)
  const problems: DcfExportProblem[] = []

  // A DCF taken in keeps only its description: earlier values, names and commissioning go.
  while (lines.lines.length > 0 && lines.lines[0].text.startsWith(COMMENT_MARK)) lines.lines.shift()
  lines.dropKey('ParameterValue', () => true)
  lines.dropKey('Denotation', () => true)
  const last = new Map<string, { index: number; subIndex: number; data: string }>()
  for (const sdo of nodeConfigurationSdos(node, network))
    last.set(objectRef(sdo.index, sdo.subindex), { index: sdo.index, subIndex: sdo.subindex, data: sdo.data })
  const values = [...last.values()].sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)
  for (const name of lines.sectionNames())
    if (/^[0-9A-F]{4}(VALUE|DENOTATION)$/i.test(name) || /^DEVICECOMM?ISSIONING$/i.test(name)) lines.dropSection(name)
  values.push(...fixedMappingValues(node, last))
  values.sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)

  for (const { index, subIndex, data } of values) {
    const object = findObject(node.eds, index, subIndex)
    const where = `0x${hex4(index)} sub ${subIndex}`
    if (!object) {
      problems.push({ message: `${where}: the build writes it, but the device file does not describe it` })
      continue
    }
    const text = parameterValueText(object, data)
    if (text === null) {
      problems.push({ message: `${where}: data type ${object.dataType} has no ParameterValue form` })
      continue
    }
    const id = hex4(index)
    if (!lines.find(id) && index >= 0x1400 && index <= 0x1bff) addImplicitObject(lines, node, index)
    const subSection = `${id}sub${subIndex.toString(16).toUpperCase()}`
    if (lines.find(subSection)) lines.set(subSection, 'ParameterValue', text, 'DefaultValue')
    else if (subIndex === 0 && lines.find(id) && !isCompact(lines, index))
      lines.set(id, 'ParameterValue', text, 'DefaultValue')
    else if (subIndex >= 1 && isCompact(lines, index)) setListEntry(lines, `${id}Value`, subIndex, text)
    else if (subIndex === 0 && isCompact(lines, index))
      continue // CompactSubObj fixes sub-index 0
    else problems.push({ section: subSection, message: `${where}: the file has no section to hold its value` })
  }

  for (const pdo of [...node.tpdos, ...node.rpdos]) {
    if (!pdo.enabled) continue
    for (const e of pdo.entries) {
      if (!e.alias) continue
      const id = hex4(e.index)
      const subSection = `${id}sub${e.subIndex.toString(16).toUpperCase()}`
      if (lines.find(subSection)) lines.set(subSection, 'Denotation', e.alias, 'ParameterName')
      else if (e.subIndex === 0 && lines.find(id)) lines.set(id, 'Denotation', e.alias, 'ParameterName')
      else if (isCompact(lines, e.index)) setListEntry(lines, `${id}Denotation`, e.subIndex, e.alias)
    }
  }

  const c = 'DeviceComissioning'
  lines.set(c, 'NodeID', String(node.nodeId))
  lines.set(c, 'NodeName', node.name || `node_${node.nodeId}`)
  if (network.bitrate > 0) lines.set(c, 'Baudrate', String(Math.round(network.bitrate / 1000)))
  lines.set(c, 'NetNumber', '1')
  lines.set(c, 'NetworkName', options.networkName || DCF_NETWORK_NAME_DEFAULT)
  lines.set(c, 'CANopenManager', '0')

  const lastEds = node.eds.source?.format === 'dcf' ? lines.get('FileInfo', 'LastEDS') : undefined
  lines.set('FileInfo', 'FileName', fileName)
  lines.set('FileInfo', 'LastEDS', lastEds || node.eds.source?.fileName || node.eds.fileName)
  lines.set('FileInfo', 'ModifiedBy', DCF_MODIFIED_BY)
  lines.set('FileInfo', 'ModificationDate', cia306Date(options.now))
  lines.set('FileInfo', 'ModificationTime', cia306Time(options.now))

  const comment = [`${COMMENT_MARK} node ${node.nodeId} (${node.name}), exported by ${DCF_MODIFIED_BY}.`]
  comment.push(`${COMMENT_MARK} ParameterValue is the value each object holds after the master's configuration.`)
  if (!node.configure) comment.push(`${COMMENT_MARK} The master does not configure this node; it writes no values.`)
  if (node.configure && node.restoreDefaults > 0)
    comment.push(
      `${COMMENT_MARK} Boot step before the configuration (a command, not a value): restore ${restoreChoiceName(node.restoreDefaults).toLowerCase()} (0x1011 sub ${node.restoreDefaults}).`,
    )
  lines.lines.unshift(...comment.map((text) => ({ text, touched: true })))

  const text = lines.text()
  const touched = lines.touchedLines()
  // Only what the export adds counts: a finding the stored file already has (a key missing from
  // [FileInfo], for one) is not the export's error even when it points at a line the export wrote.
  const before = new Set(checkEds(readEdsDocument(storedText)).findings.map(findingKey))
  const errors = checkEds(readEdsDocument(text))
    .findings.filter((f) => {
      if (before.has(findingKey(f))) return false
      if (f.key && f.section) return lines.written.has(`${f.section.toUpperCase()}|${f.key.toLowerCase()}`)
      return f.line !== undefined && touched.has(f.line)
    })
    .map((f): Cia306Finding => ({ ...f, severity: 'error' }))
  return { fileName, text, errors, problems }
}

/**
 * The mapping of each active PDO the build does not map (the device fixes it), as the values the
 * node holds, so a DCF read back gives the same entries.
 */
function fixedMappingValues(
  node: CanopenNode,
  written: ReadonlyMap<string, unknown>,
): Array<{ index: number; subIndex: number; data: string }> {
  const out: Array<{ index: number; subIndex: number; data: string }> = []
  const pdos = [
    ...node.tpdos.map((p) => ({ p, direction: 'input' as const })),
    ...node.rpdos.map((p) => ({ p, direction: 'output' as const })),
  ]
  for (const { p, direction } of pdos) {
    if (!pdoActive(p)) continue
    const { map } = pdoObjectIndices(direction, p.number)
    if (written.has(objectRef(map, 0))) continue
    out.push({ index: map, subIndex: 0, data: leHex(p.entries.length, 1) })
    p.entries.forEach((e, k) => {
      const value = ((e.index << 16) | (e.subIndex << 8) | canopenTypeBits(e.dataType)) >>> 0
      out.push({ index: map, subIndex: k + 1, data: leHex(value, 4) })
    })
  }
  return out
}

function leHex(value: number, bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i++) out += ((value >>> (8 * i)) & 0xff).toString(16).padStart(2, '0')
  return out
}

function findingKey(f: Cia306Finding): string {
  return `${f.rule}|${(f.section ?? '').toUpperCase()}|${(f.key ?? '').toLowerCase()}`
}

function setListEntry(lines: Lines, section: string, subIndex: number, value: string): void {
  lines.set(section, String(subIndex), value)
  const where = lines.find(section)
  if (!where) return
  let count = 0
  for (let i = where[0] + 1; i < where[1]; i++) if (/^\s*\d+\s*=/.test(lines.lines[i].text)) count++
  lines.set(section, 'NrOfEntries', String(count))
}

export interface NetworkDcfExport {
  files: DcfExport[]
  /** Nodes without a stored device file; they need "Replace EDS..." first. */
  missing: CanopenNode[]
}

/** The DCF of every node of the network. */
export function buildNetworkDcfs(config: CanopenConfig, options: DcfExportOptions): NetworkDcfExport {
  const files: DcfExport[] = []
  const missing: CanopenNode[] = []
  for (const node of config.nodes) {
    const stored = node.eds.source ? config.files?.[node.eds.source.sha256] : undefined
    if (!stored) missing.push(node)
    else files.push(buildNodeDcf(node, stored.text, config, options))
  }
  return { files, missing }
}

/** Whether every file can be saved. */
export function dcfExportOk(files: readonly DcfExport[]): boolean {
  return files.every((f) => f.errors.length === 0 && f.problems.length === 0)
}

/** A zip of the files, for "Export network as DCF files...". */
export async function dcfZip(files: readonly DcfExport[]): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const f of files) zip.file(f.fileName, f.text)
  return zip.generateAsync({ type: 'uint8array' })
}
