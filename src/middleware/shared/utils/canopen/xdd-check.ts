/**
 * CiA 311 check of XDD and XDC files: the profile container and bodies, references, data types,
 * access, PDO mapping, object types, values and limits, sub-index counts, and the communication
 * object rules of the EDS check. As for an EDS, only errors in the communication area
 * (0x1000-0x1FFF) that are not only about limits block; everything else is a warning.
 */

import type { CanopenEdsInfo } from '../../ports/canopen-types'
import { CANOPEN_BITRATES } from './data-types'
import { CIA306_RULES, type Cia306Finding, commDataType, findingPlace, ruleClause } from './eds-check'
import { EdsParseError } from './eds-parser'
import { EDS_TYPES, edsValueSpan, isEdsOctets, parseEdsIntegerText, parseEdsReal } from './eds-values'
import {
  attr,
  bitrateOf,
  child,
  children,
  IEC_TYPES,
  iecType,
  readXddTree,
  type XmlNode,
  type XmlValue,
} from './xdd-parser'

type Blocks = 'never' | 'comm' | 'always'

interface RuleDef {
  clause: string
  title: string
  blocks: Blocks
  limitOnly?: boolean
}

export const CIA311_RULES = {
  'xml-syntax': { clause: 'CiA 311', title: 'The file is well-formed XML', blocks: 'always' },
  'profile-container': {
    clause: 'CiA 311',
    title: 'The file is an ISO 15745 profile container with a CANopen device and network profile',
    blocks: 'always',
  },
  'device-profile': { clause: 'CiA 311', title: 'The file has a CANopen device profile', blocks: 'never' },
  namespace: { clause: 'CiA 311', title: 'The file uses the CiA 311 version 1.1 namespace', blocks: 'never' },
  'unique-id-ref': { clause: 'CiA 311', title: 'Every uniqueIDRef names an existing element', blocks: 'never' },
  'duplicate-id': { clause: 'CiA 311', title: 'Every uniqueID appears once', blocks: 'never' },
  'duplicate-object': { clause: 'CiA 311', title: 'Each index and sub-index is described once', blocks: 'comm' },
  'object-type': {
    clause: 'CiA 311',
    title: 'objectType is 2 (DOMAIN) or 7 (VAR) without sub-objects, or 8 (ARRAY) or 9 (RECORD) with them',
    blocks: 'never',
  },
  'data-type': { clause: 'CiA 311', title: 'Objects with a value have a data type', blocks: 'comm' },
  'type-mismatch': {
    clause: 'CiA 311',
    title: "An object's data type code agrees with its parameter's type",
    blocks: 'comm',
  },
  'access-type': { clause: 'CiA 311', title: 'accessType is ro, wo, rw or const', blocks: 'comm' },
  'pdo-mapping': {
    clause: 'CiA 311',
    title: 'PDOmapping is no, default, optional, TPDO or RPDO',
    blocks: 'never',
  },
  'sub-number': { clause: 'CiA 311', title: 'subNumber counts the sub-objects described', blocks: 'never' },
  'sub-zero': {
    clause: 'CiA 301',
    title: 'Sub-index 0 of an ARRAY or RECORD is its highest sub-index',
    blocks: 'comm',
  },
  'value-syntax': { clause: 'CiA 311', title: 'Values are written as their data type requires', blocks: 'comm' },
  'value-range': { clause: 'CiA 311', title: 'Values fit their data type', blocks: 'comm' },
  'value-limits': {
    clause: 'CiA 311',
    title: 'Values lie within lowLimit and highLimit',
    blocks: 'never',
    limitOnly: true,
  },
  'limit-syntax': {
    clause: 'CiA 311',
    title: 'lowLimit and highLimit are numbers that fit the data type',
    blocks: 'never',
    limitOnly: true,
  },
  'unknown-attribute': {
    clause: 'CiA 311',
    title: 'Objects carry only the attributes CiA 311 defines',
    blocks: 'never',
  },
  'mandatory-objects': { clause: 'CiA 301', title: 'Mandatory objects are 0x1000, 0x1001 and 0x1018', blocks: 'never' },
  'comm-data-type': {
    clause: 'CiA 301',
    title: 'Communication objects the master writes have their CiA 301 data types',
    blocks: 'comm',
  },
  'mapping-entry': {
    clause: 'CiA 301',
    title: 'A PDO mapping entry names a described object with its length',
    blocks: 'never',
  },
  commissioning: {
    clause: 'CiA 311',
    title: 'deviceCommissioning has a node ID of 1 to 127 and a CiA 301 bit rate',
    blocks: 'never',
  },
} as const satisfies Record<string, RuleDef>

export type Cia311RuleId = keyof typeof CIA311_RULES

export interface Cia311Finding {
  standard: 'CiA 311'
  rule: Cia311RuleId
  severity: 'error' | 'warning'
  /** "0x1A00 sub 1", "deviceCommissioning" or the like. */
  element?: string
  line?: number
  index?: number
  message: string
}

/** A finding of the CiA 306 (EDS, DCF) or CiA 311 (XDD, XDC) check. */
export type DeviceFileFinding = Cia306Finding | Cia311Finding

export interface DeviceFileCheckResult {
  findings: DeviceFileFinding[]
  /** True when no finding is an error. */
  ok: boolean
}

export function isCia311Finding(f: DeviceFileFinding): f is Cia311Finding {
  return 'standard' in f
}

/** The rule's title, for either check. */
export function deviceFindingTitle(f: DeviceFileFinding): string {
  return isCia311Finding(f) ? CIA311_RULES[f.rule].title : CIA306_RULES[f.rule].title
}

/** "CiA 311", "CiA 301" or "CiA 306 4.6.3.2". */
export function deviceFindingClause(f: DeviceFileFinding): string {
  return isCia311Finding(f) ? CIA311_RULES[f.rule].clause : ruleClause(f.rule)
}

/** "0x1A00 sub 1 line 12", "[1A00sub0] DataType line 12" or "file". */
export function deviceFindingPlace(f: DeviceFileFinding): string {
  if (!isCia311Finding(f)) return findingPlace(f)
  const parts: string[] = []
  if (f.element !== undefined) parts.push(f.element)
  if (f.line !== undefined) parts.push(`line ${f.line}`)
  return parts.length > 0 ? parts.join(' ') : 'file'
}

const NS_11 = 'http://www.canopen.org/xml/1.1'
const NS_10 = 'http://www.canopen.org/xml/1.0'
const OBJECT_ATTRIBUTES = new Set([
  'index',
  'subIndex',
  'name',
  'objectType',
  'dataType',
  'lowLimit',
  'highLimit',
  'accessType',
  'defaultValue',
  'actualValue',
  'denotation',
  'PDOmapping',
  'objFlags',
  'uniqueIDRef',
  'subNumber',
  'rangeSelector',
])
const ACCESS = ['ro', 'wo', 'rw', 'const']
const PDO_MAPPING = ['no', 'default', 'optional', 'TPDO', 'RPDO']
const COMM_FIRST = 0x1000
const COMM_LAST = 0x1fff

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hex4(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
}

function typeLabel(code: number): string {
  return EDS_TYPES[code]?.name ?? hex4(code)
}

class Checker {
  readonly findings: Cia311Finding[] = []
  private readonly lineStarts: number[] = [0]
  private cursor = 0

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1)
  }

  /** Line of the next match of @p pattern from the last found place (or the start). */
  lineOf(pattern: RegExp, from: 'start' | 'cursor' = 'cursor'): number | undefined {
    const re = new RegExp(pattern.source, 'g')
    re.lastIndex = from === 'start' ? 0 : this.cursor
    const m = re.exec(this.text)
    if (!m) return undefined
    if (from === 'cursor') this.cursor = m.index + 1
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.lineStarts[mid] <= m.index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  add(rule: Cia311RuleId, message: string, where: { element?: string; line?: number; index?: number } = {}): void {
    const def: RuleDef = CIA311_RULES[rule]
    const comm = where.index !== undefined && where.index >= COMM_FIRST && where.index <= COMM_LAST
    const blocks = def.blocks === 'always' || (def.blocks === 'comm' && comm && !def.limitOnly)
    this.findings.push({ standard: 'CiA 311', rule, severity: blocks ? 'error' : 'warning', ...where, message })
  }
}

function attributeNames(node: XmlNode): string[] {
  return Object.keys(node)
    .filter((k) => k.startsWith('@_'))
    .map((k) => k.slice(2))
}

function hexAttr(text: string | undefined): number | null {
  return text !== undefined && /^[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : null
}

/** The uniqueIDs of every element, and those seen twice. */
function collectIds(node: XmlValue, ids: Set<string>, twice: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectIds(n, ids, twice)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const id = node['@_uniqueID']
  if (typeof id === 'string') {
    if (ids.has(id)) twice.add(id)
    ids.add(id)
  }
  for (const [k, v] of Object.entries(node)) if (!k.startsWith('@_')) collectIds(v, ids, twice)
}

/** Every `uniqueIDRef` and `dataTypeIDRef` element's reference, with where it is used. */
function collectRefs(node: XmlValue, out: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, out)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const ref = node['@_uniqueIDRef']
  if (typeof ref === 'string') out.push(ref)
  for (const [k, v] of Object.entries(node)) if (!k.startsWith('@_')) collectRefs(v, out)
}

interface Where {
  element: string
  line?: number
  index: number
}

function checkValue(
  c: Checker,
  code: number,
  name: string,
  value: string,
  where: Where,
  limits: { low?: string; high?: string },
): void {
  const type = EDS_TYPES[code]
  if (!type || value === '') return
  if (type.range) {
    const v = parseEdsIntegerText(value)
    if (!v) {
      c.add('value-syntax', `${name} "${value}" is not a ${type.name} number`, where)
      return
    }
    const [lo, hi] = edsValueSpan(v)
    if (lo < type.range[0] || hi > type.range[1]) {
      c.add('value-range', `${name} ${value} is outside ${type.name}`, where)
      return
    }
    const low = limits.low ? parseEdsIntegerText(limits.low) : null
    const high = limits.high ? parseEdsIntegerText(limits.high) : null
    if (low && edsValueSpan(low)[0] > lo)
      c.add('value-limits', `${name} ${value} is below lowLimit ${limits.low}`, where)
    else if (high && edsValueSpan(high)[1] < hi)
      c.add('value-limits', `${name} ${value} is above highLimit ${limits.high}`, where)
    return
  }
  if (type.real) {
    const v = parseEdsReal(value, type.real)
    if (v === null) c.add('value-syntax', `${name} "${value}" is not a ${type.name} number`, where)
    return
  }
  if (type.octets && code !== 0x0009 && code !== 0x000b && !isEdsOctets(value))
    c.add('value-syntax', `${name} "${value}" is not hexadecimal bytes (${type.name})`, where)
}

function checkLimits(c: Checker, code: number, el: XmlNode, where: Where): void {
  const type = EDS_TYPES[code]
  if (!type?.range) return
  for (const key of ['lowLimit', 'highLimit']) {
    const v = attr(el, key)
    if (v === undefined || v === '') continue
    const n = parseEdsIntegerText(v)
    if (!n) c.add('limit-syntax', `${key} "${v}" is not a number`, where)
    else {
      const [lo, hi] = edsValueSpan(n)
      if (lo < type.range[0] || hi > type.range[1]) c.add('limit-syntax', `${key} ${v} is outside ${type.name}`, where)
    }
  }
}

interface ParamType {
  iec?: string
  defaultValue?: string
  actualValue?: string
}

function parameterTypes(device: XmlNode | undefined): Map<string, ParamType> {
  const out = new Map<string, ParamType>()
  const list = child(child(device, 'ApplicationProcess'), 'parameterList')
  for (const p of children(list, 'parameter')) {
    const id = attr(p, 'uniqueID')
    if (!id) continue
    out.set(id, {
      iec: iecType(p),
      defaultValue: attr(child(p, 'defaultValue'), 'value'),
      actualValue: attr(child(p, 'actualValue'), 'value'),
    })
  }
  return out
}

function iecCode(iec: string): number | undefined {
  const name = IEC_TYPES[iec]
  const hit = Object.entries(EDS_TYPES).find(([, t]) => t.name === name)
  return hit ? Number(hit[0]) : undefined
}

/** Data type codes that an IEC type of a parameter may stand for. */
function iecFits(iec: string, code: number): boolean {
  const want = iecCode(iec)
  if (want === undefined || want === code) return true
  // BITSTRING and the byte/word types describe any unsigned or bit field of their size.
  const loose: Record<string, number[]> = {
    BITSTRING: [0x0001, 0x0005, 0x0006, 0x0007, 0x001b, 0x000a, 0x000f],
    BYTE: [0x0005],
    WORD: [0x0006],
    DWORD: [0x0007],
    LWORD: [0x001b],
    CHAR: [0x0005, 0x0009],
    STRING: [0x0009, 0x000a],
  }
  return loose[iec]?.includes(code) ?? false
}

function checkObjectEl(
  c: Checker,
  el: XmlNode,
  index: number,
  subIndex: number,
  params: Map<string, ParamType>,
  ids: ReadonlySet<string>,
  line: number | undefined,
): void {
  const element = subIndex === 0 && !('@_subIndex' in el) ? hex4(index) : `${hex4(index)} sub ${subIndex}`
  const where: Where = { element, line, index }
  for (const name of attributeNames(el))
    if (!OBJECT_ATTRIBUTES.has(name))
      c.add('unknown-attribute', `attribute "${name}" is not a CiA 311 attribute`, where)
  const ref = attr(el, 'uniqueIDRef')
  const param = ref ? params.get(ref) : undefined
  if (ref && !ids.has(ref))
    c.add(
      'unique-id-ref',
      `${element} refers to parameter "${ref}", which does not exist; the object keeps the type and access of the object list`,
      where,
    )
  const dtText = attr(el, 'dataType')
  const code = hexAttr(dtText)
  if (dtText !== undefined && (code === null || code === 0 || dtText.length !== 4))
    c.add('data-type', `dataType "${dtText}" is not a 4-digit data type index`, where)
  else if (dtText === undefined && !param?.iec)
    c.add('data-type', 'the object has no dataType and no parameter with a type', where)
  if (code !== null && param?.iec && !iecFits(param.iec, code))
    c.add(
      'type-mismatch',
      `dataType ${dtText} (${typeLabel(code)}) does not agree with its parameter's ${param.iec}`,
      where,
    )
  const access = attr(el, 'accessType')
  if (access !== undefined && !ACCESS.includes(access))
    c.add('access-type', `accessType "${access}" is not ro, wo, rw or const`, where)
  const pdo = attr(el, 'PDOmapping')
  if (pdo !== undefined && !PDO_MAPPING.includes(pdo))
    c.add('pdo-mapping', `PDOmapping "${pdo}" is not no, default, optional, TPDO or RPDO`, where)
  const effective = code ?? (param?.iec ? iecCode(param.iec) : undefined)
  if (effective === undefined) return
  const want = commDataType(index, subIndex)
  if (want !== undefined && effective !== want)
    c.add('comm-data-type', `the data type is ${typeLabel(effective)}; CiA 301 gives ${typeLabel(want)}`, where)
  checkLimits(c, effective, el, where)
  const limits = { low: attr(el, 'lowLimit'), high: attr(el, 'highLimit') }
  const values: Array<[string, string | undefined]> = [
    ['defaultValue', attr(el, 'defaultValue') ?? param?.defaultValue],
    ['actualValue', attr(el, 'actualValue') ?? param?.actualValue],
  ]
  for (const [name, v] of values)
    if (v !== undefined && !/^\$NODEID/i.test(v.trim())) checkValue(c, effective, name, v, where, limits)
}

function checkObjects(c: Checker, network: XmlNode, params: Map<string, ParamType>, ids: ReadonlySet<string>): void {
  const list = child(child(network, 'ApplicationLayers'), 'CANopenObjectList')
  const seen = new Set<string>()
  for (const obj of children(list, 'CANopenObject')) {
    const indexText = attr(obj, 'index')
    const index = hexAttr(indexText)
    const line = c.lineOf(new RegExp(`<(\\w+:)?CANopenObject\\b[^>]*\\bindex="${indexText ?? ''}"`))
    if (index === null) {
      c.add('object-type', `index "${indexText ?? ''}" is not a hexadecimal index`, { line })
      continue
    }
    const element = hex4(index)
    const written = attr(obj, 'objectType') ?? ''
    // A DOMAIN (2) is read like a VAR, as in an EDS.
    const objectType = written === '2' ? '7' : written
    const subs = children(obj, 'CANopenSubObject')
    if (!['7', '8', '9'].includes(objectType)) {
      // NULL (0), DEFTYPE (5) and DEFSTRUCT (6) describe no value the master uses.
      if (!['0', '5', '6'].includes(objectType))
        c.add('object-type', `objectType "${written}" is not 2, 7, 8 or 9`, { element, line, index })
      continue
    }
    if (objectType === '7' && subs.length > 0)
      c.add('object-type', 'a VAR (objectType 7) has sub-objects; they are read as a RECORD', {
        element,
        line,
        index,
      })
    if (objectType === '7' && subs.length === 0) {
      const key = `${index}:0`
      if (seen.has(key)) c.add('duplicate-object', `${element} is described twice`, { element, line, index })
      seen.add(key)
      checkObjectEl(c, obj, index, 0, params, ids, line)
      continue
    }
    for (const name of attributeNames(obj))
      if (!OBJECT_ATTRIBUTES.has(name))
        c.add('unknown-attribute', `attribute "${name}" is not a CiA 311 attribute`, { element, line, index })
    if (subs.length === 0)
      c.add('object-type', `${objectType === '8' ? 'an ARRAY' : 'a RECORD'} without sub-objects`, {
        element,
        line,
        index,
      })
    const subNumber = attr(obj, 'subNumber')
    if (subNumber !== undefined && Number(subNumber) !== subs.length)
      c.add('sub-number', `subNumber is ${subNumber}; ${subs.length} sub-objects are described`, {
        element,
        line,
        index,
      })
    for (const sub of subs) {
      const subText = attr(sub, 'subIndex')
      const subIndex = hexAttr(subText)
      const subLine = c.lineOf(new RegExp(`<(\\w+:)?CANopenSubObject\\b[^>]*\\bsubIndex="${subText ?? ''}"`)) ?? line
      if (subIndex === null || subIndex > 0xff) {
        c.add('object-type', `subIndex "${subText ?? ''}" is not a hexadecimal sub-index`, {
          element,
          line: subLine,
          index,
        })
        continue
      }
      const key = `${index}:${subIndex}`
      if (seen.has(key))
        c.add('duplicate-object', `${element} sub ${subIndex} is described twice`, { element, line: subLine, index })
      seen.add(key)
      checkObjectEl(c, sub, index, subIndex, params, ids, subLine)
    }
    const sub0 = subs.find((s) => hexAttr(attr(s, 'subIndex')) === 0)
    const highest = Math.max(...subs.map((s) => hexAttr(attr(s, 'subIndex')) ?? 0).filter((n) => n <= 0xff))
    const count = Number(attr(sub0 ?? {}, 'defaultValue') ?? NaN)
    // 0x1003 sub 0 counts the errors now in the list; a mapping's sub 0 counts its mapped entries.
    const counts = index === 0x1003 || (index >= 0x1600 && index <= 0x17ff) || (index >= 0x1a00 && index <= 0x1bff)
    if (sub0 && Number.isInteger(count) && count < highest && !counts)
      // Blocks only on objects whose sub-objects the master reads or writes (CiA 301 types known).
      c.add('sub-zero', `sub-index 0 is ${count}, but sub-index ${highest} is described`, {
        element,
        line,
        ...(commDataType(index, 0) !== undefined ? { index } : {}),
      })
  }
  for (const [i, name] of [
    [0x1000, 'device type'],
    [0x1001, 'error register'],
    [0x1018, 'identity'],
  ] as const)
    if (![...seen].some((k) => k.startsWith(`${i}:`)))
      c.add('mandatory-objects', `the file does not describe ${hex4(i)} (${name})`, { index: i })
}

function checkMappingEntries(c: Checker, eds: CanopenEdsInfo): void {
  const bits: Record<string, number> = {
    BOOLEAN: 1,
    INTEGER8: 8,
    UNSIGNED8: 8,
    INTEGER16: 16,
    UNSIGNED16: 16,
    INTEGER32: 32,
    UNSIGNED32: 32,
    REAL32: 32,
    INTEGER64: 64,
    UNSIGNED64: 64,
    REAL64: 64,
  }
  for (const o of eds.objects) {
    const mapping = (o.index >= 0x1600 && o.index <= 0x17ff) || (o.index >= 0x1a00 && o.index <= 0x1bff)
    if (!mapping || o.subIndex === 0 || o.defaultValue === undefined) continue
    const v = parseEdsIntegerText(o.defaultValue)
    if (!v || v.nodeId || v.value === 0n) continue
    const n = Number(v.value)
    const index = Math.floor(n / 0x10000)
    const sub = Math.floor(n / 0x100) % 0x100
    const len = n % 0x100
    if (index < 0x20 && index >= 1) continue // dummy entries
    const element = `${hex4(o.index)} sub ${o.subIndex}`
    const target = eds.objects.find((t) => t.index === index && t.subIndex === sub)
    if (!target)
      c.add('mapping-entry', `${element} maps ${hex4(index)} sub ${sub}, which the file does not describe`, {
        element,
        index: o.index,
      })
    else if (bits[target.dataType] !== undefined && bits[target.dataType] !== len)
      c.add(
        'mapping-entry',
        `${element} maps ${hex4(index)} sub ${sub} with ${len} bits; it has ${bits[target.dataType]}`,
        {
          element,
          index: o.index,
        },
      )
  }
}

function checkCommissioning(c: Checker, network: XmlNode): void {
  const dc = child(child(network, 'NetworkManagement'), 'deviceCommissioning')
  if (!dc) return
  const line = c.lineOf(/<(\w+:)?deviceCommissioning\b/, 'start')
  const where = { element: 'deviceCommissioning', line }
  const id = attr(dc, 'nodeID')
  if (id !== undefined && !(Number(id) >= 1 && Number(id) <= 127 && Number.isInteger(Number(id))))
    c.add('commissioning', `nodeID "${id}" is not 1 to 127; the node ID counts as not set`, where)
  const rate = attr(dc, 'actualBaudRate')
  if (rate !== undefined) {
    const n = bitrateOf(rate)
    if (n === undefined || !CANOPEN_BITRATES.some((b) => b === n))
      c.add('commissioning', `actualBaudRate "${rate}" is not a CiA 301 bit rate`, where)
    else if (/^\s*\d+\s*$/.test(rate))
      c.add('commissioning', `actualBaudRate "${rate}" has no unit; it is read as ${n / 1000} kbit/s`, where)
  }
}

/** Checks an XDD or XDC; @p eds is the description read from it, when it could be read. */
export function checkXdd(text: string, eds?: CanopenEdsInfo): DeviceFileCheckResult {
  const c = new Checker(text)
  let tree
  try {
    tree = readXddTree(text)
  } catch (e) {
    const message = e instanceof EdsParseError ? e.message : String(e)
    const broken = /XML is broken at line (\d+)/.exec(message)
    c.add(broken ? 'xml-syntax' : 'profile-container', message, broken ? { line: Number(broken[1]) } : {})
    return { findings: c.findings, ok: false }
  }
  if (!tree.network) {
    c.add('profile-container', 'the file has no CANopen communication network profile')
    return { findings: c.findings, ok: false }
  }
  if (tree.namespace === NS_10)
    c.add('namespace', 'the file uses the CiA 311 version 1.0 namespace; it is read like version 1.1')
  else if (tree.namespace === '')
    c.add('namespace', 'the file declares no CiA 311 namespace; it is read like version 1.1', {
      line: c.lineOf(/<(\w+:)?ISO15745ProfileContainer\b/, 'start'),
    })
  else if (tree.namespace !== NS_11) c.add('namespace', `the namespace ${tree.namespace} is not CiA 311 version 1.1`)
  if (!tree.device) c.add('device-profile', 'the file has no device profile; objects have no labels or descriptions')

  const ids = new Set<string>()
  const twice = new Set<string>()
  collectIds(tree.root, ids, twice)
  for (const id of twice)
    c.add('duplicate-id', `uniqueID "${id}" appears more than once`, {
      line: c.lineOf(new RegExp(`uniqueID="${escapeRe(id)}"`), 'start'),
    })
  const refs: string[] = []
  collectRefs(tree.device ?? {}, refs)
  for (const ref of new Set(refs)) {
    if (ids.has(ref)) continue
    const line = c.lineOf(new RegExp(`uniqueIDRef="${escapeRe(ref)}"`), 'start')
    c.add('unique-id-ref', `uniqueIDRef "${ref}" in the device profile names no element`, { line })
  }

  checkObjects(c, tree.network, parameterTypes(tree.device), ids)
  if (eds) checkMappingEntries(c, eds)
  checkCommissioning(c, tree.network)
  c.findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  return { findings: c.findings, ok: c.findings.every((f) => f.severity === 'warning') }
}
