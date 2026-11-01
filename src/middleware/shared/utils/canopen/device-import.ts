/**
 * Adding a node from an EDS, DCF, XDD or XDC and replacing a node's device file: decode, check, parse, and
 * the network's store of device files (one copy per SHA-256 in `CanopenConfig.files`).
 */

import type {
  CanopenConfig,
  CanopenDeviceSource,
  CanopenEdsInfo,
  CanopenNode,
  CanopenPdo,
} from '../../ports/canopen-types'
import { accessFits, objectRef, toCanopenDataType } from './data-types'
import { type DcfContent, type DcfImportLine, hasDcfSettings, readDcfContent } from './dcf-import'
import { decodeDeviceFile, type DeviceFileEncoding, deviceFileFormat, deviceFileHash } from './device-file'
import { checkEds } from './eds-check'
import { readEdsDocument } from './eds-document'
import { EdsParseError, findObject, masterMayWrite, parseEdsDocument } from './eds-parser'
import {
  type AllocateAddress,
  canBeGuarded,
  canProduceHeartbeat,
  canReceiveTime,
  canWatchMaster,
  consumerSlots,
  defaultPdos,
  edsPdo,
  edsPdoNumbers,
  type PdoDirection,
  pdoObjectIndices,
  restoreChoices,
} from './model'
import { checkXdd, type DeviceFileCheckResult } from './xdd-check'
import { parseXdd, xdcToDcfContent } from './xdd-parser'

export interface PreparedDeviceFile {
  fileName: string
  text: string
  encoding: DeviceFileEncoding
  check: DeviceFileCheckResult
  /** The description, when the file could be read and the check found no error. */
  eds?: CanopenEdsInfo
  /** The DCF part; `hasSettings` tells whether there is anything to take. */
  dcf: DcfContent
  hasSettings: boolean
  source: CanopenDeviceSource
}

/** Decodes, checks and reads a chosen device file. */
export async function prepareDeviceFile(fileName: string, bytes: Uint8Array): Promise<PreparedDeviceFile> {
  const { text, encoding } = decodeDeviceFile(bytes)
  const format = deviceFileFormat(fileName)
  if (format === 'xdd' || format === 'xdc') {
    const source: CanopenDeviceSource = { format, fileName, sha256: await deviceFileHash(text) }
    let read: ReturnType<typeof parseXdd> | undefined
    try {
      read = parseXdd(text, fileName)
    } catch (e) {
      if (!(e instanceof EdsParseError)) throw e
    }
    const check = checkXdd(text, read?.eds)
    const dcf: DcfContent = read ? xdcToDcfContent(read.xdc) : { values: [], denotations: new Map() }
    const eds = read && check.ok ? { ...read.eds, source } : undefined
    return { fileName, text, encoding, check, eds, dcf, hasSettings: hasDcfSettings(dcf), source }
  }
  const doc = readEdsDocument(text)
  const check = checkEds(doc, { encoding, format })
  const source: CanopenDeviceSource = {
    format,
    fileName,
    sha256: await deviceFileHash(text),
  }
  const dcf = readDcfContent(doc)
  const eds = check.ok ? { ...parseEdsDocument(doc, fileName), source } : undefined
  return { fileName, text, encoding, check, eds, dcf, hasSettings: hasDcfSettings(dcf), source }
}

/** The config with the file stored (once per SHA-256) and files no node uses removed. */
export function withStoredFile(
  config: CanopenConfig,
  file: { source: CanopenDeviceSource; text: string },
): CanopenConfig {
  const files = { ...(config.files ?? {}), [file.source.sha256]: { fileName: file.source.fileName, text: file.text } }
  return pruneStoredFiles({ ...config, files })
}

/** The config without stored files that no node refers to. */
export function pruneStoredFiles(config: CanopenConfig): CanopenConfig {
  if (!config.files) return config
  const used = new Set(config.nodes.flatMap((n) => (n.eds.source ? [n.eds.source.sha256] : [])))
  const kept = Object.fromEntries(Object.entries(config.files).filter(([hash]) => used.has(hash)))
  if (Object.keys(kept).length === Object.keys(config.files).length) return config
  return Object.keys(kept).length > 0 ? { ...config, files: kept } : { network: config.network, nodes: config.nodes }
}

/** The node's stored file text, when the network has it. */
export function storedFileText(config: CanopenConfig, node: CanopenNode): string | undefined {
  const hash = node.eds.source?.sha256
  return hash ? config.files?.[hash]?.text : undefined
}

export interface ReplaceResult {
  node: CanopenNode
  dropped: DcfImportLine[]
}

/** What happens to the node's PDOs when its device file is replaced. */
export type ReplaceMapping = 'keep' | 'reset'

function keepPdos(
  node: CanopenNode,
  eds: CanopenEdsInfo,
  direction: PdoDirection,
  newId: () => string,
  allocate: AllocateAddress,
  dropped: DcfImportLine[],
): CanopenPdo[] {
  const label = direction === 'input' ? 'TPDO' : 'RPDO'
  const old = direction === 'input' ? node.tpdos : node.rpdos
  const numbers = new Set(edsPdoNumbers(eds, direction))
  const out: CanopenPdo[] = []
  for (const was of old) {
    if (!numbers.has(was.number)) {
      const { comm } = pdoObjectIndices(direction, was.number)
      dropped.push({
        what: `${label} ${was.number}`,
        detail: `the new file has no 0x${comm.toString(16).toUpperCase()}`,
      })
      continue
    }
    const fresh = edsPdo(eds, direction, was.number, node.nodeId, newId, was.exchanged ? allocate : undefined)
    const entries = was.entries.filter((e) => {
      const object = findObject(eds, e.index, e.subIndex)
      const fits =
        object !== undefined &&
        object.pdoMapping &&
        toCanopenDataType(object.dataType) === e.dataType &&
        accessFits(object.access, direction)
      if (!fits) dropped.push({ what: objectRef(e.index, e.subIndex), detail: `entry of ${label} ${was.number}` })
      return fits
    })
    out.push({ ...was, fixedMapping: fresh.fixedMapping, entries: fresh.fixedMapping ? fresh.entries : entries })
    if (fresh.fixedMapping && !was.fixedMapping)
      dropped.push({
        what: `${label} ${was.number}`,
        detail: 'the new file fixes its mapping; its default mapping is used',
      })
  }
  return out
}

function resetPdos(
  node: CanopenNode,
  eds: CanopenEdsInfo,
  direction: PdoDirection,
  newId: () => string,
  allocate: AllocateAddress,
  dropped: DcfImportLine[],
): CanopenPdo[] {
  const label = direction === 'input' ? 'TPDO' : 'RPDO'
  for (const was of direction === 'input' ? node.tpdos : node.rpdos)
    for (const e of was.entries)
      dropped.push({
        what: objectRef(e.index, e.subIndex),
        detail: `entry of ${label} ${was.number}${e.alias ? `, alias ${e.alias}` : ''}`,
      })
  return defaultPdos(eds, direction, node.nodeId, newId, allocate)
}

/**
 * The node with its device file replaced: ID, name, settings, mapped entries (with their addresses
 * and aliases, unless `mapping` is `reset`) and startup SDOs are kept wherever the new file still allows them.
 */
export function replaceDeviceFile(
  node: CanopenNode,
  eds: CanopenEdsInfo,
  newId: () => string,
  allocate: AllocateAddress,
  mapping: ReplaceMapping = 'keep',
): ReplaceResult {
  const dropped: DcfImportLine[] = []
  const sdos = node.sdos.filter((s) => {
    const object = findObject(eds, s.index, s.subIndex)
    const fits = object !== undefined && masterMayWrite(object) && toCanopenDataType(object.dataType) === s.dataType
    if (!fits) dropped.push({ what: objectRef(s.index, s.subIndex), detail: `startup SDO ${s.value}` })
    return fits
  })
  let next: CanopenNode = {
    ...node,
    eds,
    sdos,
    tpdos: (mapping === 'keep' ? keepPdos : resetPdos)(node, eds, 'input', newId, allocate, dropped),
    rpdos: (mapping === 'keep' ? keepPdos : resetPdos)(node, eds, 'output', newId, allocate, dropped),
  }
  if (next.supervision === 'heartbeat' && !canProduceHeartbeat(eds)) {
    next = { ...next, supervision: 'none' }
    dropped.push({ what: 'Supervision', detail: 'heartbeat (the new file has no writable 0x1017)' })
  } else if (next.supervision === 'guarding' && !canBeGuarded(eds)) {
    next = { ...next, supervision: 'none' }
    dropped.push({ what: 'Supervision', detail: 'node guarding (the new file has no writable 0x100C and 0x100D)' })
  }
  if (next.watchMaster.enabled && !canWatchMaster(eds)) {
    next = { ...next, watchMaster: { ...next.watchMaster, enabled: false } }
    dropped.push({ what: 'Watch the master', detail: 'the new file has no writable 0x1016' })
  }
  const slots = consumerSlots(eds) - (next.watchMaster.enabled ? 1 : 0)
  if (next.heartbeatConsumers.length > Math.max(0, slots)) {
    for (const c of next.heartbeatConsumers.slice(Math.max(0, slots)))
      dropped.push({ what: 'Heartbeat consumer', detail: `node ${c.producerNodeId}` })
    next = { ...next, heartbeatConsumers: next.heartbeatConsumers.slice(0, Math.max(0, slots)) }
  }
  if (next.receiveTime && !canReceiveTime(eds)) {
    next = { ...next, receiveTime: false }
    dropped.push({ what: 'TIME', detail: 'the new file has no writable 0x1012' })
  }
  if (next.restoreDefaults > 0 && !restoreChoices(eds).includes(next.restoreDefaults)) {
    dropped.push({ what: 'Restore defaults', detail: `0x1011 sub ${next.restoreDefaults}` })
    next = { ...next, restoreDefaults: 0 }
  }
  return { node: next, dropped }
}
