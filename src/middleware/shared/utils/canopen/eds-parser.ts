/**
 * EDS (CiA 306) parser: the device identity, its object dictionary, and the PDO counts. Pure;
 * errors name the section and line at fault.
 */

import type { CanopenAccess, CanopenEdsInfo, CanopenObject } from '../../ports/canopen-types'
import { CANOPEN_BITRATES, CANOPEN_TYPE_CODES } from './data-types'

export class EdsParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EdsParseError'
  }
}

interface Entry {
  value: string
  line: number
}

interface Section {
  name: string
  line: number
  keys: Map<string, Entry>
}

const ACCESS: readonly CanopenAccess[] = ['ro', 'wo', 'rw', 'rwr', 'rww', 'const']

function toAccess(text: string): CanopenAccess | undefined {
  return ACCESS.find((a) => a === text)
}

function readSections(text: string): Map<string, Section> {
  const sections = new Map<string, Section>()
  let current: Section | null = null
  const lines = text.split(/\r\n|\n|\r/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end < 0) throw new EdsParseError(`line ${i + 1}: section header "${line}" has no closing "]"`)
      const name = line.slice(1, end).trim().toUpperCase()
      current = sections.get(name) ?? { name, line: i + 1, keys: new Map() }
      sections.set(name, current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) throw new EdsParseError(`line ${i + 1}: expected "key=value", found "${line}"`)
    if (!current) throw new EdsParseError(`line ${i + 1}: "${line}" is outside any section`)
    current.keys.set(line.slice(0, eq).trim().toLowerCase(), { value: line.slice(eq + 1).trim(), line: i + 1 })
  }
  return sections
}

/**
 * An EDS integer: decimal, 0x hexadecimal or 0-prefixed octal, optionally with `$NODEID+`
 * (`$NODEID` is replaced by `nodeId`). Returns null when the text is not such a number.
 */
export function parseEdsInteger(text: string, nodeId = 0): number | null {
  const parts = text.replace(/\s+/g, '').split('+')
  let sum = 0
  for (const part of parts) {
    if (part === '') return null
    if (part.toUpperCase() === '$NODEID') {
      sum += nodeId
      continue
    }
    let v: number
    if (/^-?0x[0-9a-f]+$/i.test(part)) v = parseInt(part, 16)
    else if (/^0[0-7]+$/.test(part)) v = parseInt(part, 8)
    else if (/^-?\d+$/.test(part)) v = parseInt(part, 10)
    else return null
    sum += v
  }
  return sum
}

function intKey(section: Section, key: string, fallback?: number): number {
  const entry = section.keys.get(key.toLowerCase())
  if (!entry || entry.value === '') {
    if (fallback !== undefined) return fallback
    throw new EdsParseError(`[${section.name}] line ${section.line}: missing ${key}`)
  }
  const v = parseEdsInteger(entry.value)
  if (v === null)
    throw new EdsParseError(`[${section.name}] line ${entry.line}: ${key} "${entry.value}" is not a number`)
  return v
}

function strKey(section: Section, key: string): string {
  return section.keys.get(key.toLowerCase())?.value ?? ''
}

function typeName(code: number): string {
  return CANOPEN_TYPE_CODES[code] ?? `0x${code.toString(16).toUpperCase().padStart(4, '0')}`
}

function readSub(section: Section, index: number, subIndex: number, name?: string, parentName?: string): CanopenObject {
  const accessEntry = section.keys.get('accesstype')
  const access = toAccess((accessEntry?.value ?? 'ro').toLowerCase())
  if (!access)
    throw new EdsParseError(
      `[${section.name}] line ${accessEntry?.line ?? section.line}: AccessType "${accessEntry?.value}" is not one of ro, wo, rw, rwr, rww, const`,
    )
  const object: CanopenObject = {
    index,
    subIndex,
    name: name ?? strKey(section, 'ParameterName'),
    dataType: typeName(intKey(section, 'DataType')),
    access,
    pdoMapping: intKey(section, 'PDOMapping', 0) !== 0,
  }
  const def = section.keys.get('defaultvalue')
  if (def && def.value !== '') object.defaultValue = def.value
  if (parentName) object.parentName = parentName
  const low = strKey(section, 'LowLimit')
  const high = strKey(section, 'HighLimit')
  if (low !== '') object.lowLimit = low
  if (high !== '') object.highLimit = high
  return object
}

/** Parses the text of an EDS file. Throws {@link EdsParseError}. */
export function parseEds(text: string, fileName: string): CanopenEdsInfo {
  const sections = readSections(text)
  const info = sections.get('DEVICEINFO')
  if (!info) throw new EdsParseError('the file has no [DeviceInfo] section; is it an EDS file?')

  const objects: CanopenObject[] = []
  const objectSection = /^([0-9A-F]{4})$/
  for (const section of sections.values()) {
    const m = objectSection.exec(section.name)
    if (!m) continue
    const index = parseInt(m[1], 16)
    const objectType = intKey(section, 'ObjectType', 7)
    if (objectType === 7) {
      objects.push(readSub(section, index, 0))
      continue
    }
    if (objectType !== 8 && objectType !== 9) continue // DOMAIN, DEFTYPE, DEFSTRUCT: not mappable
    const parentName = strKey(section, 'ParameterName')
    const compact = intKey(section, 'CompactSubObj', 0)
    if (compact > 0) {
      const names = sections.get(`${m[1]}NAME`)
      objects.push({
        index,
        subIndex: 0,
        name: 'Highest sub-index supported',
        dataType: 'UNSIGNED8',
        access: 'ro',
        pdoMapping: false,
        defaultValue: String(compact),
        parentName,
      })
      for (let sub = 1; sub <= compact; sub++) {
        const custom = names?.keys.get(String(sub))?.value
        objects.push(readSub(section, index, sub, custom ?? `${parentName} ${sub}`, parentName))
      }
      continue
    }
    const subPattern = new RegExp(`^${m[1]}SUB([0-9A-F]+)$`)
    for (const sub of sections.values()) {
      const sm = subPattern.exec(sub.name)
      if (sm) objects.push(readSub(sub, index, parseInt(sm[1], 16), undefined, parentName))
    }
  }
  objects.sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)

  const deviceType = objects.find((o) => o.index === 0x1000 && o.subIndex === 0)?.defaultValue
  return {
    fileName,
    vendorName: strKey(info, 'VendorName'),
    productName: strKey(info, 'ProductName'),
    deviceType: (deviceType && parseEdsInteger(deviceType)) || 0,
    vendorId: intKey(info, 'VendorNumber', 0),
    productCode: intKey(info, 'ProductNumber', 0),
    revision: intKey(info, 'RevisionNumber', 0),
    rxPdoCount: intKey(info, 'NrOfRXPDO', 0),
    txPdoCount: intKey(info, 'NrOfTXPDO', 0),
    unsupportedBitrates: CANOPEN_BITRATES.filter((rate) => intKey(info, `BaudRate_${rate / 1000}`, 1) === 0),
    objects,
  }
}

/** The object at index and sub-index, if the EDS defines it. */
export function findObject(eds: CanopenEdsInfo, index: number, subIndex: number): CanopenObject | undefined {
  return eds.objects.find((o) => o.index === index && o.subIndex === subIndex)
}
