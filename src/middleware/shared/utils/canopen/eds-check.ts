/**
 * CiA 306 check of EDS and DCF files. Each rule names its clause (CiA 306 v1.3, or CiA 301 for the
 * data types of communication objects). On import only errors in the communication area
 * (0x1000-0x1FFF) that are not only about limits block; everything else is a warning.
 */

import type { DeviceFileEncoding } from './device-file'
import {
  commissioningSection,
  EDS_MAX_LINE,
  type EdsDocument,
  type EdsReadIssueKind,
  type EdsSection,
} from './eds-document'
import {
  EDS_TYPES,
  type EdsIntegerText,
  type EdsTypeInfo,
  edsValueSpan,
  isEdsOctets,
  parseEdsIntegerText,
  parseEdsReal,
} from './eds-values'

/** When a rule's finding refuses an import. */
type Blocks = 'never' | 'comm' | 'always'

interface RuleDef {
  clause: string
  title: string
  blocks: Blocks
  /** The finding is about limits only (LowLimit, HighLimit), which never block. */
  limitOnly?: boolean
}

export const CIA306_RULES = {
  'file-encoding': { clause: '4.2', title: 'Files are ASCII (ISO 646)', blocks: 'never' },
  'not-ascii': { clause: '4.2', title: 'Files are ASCII (ISO 646)', blocks: 'never' },
  'line-length': { clause: '4.2', title: `Lines are at most ${EDS_MAX_LINE} characters`, blocks: 'never' },
  'trailing-comment': { clause: '4.2', title: 'Comments are whole lines starting with ";"', blocks: 'never' },
  'leftmost-column': {
    clause: '4.2',
    title: '"[" and ";" are in the leftmost column',
    blocks: 'never',
  },
  'not-key-value': { clause: '4.2', title: 'Lines are "keyname=value", sections or comments', blocks: 'never' },
  'outside-section': { clause: '4.2', title: 'Entries belong to a section', blocks: 'never' },
  'unclosed-section': { clause: '4.2', title: 'Section names are enclosed in brackets', blocks: 'never' },
  'duplicate-key': { clause: '4.2', title: 'A key appears once per section', blocks: 'never' },
  'duplicate-section': { clause: '4.2', title: 'A section appears once', blocks: 'never' },
  'unknown-section': { clause: '4.2', title: 'Sections are those CiA 306 defines', blocks: 'never' },
  'unknown-key': { clause: '4.2', title: 'Entries are those CiA 306 defines', blocks: 'never' },
  'file-info': { clause: '4.4', title: '[FileInfo] has the keys CiA 306 lists', blocks: 'never' },
  'date-format': { clause: '4.4', title: 'Dates are mm-dd-yyyy', blocks: 'never' },
  'time-format': { clause: '4.4', title: 'Times are hh:mm followed by AM or PM', blocks: 'never' },
  'text-length': { clause: '4.4', title: 'Texts stay within CiA 306 lengths', blocks: 'never' },
  'device-info-missing': { clause: '4.5', title: 'The file has a [DeviceInfo] section', blocks: 'always' },
  'device-info': { clause: '4.5', title: '[DeviceInfo] has the keys CiA 306 lists', blocks: 'never' },
  'device-info-value': { clause: '4.5', title: '[DeviceInfo] values have their types', blocks: 'never' },
  'compact-pdo': { clause: '4.6.3.4.1', title: 'CompactPDO is an UNSIGNED8 bit mask', blocks: 'never' },
  'dummy-usage': { clause: '4.6.2', title: '[DummyUsage] entries are Dummy<index>=0 or 1', blocks: 'never' },
  'object-list': {
    clause: '4.6.3.1',
    title: 'Object lists count and number their entries',
    blocks: 'never',
  },
  'object-list-place': {
    clause: '4.6.3.1',
    title: 'Objects are listed in the list of their area',
    blocks: 'never',
  },
  'object-section': { clause: '4.6.3.1', title: 'Each listed object has its section', blocks: 'never' },
  'object-unlisted': { clause: '4.6.3.1', title: 'Each object section is listed', blocks: 'never' },
  'mandatory-objects': { clause: '4.6.3.1', title: 'Mandatory objects are 0x1000, 0x1001 (0x1018)', blocks: 'never' },
  'parameter-name': {
    clause: '4.6.3.2',
    title: 'Objects have a ParameterName of up to 241 characters',
    blocks: 'never',
  },
  'object-type': { clause: '4.6.3.2', title: 'ObjectType fits the object', blocks: 'comm' },
  'data-type': { clause: '4.6.3.2', title: 'Objects with a value have a valid DataType', blocks: 'comm' },
  'access-type': {
    clause: '4.6.3.2',
    title: 'Objects with a value have AccessType ro, wo, rw, rwr, rww or const',
    blocks: 'comm',
  },
  'access-type-structured': {
    clause: '4.6.3.2',
    title: 'ARRAY and RECORD objects without CompactSubObj have no AccessType',
    blocks: 'never',
  },
  'sub-number': { clause: '4.6.3.2', title: 'SubNumber counts the sub-objects described', blocks: 'comm' },
  'sub-zero-type': { clause: '4.6.3.2', title: 'Sub-index 0 of ARRAY and RECORD is UNSIGNED8', blocks: 'comm' },
  'sub-object': { clause: '4.6.3.2', title: 'Sub-objects belong to a described object', blocks: 'never' },
  'pdo-mapping': { clause: '4.6.3.2', title: 'PDOMapping is 0 or 1', blocks: 'never' },
  'obj-flags': { clause: '4.6.3.3', title: 'ObjFlags uses only bits 0 and 1', blocks: 'never' },
  'compact-sub-obj': {
    clause: '4.6.3.4.2',
    title: 'CompactSubObj is used on ARRAY or RECORD without SubNumber',
    blocks: 'comm',
  },
  'compact-list': {
    clause: '5.3.3.2',
    title: 'Name, Value and Denotation lists count their entries within CompactSubObj',
    blocks: 'never',
  },
  'object-links': { clause: '4.6.4', title: 'ObjectLinks counts its numbered entries', blocks: 'never' },
  comments: { clause: '4.6.5', title: '[Comments] has Lines and Line<n> of up to 249 characters', blocks: 'never' },
  'value-syntax': { clause: '4.3', title: 'Values are written as their data type requires', blocks: 'comm' },
  'value-range': { clause: '4.3', title: 'Values fit their data type', blocks: 'comm' },
  'value-limits': {
    clause: '4.6.3.2',
    title: 'Values lie within LowLimit and HighLimit',
    blocks: 'never',
    limitOnly: true,
  },
  'limit-syntax': {
    clause: '4.6.3.2',
    title: 'LowLimit and HighLimit are numbers that fit the data type',
    blocks: 'never',
    limitOnly: true,
  },
  'nodeid-formula': { clause: '4.3', title: 'The formula is "$NODEID+n"', blocks: 'never' },
  'octal-number': { clause: '4.3', title: 'A leading 0 makes a number octal', blocks: 'never' },
  'negative-hex': {
    clause: '4.3',
    title: 'Numbers are decimal, hexadecimal or octal; a minus sign before 0x is not described',
    blocks: 'never',
  },
  'comm-data-type': {
    clause: 'CiA 301',
    title: 'Communication objects the master writes have their CiA 301 data types',
    blocks: 'comm',
  },
  commissioning: {
    clause: '5',
    title: '[DeviceComissioning] values have their types and lengths',
    blocks: 'never',
  },
  'commissioning-baudrate': {
    clause: '5',
    title: 'Baudrate is a CiA 301 bit rate the device supports',
    blocks: 'never',
  },
  'value-on-read-only': {
    clause: '5.3.1',
    title: 'A ParameterValue on a read-only object equals its DefaultValue',
    blocks: 'never',
  },
  'mapping-entry': {
    clause: 'CiA 301',
    title: 'A PDO mapping entry names a described object with its length',
    blocks: 'never',
  },
  'modular-device': {
    clause: '6',
    title: 'Objects of extension modules are not read',
    blocks: 'never',
  },
} as const satisfies Record<string, RuleDef>

export type Cia306RuleId = keyof typeof CIA306_RULES

export type Cia306Severity = 'error' | 'warning'

export interface Cia306Finding {
  rule: Cia306RuleId
  severity: Cia306Severity
  /** Section as written, when the finding has one. */
  section?: string
  key?: string
  line?: number
  /** Object index the section describes. */
  index?: number
  message: string
}

export interface EdsCheckResult {
  findings: Cia306Finding[]
  /** True when no finding is an error. */
  ok: boolean
}

export interface EdsCheckOptions {
  encoding?: DeviceFileEncoding
  /** 'dcf' also asks for the sections a DCF has (CiA 306 5). */
  format?: 'eds' | 'dcf'
}

const COMM_FIRST = 0x1000
const COMM_LAST = 0x1fff

const OBJECT_SECTION = /^([0-9A-F]{4})(SUB([0-9A-F]+)|NAME|VALUE|DENOTATION|OBJECTLINKS)?$/

const FILE_INFO_KEYS = [
  'FileName',
  'FileVersion',
  'FileRevision',
  'EDSVersion',
  'Description',
  'CreationTime',
  'CreationDate',
  'CreatedBy',
  'ModificationTime',
  'ModificationDate',
  'ModifiedBy',
  'LastEDS',
]
const FILE_INFO_REQUIRED = FILE_INFO_KEYS.slice(0, 8)

const DEVICE_INFO_KEYS = [
  'VendorName',
  'VendorNumber',
  'ProductName',
  'ProductNumber',
  'RevisionNumber',
  'OrderCode',
  'BaudRate_10',
  'BaudRate_20',
  'BaudRate_50',
  'BaudRate_125',
  'BaudRate_250',
  'BaudRate_500',
  'BaudRate_800',
  'BaudRate_1000',
  'SimpleBootUpMaster',
  'SimpleBootUpSlave',
  'Granularity',
  'DynamicChannelsSupported',
  'GroupMessaging',
  'NrOfRXPDO',
  'NrOfTXPDO',
  'LSS_Supported',
]
const DEVICE_INFO_OPTIONAL = [
  'CompactPDO',
  'ProductVersion',
  'ProductRevision',
  'LMT_ManufacturerName',
  'LMT_ProductName',
  'ExtendedBootUpMaster',
  'ExtendedBootUpSlave',
]
const DEVICE_INFO_BOOLEAN = [
  'BaudRate_10',
  'BaudRate_20',
  'BaudRate_50',
  'BaudRate_125',
  'BaudRate_250',
  'BaudRate_500',
  'BaudRate_800',
  'BaudRate_1000',
  'SimpleBootUpMaster',
  'SimpleBootUpSlave',
  'DynamicChannelsSupported',
  'GroupMessaging',
  'LSS_Supported',
]
const DEVICE_INFO_NUMBER = ['VendorNumber', 'ProductNumber', 'RevisionNumber', 'Granularity', 'NrOfRXPDO', 'NrOfTXPDO']

const COMMISSIONING_KEYS = [
  'NodeID',
  'NodeName',
  'NodeRefd',
  'Baudrate',
  'NetNumber',
  'NetworkName',
  'NetRefd',
  'CANopenManager',
  'LSS_SerialNumber',
]

const OBJECT_KEYS = new Set(
  [
    'SubNumber',
    'ParameterName',
    'ObjectType',
    'DataType',
    'AccessType',
    'LowLimit',
    'HighLimit',
    'DefaultValue',
    'PDOMapping',
    'ObjFlags',
    'CompactSubObj',
    'ParameterValue',
    'UploadFile',
    'DownloadFile',
    'Denotation',
    'ParamRefd',
  ].map((k) => k.toLowerCase()),
)

const ACCESS_TYPES = ['ro', 'wo', 'rw', 'rwr', 'rww', 'const']

/** Sections CiA 306 (or CiA 302/405 by reference) defines besides objects and object lists. */
const OTHER_SECTIONS =
  /^(FILEINFO|DEVICEINFO|DEVICECOMM?ISSIONING|DUMMYUSAGE|COMMENTS|TOOLS|DYNAMICCHANNELS|SUPPORTEDMODULES|CONNECTEDMODULES|M\d+.*)$/
const OBJECT_LISTS = ['MandatoryObjects', 'OptionalObjects', 'ManufacturerObjects']

const DATE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])-\d{4}$/
const TIME = /^(0\d|1[0-2]):[0-5]\d(AM|PM)$/i

/** CiA 306 text lengths, by section and key (lower case). */
const TEXT_LENGTHS: ReadonlyArray<readonly [string, string, number, string]> = [
  ['FILEINFO', 'description', 243, '4.4'],
  ['FILEINFO', 'createdby', 245, '4.4'],
  ['FILEINFO', 'modifiedby', 244, '4.4'],
  ['DEVICEINFO', 'vendorname', 244, '4.5'],
  ['DEVICEINFO', 'productname', 243, '4.5'],
  ['DEVICEINFO', 'ordercode', 245, '4.5'],
]

/** Bit rates of CiA 301 in kbit/s, as DCF Baudrate values. */
export const DCF_BAUDRATES_KBIT = [10, 20, 50, 125, 250, 500, 800, 1000] as const

const U8 = 0x0005
const U16 = 0x0006
const U32 = 0x0007

/** CiA 301 data type of a standard communication sub-object the master reads or writes. */
export function commDataType(index: number, subIndex: number): number | undefined {
  const single: Record<number, number> = {
    0x1000: U32,
    0x1001: U8,
    0x1005: U32,
    0x1006: U32,
    0x1007: U32,
    0x100c: U16,
    0x100d: U8,
    0x1012: U32,
    0x1014: U32,
    0x1015: U16,
    0x1017: U16,
  }
  if (index in single) return subIndex === 0 ? single[index] : undefined
  if (subIndex === 0 && (index === 0x1016 || index === 0x1018 || index === 0x1029)) return U8
  if (index === 0x1016) return U32
  if (index === 0x1018) return subIndex <= 4 ? U32 : undefined
  if (index === 0x1029) return U8
  const pdoComm = (index >= 0x1400 && index <= 0x15ff) || (index >= 0x1800 && index <= 0x19ff)
  if (pdoComm) return [U8, U32, U8, U16, U8, U16, U8][subIndex]
  const pdoMap = (index >= 0x1600 && index <= 0x17ff) || (index >= 0x1a00 && index <= 0x1bff)
  if (pdoMap) return subIndex === 0 ? U8 : subIndex <= 0x40 ? U32 : undefined
  return undefined
}

function hex4(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(4, '0')}`
}

function typeName(code: number): string {
  return EDS_TYPES[code]?.name ?? hex4(code)
}

function inComm(index: number | undefined): boolean {
  return index !== undefined && index >= COMM_FIRST && index <= COMM_LAST
}

function sectionIndex(name: string | undefined): number | undefined {
  if (!name) return undefined
  const m = OBJECT_SECTION.exec(name.toUpperCase())
  return m ? parseInt(m[1], 16) : undefined
}

/** A plain integer (decimal, hex or octal) or undefined. */
function plainInt(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined
  const v = parseEdsIntegerText(text)
  return v && !v.nodeId ? Number(v.value) : undefined
}

interface ValueContext {
  section: EdsSection
  type: EdsTypeInfo | undefined
  typeCode: number
}

class Checker {
  readonly findings: Cia306Finding[] = []

  constructor(readonly doc: EdsDocument) {}

  add(
    rule: Cia306RuleId,
    message: string,
    where: { section?: string; key?: string; line?: number; index?: number } = {},
  ): void {
    const def: RuleDef = CIA306_RULES[rule]
    const index = where.index ?? sectionIndex(where.section)
    const blocking = def.blocks === 'always' || (def.blocks === 'comm' && !def.limitOnly && inComm(index))
    this.findings.push({
      rule,
      severity: blocking ? 'error' : 'warning',
      ...(where.section !== undefined ? { section: where.section } : {}),
      ...(where.key !== undefined ? { key: where.key } : {}),
      ...(where.line !== undefined ? { line: where.line } : {}),
      ...(index !== undefined ? { index } : {}),
      message,
    })
  }

  at(section: EdsSection, key: string): { section: string; key: string; line: number } {
    const entry = section.entries.get(key.toLowerCase())
    return { section: section.name, key: entry?.key ?? key, line: entry?.line ?? section.line }
  }

  get(section: EdsSection | undefined, key: string): string | undefined {
    return section?.entries.get(key.toLowerCase())?.value
  }
}

const READ_ISSUE_RULE: Record<EdsReadIssueKind, Cia306RuleId> = {
  'trailing-comment': 'trailing-comment',
  'not-key-value': 'not-key-value',
  'outside-section': 'outside-section',
  'leftmost-column': 'leftmost-column',
  'duplicate-key': 'duplicate-key',
  'duplicate-section': 'duplicate-section',
  'unclosed-section': 'unclosed-section',
  'line-too-long': 'line-length',
  'not-ascii': 'not-ascii',
}

const READ_ISSUE_TEXT: Record<EdsReadIssueKind, (text: string) => string> = {
  'trailing-comment': (t) => `"${t}" after the value is read as a comment and ignored`,
  'not-key-value': (t) => `"${t}" is not "keyname=value"; the line is ignored`,
  'outside-section': (t) => `"${t}" is before any section; the line is ignored`,
  'leftmost-column': (t) => `${t} does not start in the leftmost column`,
  'duplicate-key': (t) => `the key appears again (${t}); the last value is used`,
  'duplicate-section': (t) => `the section appears again (${t}); its entries are merged`,
  'unclosed-section': (t) => `"${t}" has no closing "]"; the line is ignored`,
  'line-too-long': (t) => `the line has ${t}, CiA 306 allows ${EDS_MAX_LINE}`,
  'not-ascii': (t) => `the line has characters outside ASCII: "${t}"`,
}

function checkText(c: Checker, options: EdsCheckOptions): void {
  if (options.encoding === 'windows-1252')
    c.add('file-encoding', 'the file is not UTF-8; it was read as Windows-1252, which fixes its special characters')
  for (const issue of c.doc.issues) {
    if (issue.kind === 'not-ascii' && options.encoding === 'windows-1252') continue
    c.add(READ_ISSUE_RULE[issue.kind], READ_ISSUE_TEXT[issue.kind](issue.text), {
      section: issue.section,
      key: issue.key,
      line: issue.line,
    })
  }
}

function checkKeys(c: Checker, section: EdsSection, known: readonly string[]): void {
  const lower = new Set(known.map((k) => k.toLowerCase()))
  for (const [k, e] of section.entries)
    if (!lower.has(k))
      c.add('unknown-key', `"${e.key}" is not an entry of [${section.name}]`, {
        section: section.name,
        key: e.key,
        line: e.line,
      })
}

function checkFileInfo(c: Checker): void {
  const s = c.doc.sections.get('FILEINFO')
  if (!s) {
    c.add('file-info', 'the file has no [FileInfo] section', { section: 'FileInfo' })
    return
  }
  checkKeys(c, s, FILE_INFO_KEYS)
  for (const k of FILE_INFO_REQUIRED)
    if (!c.get(s, k)) c.add('file-info', `${k} is missing or empty`, { section: s.name, key: k, line: s.line })
  for (const k of ['FileVersion', 'FileRevision']) {
    const v = c.get(s, k)
    const n = plainInt(v)
    if (v && (n === undefined || n < 0 || n > 255)) c.add('file-info', `${k} "${v}" is not an UNSIGNED8`, c.at(s, k))
  }
  const version = c.get(s, 'EDSVersion')
  if (version && !/^\d\.\d$/.test(version))
    c.add('file-info', `EDSVersion "${version}" is not "x.y"`, c.at(s, 'EDSVersion'))
  for (const k of ['CreationDate', 'ModificationDate']) {
    const v = c.get(s, k)
    if (v && !DATE.test(v)) c.add('date-format', `${k} "${v}" is not mm-dd-yyyy`, c.at(s, k))
  }
  for (const k of ['CreationTime', 'ModificationTime']) {
    const v = c.get(s, k)
    if (v && !TIME.test(v)) c.add('time-format', `${k} "${v}" is not hh:mm followed by AM or PM`, c.at(s, k))
  }
}

function checkTextLengths(c: Checker): void {
  for (const [sec, key, max] of TEXT_LENGTHS) {
    const s = c.doc.sections.get(sec)
    const v = c.get(s, key)
    if (s && v !== undefined && v.length > max)
      c.add('text-length', `${c.at(s, key).key} has ${v.length} characters, CiA 306 allows ${max}`, c.at(s, key))
  }
}

function checkDeviceInfo(c: Checker): void {
  const s = c.doc.sections.get('DEVICEINFO')
  if (!s) {
    c.add('device-info-missing', 'the file has no [DeviceInfo] section; is it an EDS or DCF file?')
    return
  }
  checkKeys(c, s, [...DEVICE_INFO_KEYS, ...DEVICE_INFO_OPTIONAL])
  for (const k of DEVICE_INFO_KEYS)
    if (c.get(s, k) === undefined || c.get(s, k) === '')
      c.add('device-info', `${k} is missing or empty`, { section: s.name, key: k, line: s.line })
  for (const k of DEVICE_INFO_BOOLEAN) {
    const v = c.get(s, k)
    if (v && v !== '0' && v !== '1') c.add('device-info-value', `${k} "${v}" is not 0 or 1`, c.at(s, k))
  }
  for (const k of DEVICE_INFO_NUMBER) {
    const v = c.get(s, k)
    if (v && plainInt(v) === undefined) c.add('device-info-value', `${k} "${v}" is not a number`, c.at(s, k))
  }
  const compact = c.get(s, 'CompactPDO')
  if (compact) {
    const n = plainInt(compact)
    if (n === undefined || n < 0 || n > 255)
      c.add('compact-pdo', `CompactPDO "${compact}" is not an UNSIGNED8`, c.at(s, 'CompactPDO'))
  }
}

function checkDummyUsage(c: Checker): void {
  const s = c.doc.sections.get('DUMMYUSAGE')
  if (!s) return
  for (const e of s.entries.values()) {
    if (!/^Dummy[0-9A-F]{4}$/i.test(e.key))
      c.add('dummy-usage', `"${e.key}" is not Dummy<data type index>`, { section: s.name, key: e.key, line: e.line })
    else if (e.value !== '0' && e.value !== '1')
      c.add('dummy-usage', `${e.key} "${e.value}" is not 0 or 1`, { section: s.name, key: e.key, line: e.line })
  }
}

function listPlaceProblem(list: string, index: number): string | undefined {
  if (index < 0x1000) return `${hex4(index)} is a data type, not an object`
  const manufacturer = index >= 0x2000 && index < 0x6000
  if (list === 'MandatoryObjects')
    return [0x1000, 0x1001, 0x1018].includes(index) ? undefined : `${hex4(index)} is not a mandatory object`
  if (list === 'OptionalObjects') return manufacturer ? `${hex4(index)} belongs in [ManufacturerObjects]` : undefined
  return manufacturer ? undefined : `${hex4(index)} is not in 0x2000-0x5FFF`
}

function checkObjectLists(c: Checker): Set<number> {
  const listed = new Set<number>()
  for (const name of OBJECT_LISTS) {
    const s = c.doc.sections.get(name.toUpperCase())
    if (!s) {
      if (name === 'MandatoryObjects') c.add('object-list', 'the file has no [MandatoryObjects] section')
      continue
    }
    const countText = c.get(s, 'SupportedObjects')
    const count = plainInt(countText)
    if (count === undefined || count < 0 || count > 0xffff) {
      c.add('object-list', `SupportedObjects "${countText ?? ''}" is missing or not an UNSIGNED16`, {
        section: s.name,
        key: 'SupportedObjects',
        line: s.line,
      })
      continue
    }
    const indices: number[] = []
    for (let n = 1; n <= count; n++) {
      const v = c.get(s, String(n))
      const index = plainInt(v)
      if (v === undefined) {
        c.add('object-list', `entry ${n} is missing; SupportedObjects is ${count}`, { section: s.name, line: s.line })
        continue
      }
      if (index === undefined || index < 0 || index > 0xffff) {
        c.add('object-list', `entry ${n} "${v}" is not an object index`, c.at(s, String(n)))
        continue
      }
      indices.push(index)
      listed.add(index)
      if (!c.doc.sections.has(index.toString(16).toUpperCase().padStart(4, '0')))
        c.add('object-section', `${hex4(index)} is listed but has no section`, { ...c.at(s, String(n)), index })
      const place = listPlaceProblem(name, index)
      if (place) c.add('object-list-place', place, c.at(s, String(n)))
    }
    for (const [k, e] of s.entries) {
      if (k === 'supportedobjects') continue
      if (!/^\d+$/.test(k) || Number(k) < 1 || Number(k) > count)
        c.add('object-list', `entry "${e.key}" is beyond SupportedObjects=${count}`, {
          section: s.name,
          key: e.key,
          line: e.line,
        })
    }
    if (name === 'MandatoryObjects') {
      for (const required of [0x1000, 0x1001])
        if (!indices.includes(required))
          c.add('mandatory-objects', `${hex4(required)} is not listed`, {
            section: s.name,
            line: s.line,
            index: required,
          })
      if (!indices.includes(0x1018))
        c.add('mandatory-objects', '0x1018 (identity) is not listed; devices of CANopen 4.0 must have it', {
          section: s.name,
          line: s.line,
          index: 0x1018,
        })
    }
  }
  return listed
}

function checkObjFlags(c: Checker, s: EdsSection): void {
  const v = c.get(s, 'ObjFlags')
  if (v === undefined || v === '') return
  const n = plainInt(v)
  if (n === undefined || n < 0 || n > 0xffffffff)
    c.add('obj-flags', `ObjFlags "${v}" is not an UNSIGNED32`, c.at(s, 'ObjFlags'))
  else if ((n & ~3) !== 0)
    c.add('obj-flags', `ObjFlags ${v} sets reserved bits (only bits 0 and 1 are defined)`, c.at(s, 'ObjFlags'))
}

function checkName(c: Checker, s: EdsSection): void {
  const name = c.get(s, 'ParameterName')
  if (!name) c.add('parameter-name', 'ParameterName is missing', { section: s.name, line: s.line })
  else if (name.length > 241)
    c.add('parameter-name', `ParameterName has ${name.length} characters, CiA 306 allows 241`, c.at(s, 'ParameterName'))
}

function checkUnknownObjectKeys(c: Checker, s: EdsSection): void {
  for (const [k, e] of s.entries)
    if (!OBJECT_KEYS.has(k))
      c.add('unknown-key', `"${e.key}" is not an object entry`, { section: s.name, key: e.key, line: e.line })
}

/** Checks DefaultValue or ParameterValue (or a list value) against the data type and the limits. */
function checkValue(
  c: Checker,
  ctx: ValueContext,
  value: string,
  where: { section: string; key: string; line: number },
  limits: { low?: string; high?: string },
): void {
  if (value === '') return
  const { type, typeCode } = ctx
  if (!type) return
  if (type.range) {
    const v = parseEdsIntegerText(value)
    if (!v) {
      c.add('value-syntax', `${where.key} "${value}" is not a ${type.name} number`, where)
      return
    }
    noteFormula(c, v, value, where)
    const [lo, hi] = edsValueSpan(v)
    if (lo < type.range[0] || hi > type.range[1]) {
      c.add('value-range', `${where.key} ${value} is outside ${type.name}`, where)
      return
    }
    const low = limits.low ? parseEdsIntegerText(limits.low) : null
    const high = limits.high ? parseEdsIntegerText(limits.high) : null
    if (low && edsValueSpan(low)[0] > lo)
      c.add('value-limits', `${where.key} ${value} is below LowLimit ${limits.low}`, where)
    else if (high && edsValueSpan(high)[1] < hi)
      c.add('value-limits', `${where.key} ${value} is above HighLimit ${limits.high}`, where)
    return
  }
  if (type.real) {
    const v = parseEdsReal(value, type.real)
    if (v === null) {
      c.add('value-syntax', `${where.key} "${value}" is not a ${type.name} number`, where)
      return
    }
    const low = limits.low ? parseEdsReal(limits.low, type.real) : null
    const high = limits.high ? parseEdsReal(limits.high, type.real) : null
    if (low !== null && v < low) c.add('value-limits', `${where.key} ${value} is below LowLimit ${limits.low}`, where)
    else if (high !== null && v > high)
      c.add('value-limits', `${where.key} ${value} is above HighLimit ${limits.high}`, where)
    return
  }
  if (type.octets && typeCode !== 0x000b && !isEdsOctets(value))
    c.add('value-syntax', `${where.key} "${value}" is not hexadecimal bytes (${type.name})`, where)
}

function noteFormula(
  c: Checker,
  v: EdsIntegerText,
  text: string,
  where: { section: string; key: string; line: number },
): void {
  if (v.suffixFormula) c.add('nodeid-formula', `${where.key} "${text}" puts $NODEID last; read as $NODEID+n`, where)
  if (v.octal) c.add('octal-number', `${where.key} "${text}" has a leading 0 and is read as octal`, where)
  if (/^\s*-\s*0x/i.test(text))
    c.add(
      'negative-hex',
      `${where.key} "${text}" has a minus sign before 0x; read as a negative number, which other tools may refuse`,
      where,
    )
}

function checkLimits(c: Checker, s: EdsSection, type: EdsTypeInfo | undefined): void {
  for (const key of ['LowLimit', 'HighLimit']) {
    const v = c.get(s, key)
    if (!v) continue
    const where = c.at(s, key)
    if (!type?.range && !type?.real) {
      c.add('limit-syntax', `${key} is given for ${type?.name ?? 'an unknown type'}, which has no limits`, where)
      continue
    }
    if (type.real) {
      if (parseEdsReal(v, type.real) === null)
        c.add('limit-syntax', `${key} "${v}" is not a ${type.name} number`, where)
      continue
    }
    const n = parseEdsIntegerText(v)
    if (!n) {
      c.add('limit-syntax', `${key} "${v}" is not a number`, where)
      continue
    }
    noteFormula(c, n, v, where)
    const [lo, hi] = edsValueSpan(n)
    if (type.range && (lo < type.range[0] || hi > type.range[1]))
      c.add('limit-syntax', `${key} ${v} is outside ${type.name}`, where)
  }
}

/** Checks a VAR section, a sub-object section or a CompactSubObj template. */
function checkValueObject(c: Checker, s: EdsSection, index: number, subIndex: number, readOnlySub0 = false): void {
  checkName(c, s)
  checkUnknownObjectKeys(c, s)
  checkObjFlags(c, s)
  const dtText = c.get(s, 'DataType')
  const typeCode = plainInt(dtText)
  if (!dtText) {
    c.add('data-type', 'DataType is missing', { section: s.name, key: 'DataType', line: s.line })
  } else if (typeCode === undefined || typeCode <= 0 || typeCode > 0xffff) {
    c.add('data-type', `DataType "${dtText}" is not a data type index`, c.at(s, 'DataType'))
  }
  const access = c.get(s, 'AccessType')
  if (!access && !readOnlySub0)
    c.add('access-type', 'AccessType is missing', { section: s.name, key: 'AccessType', line: s.line })
  else if (access && !ACCESS_TYPES.includes(access.toLowerCase()))
    c.add('access-type', `AccessType "${access}" is not ro, wo, rw, rwr, rww or const`, c.at(s, 'AccessType'))
  const mapping = c.get(s, 'PDOMapping')
  if (mapping && mapping !== '0' && mapping !== '1')
    c.add('pdo-mapping', `PDOMapping "${mapping}" is not 0 or 1`, c.at(s, 'PDOMapping'))
  if (typeCode === undefined) return
  const want = commDataType(index, subIndex)
  if (want !== undefined && typeCode !== want)
    c.add('comm-data-type', `DataType is ${typeName(typeCode)}; CiA 301 gives ${typeName(want)}`, c.at(s, 'DataType'))
  const type = EDS_TYPES[typeCode]
  checkLimits(c, s, type)
  const limits = { low: c.get(s, 'LowLimit'), high: c.get(s, 'HighLimit') }
  const ctx: ValueContext = { section: s, type, typeCode }
  for (const key of ['DefaultValue', 'ParameterValue']) {
    const v = c.get(s, key)
    if (v !== undefined) checkValue(c, ctx, v, c.at(s, key), limits)
  }
  const pv = c.get(s, 'ParameterValue')
  const dv = c.get(s, 'DefaultValue')
  if (pv && (access?.toLowerCase() === 'ro' || access?.toLowerCase() === 'const') && pv !== dv)
    c.add(
      'value-on-read-only',
      `ParameterValue ${pv} on a ${access} object differs from DefaultValue ${dv ?? ''}`,
      c.at(s, 'ParameterValue'),
    )
}

function checkCompactLists(c: Checker, index: number, compact: number, ctx: ValueContext): void {
  const id = index.toString(16).toUpperCase().padStart(4, '0')
  for (const suffix of ['NAME', 'VALUE', 'DENOTATION']) {
    const list = c.doc.sections.get(`${id}${suffix}`)
    if (!list) continue
    const nrText = c.get(list, 'NrOfEntries')
    const nr = plainInt(nrText)
    const numbered = [...list.entries.values()].filter((e) => e.key.toLowerCase() !== 'nrofentries')
    if (nr === undefined)
      c.add('compact-list', 'NrOfEntries is missing or not a number', { section: list.name, line: list.line })
    else if (nr !== numbered.length)
      c.add(
        'compact-list',
        `NrOfEntries is ${nr} but the list has ${numbered.length} entries`,
        c.at(list, 'NrOfEntries'),
      )
    for (const e of numbered) {
      const where = { section: list.name, key: e.key, line: e.line }
      if (!/^\d+$/.test(e.key) || Number(e.key) < 1 || Number(e.key) > compact) {
        c.add('compact-list', `entry "${e.key}" is not a sub-index from 1 to CompactSubObj=${compact}`, where)
        continue
      }
      if (suffix === 'VALUE') checkValue(c, ctx, e.value, where, {})
    }
  }
}

function checkObjects(c: Checker, listed: Set<number>): void {
  const sections = c.doc.sections
  for (const [upper, s] of sections) {
    const m = OBJECT_SECTION.exec(upper)
    if (!m) {
      if (!OTHER_SECTIONS.test(upper) && !OBJECT_LISTS.some((l) => l.toUpperCase() === upper))
        c.add('unknown-section', `[${s.name}] is not a CiA 306 section`, { section: s.name, line: s.line })
      continue
    }
    const index = parseInt(m[1], 16)
    const suffix = m[2]
    if (suffix?.startsWith('SUB')) {
      const parent = sections.get(m[1])
      if (!parent)
        c.add('sub-object', `${hex4(index)} has no [${m[1]}] section for this sub-object`, {
          section: s.name,
          line: s.line,
        })
      continue
    }
    if (suffix === 'OBJECTLINKS') {
      const count = plainInt(c.get(s, 'ObjectLinks'))
      const numbered = [...s.entries.keys()].filter((k) => k !== 'objectlinks')
      if (count === undefined || count !== numbered.length)
        c.add('object-links', `ObjectLinks does not count the ${numbered.length} links`, {
          section: s.name,
          line: s.line,
        })
      continue
    }
    if (suffix) {
      if (!sections.get(m[1]))
        c.add('compact-list', `${hex4(index)} is not described`, { section: s.name, line: s.line })
      continue
    }
    if (!listed.has(index))
      c.add('object-unlisted', `${hex4(index)} is in no object list`, { section: s.name, line: s.line })
    checkObject(c, s, index)
  }
}

function checkObject(c: Checker, s: EdsSection, index: number): void {
  const otText = c.get(s, 'ObjectType')
  const objectType = otText ? plainInt(otText) : 7
  if (objectType === undefined || ![2, 5, 6, 7, 8, 9].includes(objectType)) {
    c.add('object-type', `ObjectType "${otText ?? ''}" is not 0x2, 0x5, 0x6, 0x7, 0x8 or 0x9`, c.at(s, 'ObjectType'))
    return
  }
  const subNumber = plainInt(c.get(s, 'SubNumber')) ?? 0
  const compact = plainInt(c.get(s, 'CompactSubObj')) ?? 0
  const structured = objectType === 6 || objectType === 8 || objectType === 9
  if (objectType === 2) {
    checkName(c, s)
    checkUnknownObjectKeys(c, s)
    checkObjFlags(c, s)
    return
  }
  if (!structured) {
    if (subNumber > 0)
      c.add('object-type', `SubNumber is ${subNumber} on a VAR; ObjectType should be 0x8 or 0x9`, c.at(s, 'ObjectType'))
    checkValueObject(c, s, index, 0)
    return
  }
  if (compact > 0) {
    if (subNumber > 0) c.add('compact-sub-obj', 'SubNumber and CompactSubObj are both given', c.at(s, 'SubNumber'))
    checkValueObject(c, s, index, 1)
    const typeCode = plainInt(c.get(s, 'DataType')) ?? 0
    checkCompactLists(c, index, compact, { section: s, type: EDS_TYPES[typeCode], typeCode })
    return
  }
  checkName(c, s)
  checkUnknownObjectKeys(c, s)
  checkObjFlags(c, s)
  if (c.get(s, 'AccessType'))
    c.add(
      'access-type-structured',
      'AccessType is given on an ARRAY or RECORD without CompactSubObj',
      c.at(s, 'AccessType'),
    )
  const id = index.toString(16).toUpperCase().padStart(4, '0')
  let described = 0
  for (const [upper, sub] of c.doc.sections) {
    const m = /^([0-9A-F]{4})SUB([0-9A-F]+)$/.exec(upper)
    if (!m || m[1] !== id) continue
    const subIndex = parseInt(m[2], 16)
    if (subIndex > 254) {
      c.add('sub-object', `sub-index ${subIndex} is above 254`, { section: sub.name, line: sub.line })
      continue
    }
    described++
    checkValueObject(c, sub, index, subIndex, false)
    if (subIndex === 0) {
      const t = plainInt(c.get(sub, 'DataType'))
      if (t !== undefined && t !== U8 && commDataType(index, 0) === undefined)
        c.add('sub-zero-type', `DataType is ${typeName(t)}; sub-index 0 is UNSIGNED8`, c.at(sub, 'DataType'))
    }
  }
  if (subNumber === 0 && described === 0) {
    if (!c.get(s, 'SubNumber'))
      c.add('sub-number', 'SubNumber is missing on an ARRAY or RECORD', {
        section: s.name,
        key: 'SubNumber',
        line: s.line,
      })
    return
  }
  if (described < subNumber)
    c.add('sub-number', `SubNumber is ${subNumber} but ${described} sub-objects are described`, c.at(s, 'SubNumber'))
  else if (described > subNumber)
    c.add('sub-number', `SubNumber is ${subNumber} but ${described} sub-objects are described`, c.at(s, 'SubNumber'))
}

function checkComments(c: Checker): void {
  const s = c.doc.sections.get('COMMENTS')
  if (!s) return
  const lines = plainInt(c.get(s, 'Lines'))
  const numbered = [...s.entries.values()].filter((e) => /^line\d+$/i.test(e.key))
  if (lines === undefined || lines !== numbered.length)
    c.add('comments', `Lines does not count the ${numbered.length} comment lines`, {
      section: s.name,
      key: 'Lines',
      line: s.line,
    })
  for (const e of numbered)
    if (e.value.length > 249)
      c.add('comments', `${e.key} has ${e.value.length} characters, CiA 306 allows 249`, {
        section: s.name,
        key: e.key,
        line: e.line,
      })
}

function printableAscii(text: string): boolean {
  return [...text].every((ch) => ch >= ' ' && ch <= '~')
}

const MAPPING_SUB = /^(1[67AB][0-9A-F]{2})SUB([0-9A-F]+)$/
const MAPPING_LIST = /^(1[67AB][0-9A-F]{2})VALUE$/

/** Bit length of a CiA 301 type a PDO can carry, or undefined. */
function typeBits(code: number): number | undefined {
  const t: EdsTypeInfo | undefined = EDS_TYPES[code]
  if (!t) return undefined
  if (t.name === 'BOOLEAN') return 1
  if (t.real) return t.real
  const m = /(\d+)$/.exec(t.name)
  return t.range && m ? Number(m[1]) : undefined
}

/** The DataType of sub-object `sub` of `index` as the file describes it, null when it is not described. */
function describedType(c: Checker, index: number, sub: number): number | undefined | null {
  const id = index.toString(16).toUpperCase().padStart(4, '0')
  const object = c.doc.sections.get(id)
  const own = c.doc.sections.get(`${id}SUB${sub.toString(16).toUpperCase()}`)
  const typeOf = (s: EdsSection): number | undefined => {
    const v = parseEdsIntegerText(c.get(s, 'DataType') ?? '')
    return v && !v.nodeId ? Number(v.value) : undefined
  }
  if (own) return typeOf(own)
  if (!object) return null
  const objectType = parseEdsIntegerText(c.get(object, 'ObjectType') ?? '7')
  const compact = parseEdsIntegerText(c.get(object, 'CompactSubObj') ?? '0')
  if (sub === 0 && (!objectType || Number(objectType.value) === 7)) return typeOf(object)
  if (sub >= 1 && compact && sub <= Number(compact.value)) return typeOf(object)
  return null
}

function checkMappingEntry(c: Checker, text: string, where: { section: string; key: string; line: number }): void {
  const v = parseEdsIntegerText(text)
  if (!v || v.nodeId || v.value === 0n) return
  const n = Number(v.value & 0xffffffffn)
  const index = n >>> 16
  const sub = (n >>> 8) & 0xff
  const length = n & 0xff
  if (index < 0x1000) return // dummy entries name a data type
  const ref = `${hex4(index)} sub ${sub}`
  const type = describedType(c, index, sub)
  if (type === null) {
    c.add('mapping-entry', `maps ${ref}, which the file does not describe`, where)
    return
  }
  const bits = type === undefined ? undefined : typeBits(type)
  if (type !== undefined && bits !== undefined && bits !== length)
    c.add('mapping-entry', `maps ${length} bits of ${ref}, which is ${typeName(type)} (${bits} bits)`, where)
}

function checkMappingEntries(c: Checker): void {
  for (const [upper, s] of c.doc.sections) {
    const m = MAPPING_SUB.exec(upper)
    if (m && parseInt(m[2], 16) >= 1) {
      for (const key of ['DefaultValue', 'ParameterValue']) {
        const value = c.get(s, key)
        if (value !== undefined) checkMappingEntry(c, value, c.at(s, key))
      }
      continue
    }
    if (MAPPING_LIST.test(upper))
      for (const e of s.entries.values())
        if (/^\d+$/.test(e.key)) checkMappingEntry(c, e.value, { section: s.name, key: e.key, line: e.line })
  }
}

function checkModular(c: Checker): void {
  const s = c.doc.sections.get('SUPPORTEDMODULES')
  if (!s) return
  c.add(
    'modular-device',
    'the file describes a modular device; only the objects of the base device are used, so objects of extension modules cannot be mapped or written',
    { section: s.name, line: s.line },
  )
}

function checkCommissioning(c: Checker): void {
  const s = commissioningSection(c.doc)
  if (!s) return
  if (s.name.toUpperCase() !== 'DEVICECOMISSIONING')
    c.add('commissioning', `[${s.name}] is spelled [DeviceComissioning] in CiA 306; read as that section`, {
      section: s.name,
      line: s.line,
    })
  checkKeys(c, s, COMMISSIONING_KEYS)
  const nodeId = c.get(s, 'NodeID')
  if (nodeId !== undefined) {
    const n = plainInt(nodeId)
    if (n === undefined || n < 1 || n > 127)
      c.add('commissioning', `NodeID "${nodeId}" is not 1 to 127`, c.at(s, 'NodeID'))
  }
  for (const [key, max] of [
    ['NodeName', 246],
    ['NetworkName', 243],
  ] as const) {
    const v = c.get(s, key)
    if (v === undefined) continue
    if (!printableAscii(v)) c.add('commissioning', `${key} "${v}" is not printable ASCII`, c.at(s, key))
    if (v.length > max) c.add('commissioning', `${key} has ${v.length} characters, CiA 306 allows ${max}`, c.at(s, key))
  }
  const baud = c.get(s, 'Baudrate')
  if (baud !== undefined && baud !== '') {
    const n = plainInt(baud)
    const info = c.doc.sections.get('DEVICEINFO')
    if (n === undefined || !DCF_BAUDRATES_KBIT.some((r) => r === n))
      c.add(
        'commissioning-baudrate',
        `Baudrate "${baud}" is not 10, 20, 50, 125, 250, 500, 800 or 1000`,
        c.at(s, 'Baudrate'),
      )
    else if (c.get(info, `BaudRate_${n}`) === '0')
      c.add('commissioning-baudrate', `Baudrate ${n} is marked unsupported (BaudRate_${n}=0)`, c.at(s, 'Baudrate'))
  }
  for (const [key, max] of [
    ['NetNumber', 0xffffffff],
    ['LSS_SerialNumber', 0xffffffff],
    ['CANopenManager', 1],
  ] as const) {
    const v = c.get(s, key)
    if (v === undefined || v === '') continue
    const n = plainInt(v)
    if (n === undefined || n < 0 || n > max) c.add('commissioning', `${key} "${v}" is not 0 to ${max}`, c.at(s, key))
  }
}

/** Checks an EDS or DCF against CiA 306. */
export function checkEds(doc: EdsDocument, options: EdsCheckOptions = {}): EdsCheckResult {
  const c = new Checker(doc)
  checkText(c, options)
  checkDeviceInfo(c)
  if (!doc.sections.has('DEVICEINFO')) return { findings: c.findings, ok: false }
  checkFileInfo(c)
  checkTextLengths(c)
  checkDummyUsage(c)
  const listed = checkObjectLists(c)
  checkObjects(c, listed)
  checkComments(c)
  checkCommissioning(c)
  if (options.format === 'dcf' && !commissioningSection(doc))
    c.add('commissioning', 'a DCF has a [DeviceComissioning] section; this one has none', {
      section: 'DeviceComissioning',
    })
  checkModular(c)
  checkMappingEntries(c)
  c.findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  return { findings: c.findings, ok: c.findings.every((f) => f.severity === 'warning') }
}

/** "[1A00sub0] line 12" or "line 3" or "file", for messages. */
export function findingPlace(f: Cia306Finding): string {
  const parts: string[] = []
  if (f.section !== undefined) parts.push(`[${f.section}]`)
  if (f.key !== undefined && f.section !== undefined) parts.push(f.key)
  if (f.line !== undefined) parts.push(`line ${f.line}`)
  return parts.length > 0 ? parts.join(' ') : 'file'
}

/** The rule's clause as cited: "CiA 306 4.6.3.2" or "CiA 301". */
export function ruleClause(rule: Cia306RuleId): string {
  const clause: string = CIA306_RULES[rule].clause
  return clause.startsWith('CiA') ? clause : `CiA 306 ${clause}`
}
