/**
 * XDD and XDC (CiA 311) parser: the device identity, the object dictionary from the communication
 * network profile, the device profile's parameter details (label, description, unit, scaling,
 * value meanings, bit names, groups), and an XDC's commissioning and actual values. Pure.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser'

import type {
  CanopenAccess,
  CanopenDeviceDetails,
  CanopenEdsInfo,
  CanopenObject,
  CanopenObjectInfo,
  CanopenValueMeaning,
} from '../../ports/canopen-types'
import { CANOPEN_BITRATES, CANOPEN_TYPE_CODES } from './data-types'
import type { DcfContent } from './dcf-import'
import { EdsParseError, parseEdsInteger } from './eds-parser'

export type XmlNode = { [key: string]: XmlValue }
export type XmlValue = string | number | boolean | XmlNode | XmlValue[]

const REPEATED = new Set([
  'ISO15745Profile',
  'parameter',
  'CANopenObject',
  'CANopenSubObject',
  'label',
  'description',
  'value',
  'enumValue',
  'enum',
  'struct',
  'varDeclaration',
  'parameterGroup',
  'parameterRef',
  'supportedBaudRate',
  'characteristic',
  'characteristicContent',
  'property',
  'range',
  'array',
  'derived',
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  textNodeName: '#text',
  isArray: (name) => REPEATED.has(name),
})

function isNode(v: XmlValue | undefined): v is XmlNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  const v = node?.[name]
  if (Array.isArray(v)) return v.find(isNode)
  return isNode(v) ? v : undefined
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  const v = node?.[name]
  if (Array.isArray(v)) return v.filter(isNode)
  return isNode(v) ? [v] : []
}

export function attr(node: XmlNode | undefined, name: string): string | undefined {
  const v = node?.[`@_${name}`]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

function text(node: XmlNode | undefined, name: string): string | undefined {
  const v = node?.[name]
  const first = Array.isArray(v) ? v[0] : v
  if (typeof first === 'string') return first.trim()
  if (isNode(first)) {
    const t = first['#text']
    return typeof t === 'string' ? t.trim() : undefined
  }
  return undefined
}

/** The text of the `label` (or `description`) in @p lang, else the first one. */
function pickLang(node: XmlNode | undefined, name: 'label' | 'description', lang: string): string | undefined {
  const all = children(node, name)
  const hit = all.find((l) => attr(l, 'lang')?.toLowerCase().startsWith(lang)) ?? all[0]
  if (!hit) return undefined
  const t = hit['#text']
  const s = typeof t === 'string' ? t.trim() : ''
  return s === '' ? undefined : s
}

export const IEC_TYPES: Record<string, string> = {
  BOOL: 'BOOLEAN',
  SINT: 'INTEGER8',
  INT: 'INTEGER16',
  DINT: 'INTEGER32',
  LINT: 'INTEGER64',
  USINT: 'UNSIGNED8',
  BYTE: 'UNSIGNED8',
  UINT: 'UNSIGNED16',
  WORD: 'UNSIGNED16',
  UDINT: 'UNSIGNED32',
  DWORD: 'UNSIGNED32',
  ULINT: 'UNSIGNED64',
  LWORD: 'UNSIGNED64',
  REAL: 'REAL32',
  LREAL: 'REAL64',
  STRING: 'VISIBLE_STRING',
  WSTRING: 'UNICODE_STRING',
  BITSTRING: 'BITSTRING',
  CHAR: 'UNSIGNED8',
}

const IEC_BITS: Record<string, number> = { BOOL: 1, BITSTRING: 1, SINT: 8, USINT: 8, BYTE: 8, CHAR: 8 }

export function iecType(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined
  return Object.keys(IEC_TYPES).find((k) => k in node)
}

const PARAM_ACCESS: Record<string, CanopenAccess> = {
  const: 'const',
  read: 'ro',
  write: 'wo',
  readWrite: 'rw',
  readWriteInput: 'rww',
  readWriteOutput: 'rwr',
}

const OBJ_ACCESS: readonly CanopenAccess[] = ['ro', 'wo', 'rw', 'rwr', 'rww', 'const']

function typeName(code: number): string {
  return CANOPEN_TYPE_CODES[code] ?? `0x${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function hex(text: string | undefined): number | null {
  if (text === undefined || !/^[0-9a-f]+$/i.test(text)) return null
  return parseInt(text, 16)
}

function num(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

interface DataTypes {
  enums: Map<string, CanopenValueMeaning[]>
  structs: Map<string, CanopenValueMeaning[]>
}

function readDataTypes(ap: XmlNode | undefined, lang: string): DataTypes {
  const list = child(ap, 'dataTypeList')
  const enums = new Map<string, CanopenValueMeaning[]>()
  for (const e of children(list, 'enum')) {
    const id = attr(e, 'uniqueID')
    if (!id) continue
    enums.set(
      id,
      children(e, 'enumValue').map((v, i) => ({
        value: attr(v, 'value') ?? String(i),
        label: pickLang(v, 'label', lang) ?? attr(v, 'name') ?? '',
      })),
    )
  }
  const structs = new Map<string, CanopenValueMeaning[]>()
  for (const s of children(list, 'struct')) {
    const id = attr(s, 'uniqueID')
    if (!id) continue
    let bit = 0
    const bits: CanopenValueMeaning[] = []
    for (const v of children(s, 'varDeclaration')) {
      const size = num(attr(v, 'size')) ?? 1
      const width = (IEC_BITS[iecType(v) ?? ''] ?? 8) * size
      const label = pickLang(v, 'label', lang) ?? attr(v, 'name') ?? ''
      const isBitField = (iecType(v) ?? '') in { BOOL: 1, BITSTRING: 1 }
      if (isBitField && label !== '')
        bits.push(width > 1 ? { value: String(bit), label, width } : { value: String(bit), label })
      bit += width
    }
    structs.set(id, bits)
  }
  return { enums, structs }
}

interface ParamInfo {
  info: CanopenObjectInfo
  dataType?: string
  access?: CanopenAccess
  defaultValue?: string
  actualValue?: string
}

function readParameters(ap: XmlNode | undefined, lang: string): Map<string, ParamInfo> {
  const types = readDataTypes(ap, lang)
  const groups = new Map<string, string>()
  const walk = (g: XmlNode, top: string | undefined): void => {
    const name = top ?? pickLang(g, 'label', lang) ?? attr(g, 'uniqueID')
    for (const ref of children(g, 'parameterRef')) {
      const id = attr(ref, 'uniqueIDRef')
      if (id && name && !groups.has(id)) groups.set(id, name)
    }
    for (const sub of children(g, 'parameterGroup')) walk(sub, name)
  }
  for (const g of children(child(ap, 'parameterGroupList'), 'parameterGroup')) walk(g, undefined)

  const out = new Map<string, ParamInfo>()
  for (const p of children(child(ap, 'parameterList'), 'parameter')) {
    const id = attr(p, 'uniqueID')
    if (!id) continue
    const info: CanopenObjectInfo = {}
    const label = pickLang(p, 'label', lang)
    const description = pickLang(p, 'description', lang)
    if (label) info.label = label
    if (description) info.description = description
    const unit = child(p, 'unit')
    const unitLabel = pickLang(unit, 'label', lang)
    if (unitLabel) info.unit = unitLabel
    const multiplier = num(attr(unit, 'multiplier')) ?? num(attr(p, 'multiplier'))
    if (multiplier !== undefined && multiplier !== 1) info.multiplier = multiplier
    const offset = num(attr(p, 'offset'))
    if (offset !== undefined && offset !== 0) info.offset = offset
    const allowed = child(p, 'allowedValues')
    const values = children(allowed, 'value')
      .map((v) => ({ value: attr(v, 'value') ?? '', label: pickLang(v, 'label', lang) ?? '' }))
      .filter((v) => v.label !== '')
    const range = children(allowed, 'range')[0]
    if (range) {
      const min = attr(child(range, 'minValue'), 'value')
      const max = attr(child(range, 'maxValue'), 'value')
      if (min !== undefined) info.min = min
      if (max !== undefined) info.max = max
    }
    const typeRef = attr(child(p, 'dataTypeIDRef'), 'uniqueIDRef')
    const enumValues = typeRef ? types.enums.get(typeRef) : undefined
    if (values.length > 0) info.values = values
    else if (enumValues && enumValues.length > 0) info.values = enumValues
    const bits = typeRef ? types.structs.get(typeRef) : undefined
    if (bits && bits.length > 0) info.bits = bits
    const group = groups.get(id)
    if (group) info.group = group
    const iec = iecType(p)
    out.set(id, {
      info,
      dataType: iec ? IEC_TYPES[iec] : undefined,
      access: PARAM_ACCESS[attr(p, 'access') ?? ''],
      defaultValue: attr(child(p, 'defaultValue'), 'value'),
      actualValue: attr(child(p, 'actualValue'), 'value'),
    })
  }
  return out
}

/** An XDC's commissioning and the actual values of its objects. */
export interface XdcContent {
  nodeId?: number
  nodeName?: string
  bitrate?: number
  networkName?: string
  /** Actual value per `0xIIII:SS`. */
  actualValues: Map<string, string>
  /** Denotation per `0xIIII:SS`. */
  denotations: Map<string, string>
}

export interface XddReadResult {
  eds: CanopenEdsInfo
  xdc: XdcContent
}

/** Whether @p text looks like a CANopen XDD/XDC (and not a POWERLINK one). */
export function isCanopenXdd(text: string): boolean {
  return /ISO15745ProfileContainer/.test(text) && !/ethernet-powerlink\.org/.test(text)
}

export function profileBodies(root: XmlNode): XmlNode[] {
  return children(root, 'ISO15745Profile')
    .map((p) => child(p, 'ProfileBody'))
    .filter((b): b is XmlNode => b !== undefined)
}

export function bodyType(body: XmlNode): string {
  return (attr(body, 'type') ?? '').replace(/^.*:/, '')
}

function key(index: number, sub: number): string {
  return `0x${index.toString(16).toUpperCase().padStart(4, '0')}:${sub.toString(16).toUpperCase().padStart(2, '0')}`
}

export function bitrateOf(text: string): number | undefined {
  const t = text.replace(/\s+/g, '')
  if (/^\d+$/.test(t)) return Number(t) * 1000
  const m = /^(\d+)([KM]?)bps$/i.exec(t)
  if (!m) return undefined
  const n = Number(m[1])
  return m[2].toUpperCase() === 'M' ? n * 1_000_000 : m[2].toUpperCase() === 'K' ? n * 1000 : n
}

export interface XddTree {
  root: XmlNode
  device?: XmlNode
  network?: XmlNode
  /** The CiA 311 namespace URI, '' when the file has none. */
  namespace: string
}

/** The profile container and its bodies. Throws {@link EdsParseError} when it is not a CANopen XDD/XDC. */
export function readXddTree(text: string): XddTree {
  if (!isCanopenXdd(text)) throw new EdsParseError('the file is not a CANopen XDD or XDC (CiA 311)')
  const valid = XMLValidator.validate(text)
  if (valid !== true) throw new EdsParseError(`the XML is broken at line ${valid.err.line}: ${valid.err.msg}`)
  const doc = parser.parse(text) as XmlNode
  const root = child(doc, 'ISO15745ProfileContainer')
  if (!root) throw new EdsParseError('the file has no ISO15745ProfileContainer root')
  const bodies = profileBodies(root)
  return {
    root,
    device: bodies.find((b) => bodyType(b).startsWith('ProfileBody_Device')),
    network: bodies.find((b) => bodyType(b).startsWith('ProfileBody_CommunicationNetwork')),
    namespace: (/xmlns(?::\w+)?="(http:\/\/www\.canopen\.org\/xml\/[\d.]+)"/.exec(text) ?? [])[1] ?? '',
  }
}

/** Parses an XDD or XDC. Throws {@link EdsParseError} when it is not a CANopen XDD/XDC. */
export function parseXdd(textIn: string, fileName: string, lang = 'en'): XddReadResult {
  const { device, network } = readXddTree(textIn)
  if (!network) throw new EdsParseError('the file has no CANopen communication network profile')

  const params = readParameters(child(device, 'ApplicationProcess'), lang)
  const identity = child(device, 'DeviceIdentity')
  const layers = child(network, 'ApplicationLayers')
  const xdc: XdcContent = { actualValues: new Map(), denotations: new Map() }

  const objects: CanopenObject[] = []
  const toObject = (
    el: XmlNode,
    index: number,
    subIndex: number,
    parentName: string | undefined,
  ): CanopenObject | undefined => {
    const p = params.get(attr(el, 'uniqueIDRef') ?? '')
    const code = hex(attr(el, 'dataType'))
    const dataType = code !== null ? typeName(code) : p?.dataType
    const accessText = attr(el, 'accessType')
    const declared = OBJ_ACCESS.find((a) => a === accessText) ?? p?.access ?? 'ro'
    if (!dataType) return undefined
    const pdo = attr(el, 'PDOmapping') ?? 'no'
    // CiA 311 gives a read-write object's PDO direction in PDOmapping, CiA 306 in the access type.
    const access = declared !== 'rw' ? declared : pdo === 'TPDO' ? 'rwr' : pdo === 'RPDO' ? 'rww' : 'rw'
    const o: CanopenObject = {
      index,
      subIndex,
      name: attr(el, 'name') ?? p?.info.label ?? '',
      dataType,
      access,
      pdoMapping: pdo !== 'no',
    }
    const def = attr(el, 'defaultValue') ?? p?.defaultValue
    if (def !== undefined && def !== '') o.defaultValue = def
    if (parentName) o.parentName = parentName
    const low = attr(el, 'lowLimit') ?? p?.info.min
    const high = attr(el, 'highLimit') ?? p?.info.max
    if (low !== undefined) o.lowLimit = low
    if (high !== undefined) o.highLimit = high
    if (p && Object.keys(p.info).length > 0) o.info = p.info
    const actual = attr(el, 'actualValue') ?? p?.actualValue
    if (actual !== undefined) xdc.actualValues.set(key(index, subIndex), actual)
    const denotation = attr(el, 'denotation')
    if (denotation) xdc.denotations.set(key(index, subIndex), denotation)
    return o
  }

  for (const obj of children(child(layers, 'CANopenObjectList'), 'CANopenObject')) {
    const index = hex(attr(obj, 'index'))
    if (index === null) continue
    const objectType = attr(obj, 'objectType') ?? '7'
    // A DOMAIN (2) is read like a VAR, as in an EDS.
    if ((objectType === '7' || objectType === '2') && children(obj, 'CANopenSubObject').length === 0) {
      const o = toObject(obj, index, 0, undefined)
      if (o) objects.push(o)
      continue
    }
    if (objectType !== '7' && objectType !== '8' && objectType !== '9') continue
    const parentName = attr(obj, 'name')
    const parentInfo = params.get(attr(obj, 'uniqueIDRef') ?? '')?.info
    for (const sub of children(obj, 'CANopenSubObject')) {
      const subIndex = hex(attr(sub, 'subIndex'))
      if (subIndex === null) continue
      const o = toObject(sub, index, subIndex, parentName)
      if (!o) continue
      if (parentInfo?.description && !o.info?.description && subIndex > 0)
        o.info = { ...o.info, description: parentInfo.description }
      if (parentInfo?.unit && !o.info?.unit && subIndex > 0) o.info = { ...o.info, unit: parentInfo.unit }
      if (parentInfo?.label) o.info = { ...o.info, parentLabel: parentInfo.label }
      objects.push(o)
    }
  }

  const general = child(child(network, 'NetworkManagement'), 'CANopenGeneralFeatures')
  const has = (i: number): boolean => objects.some((o) => o.index === i)
  const countPdos = (base: number): number => {
    let n = 0
    for (let k = 0; k < 512; k++) if (has(base + k)) n++
    return n
  }
  const supported = children(child(child(network, 'TransportLayers'), 'PhysicalLayer'), 'baudRate')
    .flatMap((b) => children(b, 'supportedBaudRate'))
    .map((b) => bitrateOf(attr(b, 'value') ?? ''))
    .filter((b): b is number => b !== undefined)
  const unsupportedBitrates = supported.length > 0 ? CANOPEN_BITRATES.filter((b) => !supported.includes(b)) : undefined

  const commissioning = child(child(network, 'NetworkManagement'), 'deviceCommissioning')
  if (commissioning) {
    const id = num(attr(commissioning, 'nodeID'))
    if (id !== undefined && id >= 1 && id <= 127) xdc.nodeId = id
    const name = attr(commissioning, 'nodeName')
    if (name) xdc.nodeName = name
    const rate = bitrateOf(attr(commissioning, 'actualBaudRate') ?? '')
    if (rate !== undefined) xdc.bitrate = rate
    const net = attr(commissioning, 'networkName')
    if (net) xdc.networkName = net
  }

  const details: CanopenDeviceDetails = {}
  const orderNumber = text(identity, 'orderNumber')
  if (orderNumber) details.orderNumber = orderNumber
  const productText = pickLang(child(identity, 'productText'), 'label', lang) ?? text(identity, 'productText')
  if (productText) details.productText = productText
  const fileVersion = attr(network, 'fileVersion') ?? attr(device, 'fileVersion')
  if (fileVersion) details.fileVersion = fileVersion
  const created = attr(device, 'fileCreationDate') ?? attr(network, 'fileCreationDate')
  if (created) details.fileCreationDate = created
  const modified = attr(device, 'fileModificationDate') ?? attr(network, 'fileModificationDate')
  if (modified) details.fileModificationDate = modified
  const languages = attr(device, 'supportedLanguages')
  if (languages) details.languages = languages.split(/\s+/).filter((l) => l !== '')
  const characteristics = children(
    child(child(device, 'DeviceFunction'), 'capabilities'),
    'characteristicsList',
  ).flatMap((list) =>
    children(list, 'characteristic').map((c) => ({
      value: pickLang(child(c, 'characteristicName'), 'label', lang) ?? '',
      label: children(c, 'characteristicContent')
        .map((cc) => pickLang(cc, 'label', lang) ?? '')
        .filter((s) => s !== '')
        .join(', '),
    })),
  )
  if (characteristics.length > 0) details.characteristics = characteristics.filter((c) => c.value !== '')

  const intOf = (name: string): number => {
    const t = text(identity, name)
    return t ? (parseEdsInteger(t.startsWith('0x') ? t : `0x${t}`) ?? 0) : 0
  }
  const dflt = (i: number, sub: number): number | null => {
    const v = objects.find((o) => o.index === i && o.subIndex === sub)?.defaultValue
    return v === undefined ? null : parseEdsInteger(v)
  }
  const device1000 = objects.find((o) => o.index === 0x1000 && o.subIndex === 0)
  const eds: CanopenEdsInfo = {
    fileName,
    vendorName: text(identity, 'vendorName') ?? '',
    productName: text(identity, 'productName') ?? '',
    deviceType: parseEdsInteger(device1000?.defaultValue ?? '0') ?? 0,
    vendorId: dflt(0x1018, 1) ?? intOf('vendorID'),
    productCode: dflt(0x1018, 2) ?? intOf('productID'),
    revision: dflt(0x1018, 3) ?? 0,
    rxPdoCount: num(attr(general, 'nrOfRxPDO')) ?? countPdos(0x1400),
    txPdoCount: num(attr(general, 'nrOfTxPDO')) ?? countPdos(0x1800),
    objects,
  }
  if (unsupportedBitrates && unsupportedBitrates.length > 0) eds.unsupportedBitrates = unsupportedBitrates
  const dummies = children(child(layers, 'dummyUsage'), 'dummy')
    .map((d) => /^Dummy000([1-7])=1$/i.exec((attr(d, 'entry') ?? '').replace(/\s+/g, '')))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
  if (dummies.length > 0) eds.dummyUsage = [...new Set(dummies)].sort((a, b) => a - b)
  if (Object.keys(details).length > 0) eds.details = details
  return { eds, xdc }
}

/** The XDC part in the shape the DCF import takes. */
export function xdcToDcfContent(xdc: XdcContent): DcfContent {
  const values = [...xdc.actualValues].map(([ref, value]) => {
    const [i, sub] = ref.slice(2).split(':')
    return { index: parseInt(i, 16), subIndex: parseInt(sub, 16), value }
  })
  const hasCommissioning = xdc.nodeId !== undefined || xdc.nodeName !== undefined || xdc.bitrate !== undefined
  return {
    values,
    denotations: xdc.denotations,
    commissioning: hasCommissioning
      ? {
          nodeId: xdc.nodeId,
          nodeName: xdc.nodeName,
          baudrateKbit: xdc.bitrate !== undefined ? xdc.bitrate / 1000 : undefined,
          networkName: xdc.networkName,
        }
      : undefined,
  }
}
