/**
 * EDS and DCF (CiA 306) parser: the device identity, its object dictionary, and the PDO counts.
 * Pure and lenient: objects it cannot read are left out, and the CiA 306 check reports them.
 */

import type { CanopenAccess, CanopenEdsInfo, CanopenObject } from '../../ports/canopen-types'
import { CANOPEN_BITRATES, CANOPEN_TYPE_CODES } from './data-types'
import { type EdsDocument, type EdsSection, readEdsDocument } from './eds-document'

export class EdsParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EdsParseError'
  }
}

const ACCESS: readonly CanopenAccess[] = ['ro', 'wo', 'rw', 'rwr', 'rww', 'const']

function toAccess(text: string): CanopenAccess | undefined {
  return ACCESS.find((a) => a === text)
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

function intKey(section: EdsSection, key: string, fallback: number): number {
  const entry = section.entries.get(key.toLowerCase())
  if (!entry || entry.value === '') return fallback
  return parseEdsInteger(entry.value) ?? fallback
}

function strKey(section: EdsSection, key: string): string {
  return section.entries.get(key.toLowerCase())?.value ?? ''
}

function typeName(code: number): string {
  return CANOPEN_TYPE_CODES[code] ?? `0x${code.toString(16).toUpperCase().padStart(4, '0')}`
}

/** A sub-object, or undefined when its DataType or AccessType cannot be read (the check reports it). */
function readSub(
  section: EdsSection,
  index: number,
  subIndex: number,
  name?: string,
  parentName?: string,
): CanopenObject | undefined {
  const access = toAccess((section.entries.get('accesstype')?.value || 'ro').toLowerCase())
  const dataType = parseEdsInteger(strKey(section, 'DataType'))
  if (!access || dataType === null || dataType <= 0) return undefined
  const object: CanopenObject = {
    index,
    subIndex,
    name: name ?? strKey(section, 'ParameterName'),
    dataType: typeName(dataType),
    access,
    pdoMapping: intKey(section, 'PDOMapping', 0) !== 0,
  }
  const def = strKey(section, 'DefaultValue')
  if (def !== '') object.defaultValue = def
  if (parentName) object.parentName = parentName
  const low = strKey(section, 'LowLimit')
  const high = strKey(section, 'HighLimit')
  if (low !== '') object.lowLimit = low
  if (high !== '') object.highLimit = high
  const flags = intKey(section, 'ObjFlags', 0)
  if (flags !== 0) object.objFlags = flags
  return object
}

/** CiA 306 4.6.3.4.1: PDOs CompactPDO implies, numbered from the lowest ones not described. */
function implicitPdos(info: EdsSection, sections: Map<string, EdsSection>): CanopenObject[] {
  const mask = intKey(info, 'CompactPDO', 0)
  if (mask === 0) return []
  const out: CanopenObject[] = []
  const kinds = [
    { count: intKey(info, 'NrOfRXPDO', 0), comm: 0x1400, map: 0x1600, label: 'RPDO' },
    { count: intKey(info, 'NrOfTXPDO', 0), comm: 0x1800, map: 0x1a00, label: 'TPDO' },
  ]
  const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')
  for (const kind of kinds) {
    const described = (k: number): boolean => sections.has(hex(kind.comm + k)) || sections.has(hex(kind.map + k))
    let missing = kind.count
    for (let k = 0; k < 512; k++) if (described(k)) missing--
    for (let k = 0; k < 512 && missing > 0; k++) {
      if (described(k)) continue
      missing--
      const commName = `${kind.label} ${k + 1} communication parameter`
      const mapName = `${kind.label} ${k + 1} mapping parameter`
      const subs: Array<[number, string, string]> = [
        [1, 'COB-ID', 'UNSIGNED32'],
        [2, 'Transmission type', 'UNSIGNED8'],
        [3, 'Inhibit time', 'UNSIGNED16'],
        [4, 'Reserved', 'UNSIGNED8'],
        [5, 'Event timer', 'UNSIGNED16'],
        [6, 'SYNC start value', 'UNSIGNED8'],
      ]
      const present = subs.filter(([sub]) => (mask & (1 << (sub - 1))) !== 0)
      const highest = present.length > 0 ? present[present.length - 1][0] : 0
      const base = { pdoMapping: false, parentName: commName }
      out.push({
        ...base,
        index: kind.comm + k,
        subIndex: 0,
        name: 'Highest sub-index supported',
        dataType: 'UNSIGNED8',
        access: 'ro',
        defaultValue: String(highest),
      })
      for (const [sub, name, dataType] of present)
        out.push({ ...base, index: kind.comm + k, subIndex: sub, name, dataType, access: 'rw' })
      const mapBase = { pdoMapping: false, parentName: mapName, access: 'rw' as const }
      out.push({
        ...mapBase,
        index: kind.map + k,
        subIndex: 0,
        name: 'Number of mapped objects',
        dataType: 'UNSIGNED8',
        defaultValue: '0',
      })
      for (let sub = 1; sub <= 8; sub++)
        out.push({
          ...mapBase,
          index: kind.map + k,
          subIndex: sub,
          name: `Mapped object ${sub}`,
          dataType: 'UNSIGNED32',
        })
    }
  }
  return out
}

/** Parses the text of an EDS or DCF file. Throws {@link EdsParseError} when it has no [DeviceInfo]. */
export function parseEds(text: string, fileName: string): CanopenEdsInfo {
  return parseEdsDocument(readEdsDocument(text), fileName)
}

/** The device description of a read EDS or DCF. Throws {@link EdsParseError} when it has no [DeviceInfo]. */
export function parseEdsDocument(doc: EdsDocument, fileName: string): CanopenEdsInfo {
  const sections = doc.sections
  const info = sections.get('DEVICEINFO')
  if (!info) throw new EdsParseError('the file has no [DeviceInfo] section; is it an EDS file?')

  const objects: CanopenObject[] = []
  const push = (o: CanopenObject | undefined): void => {
    if (o) objects.push(o)
  }
  const objectSection = /^([0-9A-F]{4})$/
  for (const [upper, section] of sections) {
    const m = objectSection.exec(upper)
    if (!m) continue
    const index = parseInt(m[1], 16)
    const objectType = intKey(section, 'ObjectType', 7)
    if (objectType === 7) {
      push(readSub(section, index, 0))
      continue
    }
    if (objectType !== 8 && objectType !== 9) continue // DOMAIN, DEFSTRUCT: not mappable
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
        const custom = names?.entries.get(String(sub))?.value
        push(readSub(section, index, sub, custom ?? `${parentName} ${sub}`, parentName))
      }
      continue
    }
    const subPattern = new RegExp(`^${m[1]}SUB([0-9A-F]+)$`)
    for (const [subUpper, sub] of sections) {
      const sm = subPattern.exec(subUpper)
      if (sm) push(readSub(sub, index, parseInt(sm[1], 16), undefined, parentName))
    }
  }
  objects.push(...implicitPdos(info, sections))
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

/** CiA 306 ObjFlags bit 0: the object refuses a write on download. */
export const OBJ_FLAG_REFUSE_WRITE = 0x1

/** Whether the master may write the object: not read-only and not marked "refuse write on download". */
export function masterMayWrite(object: CanopenObject): boolean {
  return object.access !== 'ro' && object.access !== 'const' && ((object.objFlags ?? 0) & OBJ_FLAG_REFUSE_WRITE) === 0
}

/** The object at index and sub-index, if the EDS defines it. */
export function findObject(eds: CanopenEdsInfo, index: number, subIndex: number): CanopenObject | undefined {
  return eds.objects.find((o) => o.index === index && o.subIndex === subIndex)
}
