/**
 * Device files written from a node's description, for nodes whose stored file is in another
 * format: an EDS (CiA 306) from an XDD or XDC, and an XDD (CiA 311 version 1.1) from an EDS or
 * DCF. Only what the description holds is written. Pure.
 */

import type { CanopenEdsInfo, CanopenObject } from '../../ports/canopen-types'
import { CANOPEN_BITRATES, CANOPEN_TYPE_CODES } from './data-types'
import { EDS_TYPES } from './eds-values'

export const DEVICE_FILE_WRITER = 'OpenPLC Editor'

/** CiA 301 data type code of a description's data type name ("UNSIGNED8", "0x0009"). */
export function dataTypeCode(dataType: string): number | undefined {
  for (const [code, name] of Object.entries(CANOPEN_TYPE_CODES)) if (name === dataType) return Number(code)
  const m = /^0x([0-9a-f]{4})$/i.exec(dataType)
  if (m) return parseInt(m[1], 16)
  const hit = Object.entries(EDS_TYPES).find(([, t]) => t.name === dataType)
  return hit ? Number(hit[0]) : undefined
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0')
}

interface DescribedObject {
  index: number
  /** The VAR itself, or the sub-objects of an ARRAY or RECORD. */
  var?: CanopenObject
  subs: CanopenObject[]
  name: string
  /** 0x8 when every sub-object after sub-index 0 has one type, else 0x9. */
  objectType: 7 | 8 | 9
}

/** The description's objects grouped by index, in index order. */
export function describedObjects(eds: CanopenEdsInfo): DescribedObject[] {
  const byIndex = new Map<number, CanopenObject[]>()
  for (const o of eds.objects) byIndex.set(o.index, [...(byIndex.get(o.index) ?? []), o])
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, list]) => {
      const sorted = [...list].sort((a, b) => a.subIndex - b.subIndex)
      if (sorted.length === 1 && sorted[0].subIndex === 0 && sorted[0].parentName === undefined)
        return { index, var: sorted[0], subs: [], name: sorted[0].name, objectType: 7 as const }
      const types = new Set(sorted.filter((o) => o.subIndex > 0).map((o) => o.dataType))
      return {
        index,
        subs: sorted,
        name: sorted[0].parentName ?? sorted[0].name,
        objectType: types.size <= 1 ? (8 as const) : (9 as const),
      }
    })
}

export interface WriteOptions {
  fileName: string
  now: Date
}

function mmddyyyy(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}`
}

function hhmm(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(((d.getHours() + 11) % 12) + 1)}:${p(d.getMinutes())}${d.getHours() < 12 ? 'AM' : 'PM'}`
}

const eds306 = (text: string, max: number): string =>
  text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, max)

function edsObjectLines(o: CanopenObject, section: string): string[] {
  const code = dataTypeCode(o.dataType) ?? 0
  const lines = [
    `[${section}]`,
    `ParameterName=${eds306(o.name, 241)}`,
    'ObjectType=0x7',
    `DataType=0x${hex4(code)}`,
    `AccessType=${o.access}`,
  ]
  if (o.defaultValue !== undefined) lines.push(`DefaultValue=${o.defaultValue}`)
  if (o.lowLimit !== undefined) lines.push(`LowLimit=${o.lowLimit}`)
  if (o.highLimit !== undefined) lines.push(`HighLimit=${o.highLimit}`)
  lines.push(`PDOMapping=${o.pdoMapping ? 1 : 0}`)
  if (o.objFlags !== undefined) lines.push(`ObjFlags=${o.objFlags}`)
  return lines
}

/** A CiA 306 EDS holding the description: identity, PDO counts, bit rates and every object. */
export function writeEds(eds: CanopenEdsInfo, options: WriteOptions): string {
  const objects = describedObjects(eds)
  const out: string[] = [
    '[FileInfo]',
    `FileName=${eds306(options.fileName, 243)}`,
    'FileVersion=1',
    'FileRevision=0',
    'EDSVersion=4.0',
    `Description=${eds306(`${eds.productName} (written from ${eds.source?.fileName ?? eds.fileName})`, 243)}`,
    `CreationTime=${hhmm(options.now)}`,
    `CreationDate=${mmddyyyy(options.now)}`,
    `CreatedBy=${DEVICE_FILE_WRITER}`,
    '',
    '[DeviceInfo]',
    `VendorName=${eds306(eds.vendorName, 244)}`,
    `VendorNumber=0x${eds.vendorId.toString(16).toUpperCase().padStart(8, '0')}`,
    `ProductName=${eds306(eds.productName, 243)}`,
    `ProductNumber=0x${eds.productCode.toString(16).toUpperCase().padStart(8, '0')}`,
    `RevisionNumber=0x${eds.revision.toString(16).toUpperCase().padStart(8, '0')}`,
    `OrderCode=${eds306(eds.details?.orderNumber ?? '', 245)}`,
    ...CANOPEN_BITRATES.map((b) => `BaudRate_${b / 1000}=${eds.unsupportedBitrates?.includes(b) ? 0 : 1}`),
    'SimpleBootUpMaster=0',
    'SimpleBootUpSlave=1',
    'Granularity=8',
    'DynamicChannelsSupported=0',
    'GroupMessaging=0',
    `NrOfRXPDO=${eds.rxPdoCount}`,
    `NrOfTXPDO=${eds.txPdoCount}`,
    'LSS_Supported=0',
    '',
  ]
  const mandatory = objects.filter((o) => [0x1000, 0x1001, 0x1018].includes(o.index))
  const manufacturer = objects.filter((o) => o.index >= 0x2000 && o.index <= 0x5fff)
  const optional = objects.filter((o) => !mandatory.includes(o) && !manufacturer.includes(o))
  for (const [name, list] of [
    ['MandatoryObjects', mandatory],
    ['OptionalObjects', optional],
    ['ManufacturerObjects', manufacturer],
  ] as const) {
    out.push(`[${name}]`, `SupportedObjects=${list.length}`)
    list.forEach((o, k) => out.push(`${k + 1}=0x${hex4(o.index)}`))
    out.push('')
  }
  for (const o of objects) {
    const id = hex4(o.index)
    if (o.var) {
      out.push(...edsObjectLines(o.var, id), '')
      continue
    }
    out.push(`[${id}]`, `ParameterName=${eds306(o.name, 241)}`, `ObjectType=0x${o.objectType}`)
    out.push(`SubNumber=${o.subs.length}`, '')
    for (const s of o.subs) out.push(...edsObjectLines(s, `${id}sub${s.subIndex.toString(16).toUpperCase()}`), '')
  }
  return out.join('\r\n')
}

const NS = 'http://www.canopen.org/xml/1.1'

function xmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function xmlAttr(s: string): string {
  return xmlText(s).replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;')
}

function isoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function isoTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** CiA 311 PDOmapping of an object: the direction of an rwr or rww object goes here. */
export function xddPdoMapping(o: CanopenObject): string {
  if (!o.pdoMapping) return 'no'
  if (o.access === 'rwr') return 'TPDO'
  if (o.access === 'rww') return 'RPDO'
  return 'optional'
}

/** CiA 311 accessType of an object: rwr and rww are written as rw. */
export function xddAccess(o: CanopenObject): string {
  return o.access === 'rwr' || o.access === 'rww' ? 'rw' : o.access
}

function xddObjectAttrs(o: CanopenObject, sub: boolean): string {
  const parts = [
    sub ? `subIndex="${o.subIndex.toString(16).toUpperCase().padStart(2, '0')}"` : undefined,
    `name="${xmlAttr(o.name)}"`,
    'objectType="7"',
    `dataType="${hex4(dataTypeCode(o.dataType) ?? 0)}"`,
    o.lowLimit !== undefined ? `lowLimit="${xmlAttr(o.lowLimit)}"` : undefined,
    o.highLimit !== undefined ? `highLimit="${xmlAttr(o.highLimit)}"` : undefined,
    `accessType="${xddAccess(o)}"`,
    o.defaultValue !== undefined ? `defaultValue="${xmlAttr(o.defaultValue)}"` : undefined,
    `PDOmapping="${xddPdoMapping(o)}"`,
  ]
  return parts.filter((p) => p !== undefined).join(' ')
}

function profileHeader(eds: CanopenEdsInfo, kind: 'Device' | 'CommunicationNetwork', now: Date): string {
  const id = kind === 'Device' ? 'CANopen device profile' : 'CANopen communication network profile'
  return [
    '<ProfileHeader>',
    `<ProfileIdentification>${id}</ProfileIdentification>`,
    '<ProfileRevision>1.1</ProfileRevision>',
    `<ProfileName>${xmlText(eds.productName || 'CANopen device')}</ProfileName>`,
    `<ProfileSource>${DEVICE_FILE_WRITER}</ProfileSource>`,
    `<ProfileClassID>${kind}</ProfileClassID>`,
    `<ProfileDate>${isoDate(now)}</ProfileDate>`,
    '<AdditionalInformation/>',
    '<ISO15745Reference><ISO15745Part>1</ISO15745Part><ISO15745Edition>1</ISO15745Edition>',
    '<ProfileTechnology>CANopen</ProfileTechnology></ISO15745Reference>',
    '</ProfileHeader>',
  ].join('')
}

function bodyAttrs(kind: string, options: WriteOptions): string {
  return [
    `xsi:type="c:${kind}"`,
    'formatName="CANopen"',
    'formatVersion="1.0"',
    `fileName="${xmlAttr(options.fileName)}"`,
    `fileCreator="${DEVICE_FILE_WRITER}"`,
    `fileCreationDate="${isoDate(options.now)}"`,
    `fileCreationTime="${isoTime(options.now)}"`,
    'fileVersion="1"',
  ].join(' ')
}

function deviceFunction(eds: CanopenEdsInfo): string {
  const label = (t: string): string => `<label lang="en">${xmlText(t)}</label>`
  // CiA 311 asks for at least one characteristic.
  const given = eds.details?.characteristics ?? []
  const list = (given.length > 0 ? given : [{ value: 'Product', label: eds.productName || 'CANopen device' }])
    .map(
      (c) =>
        `<c:characteristic><c:characteristicName>${label(c.value)}</c:characteristicName><c:characteristicContent>${label(c.label)}</c:characteristicContent></c:characteristic>`,
    )
    .join('')
  return `<c:DeviceFunction><c:capabilities><c:characteristicsList>${list}</c:characteristicsList></c:capabilities></c:DeviceFunction>`
}

/** A CiA 311 v1.1 XDD holding the description: identity, every object, bit rates and PDO counts. */
export function writeXdd(eds: CanopenEdsInfo, options: WriteOptions): string {
  const hex8 = (n: number): string => n.toString(16).toUpperCase().padStart(8, '0')
  const objects = describedObjects(eds).map((o) => {
    if (o.var) return `<CANopenObject index="${hex4(o.index)}" ${xddObjectAttrs(o.var, false)}/>`
    const subs = o.subs.map((s) => `<CANopenSubObject ${xddObjectAttrs(s, true)}/>`).join('\n')
    return `<CANopenObject index="${hex4(o.index)}" name="${xmlAttr(o.name)}" objectType="${o.objectType}" subNumber="${o.subs.length}">\n${subs}\n</CANopenObject>`
  })
  const supported = CANOPEN_BITRATES.filter((b) => !eds.unsupportedBitrates?.includes(b))
  const rates = supported.map((b) => `<supportedBaudRate value="${b / 1000} Kbps"/>`).join('')
  const order = eds.details?.orderNumber ? `<c:orderNumber>${xmlText(eds.details.orderNumber)}</c:orderNumber>` : ''
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<c:ISO15745ProfileContainer xmlns:c="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    '<c:ISO15745Profile>',
    profileHeader(eds, 'Device', options.now),
    `<ProfileBody ${bodyAttrs('ProfileBody_Device_CANopen', options)}>`,
    '<c:DeviceIdentity>',
    `<c:vendorName>${xmlText(eds.vendorName)}</c:vendorName>`,
    `<c:vendorID>${hex8(eds.vendorId)}</c:vendorID>`,
    `<c:productName>${xmlText(eds.productName)}</c:productName>`,
    `<c:productID>${hex8(eds.productCode)}</c:productID>`,
    order,
    '</c:DeviceIdentity>',
    deviceFunction(eds),
    '</ProfileBody>',
    '</c:ISO15745Profile>',
    '<c:ISO15745Profile>',
    profileHeader(eds, 'CommunicationNetwork', options.now),
    `<ProfileBody ${bodyAttrs('ProfileBody_CommunicationNetwork_CANopen', options)}>`,
    '<ApplicationLayers>',
    '<c:CANopenObjectList>',
    ...objects,
    '</c:CANopenObjectList>',
    '</ApplicationLayers>',
    `<TransportLayers><PhysicalLayer><baudRate defaultValue="${supported.includes(250000) ? 250 : (supported[0] ?? 250000) / 1000} Kbps">${rates}</baudRate></PhysicalLayer></TransportLayers>`,
    '<NetworkManagement>',
    `<CANopenGeneralFeatures granularity="8" nrOfRxPDO="${eds.rxPdoCount}" nrOfTxPDO="${eds.txPdoCount}"/>`,
    '</NetworkManagement>',
    '</ProfileBody>',
    '</c:ISO15745Profile>',
    '</c:ISO15745ProfileContainer>',
  ]
    .filter((l) => l !== '')
    .join('\n')
    .concat('\n')
}
