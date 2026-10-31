/**
 * Settings from a DCF (CiA 306 5): ParameterValue, Denotation and [DeviceComissioning] mapped to a
 * node, the inverse of what generate-canopen-config writes. Values that are no node setting become
 * startup SDOs; what cannot be taken is listed for the import dialog.
 */

import type {
  CanopenConfig,
  CanopenEdsInfo,
  CanopenNewNodeDefaults,
  CanopenNode,
  CanopenObject,
  CanopenOnCommError,
  CanopenSdo,
} from '../../ports/canopen-types'
import { objectRef, toCanopenDataType } from './data-types'
import { NEVER_WRITTEN_INDICES } from './editing'
import { commissioningSection, type EdsDocument } from './eds-document'
import { findObject, masterMayWrite } from './eds-parser'
import { EDS_TYPES, parseEdsIntegerText, parseEdsReal } from './eds-values'
import {
  type AllocateAddress,
  canWatchMaster,
  consumerTimeFor,
  createCanopenNode,
  defaultEmcyCobId,
  defaultNewNodeDefaults,
  edsDefault,
  lowestFreeNodeId,
  nodeNameFromEds,
  toNodeName,
  uniqueNodeName,
  withEntryAlias,
} from './model'
import { watchMasterProblem } from './validate-canopen-config'

/** [DeviceComissioning] of a DCF (CiA 306 5). */
export interface CanopenCommissioning {
  nodeId?: number
  nodeName?: string
  /** kbit/s, as the DCF writes it. */
  baudrateKbit?: number
  netNumber?: number
  networkName?: string
  canopenManager?: boolean
  lssSerialNumber?: number
}

export interface DcfValue {
  index: number
  subIndex: number
  /** ParameterValue as written. */
  value: string
}

export interface DcfContent {
  values: DcfValue[]
  /** Denotation by "0xIIII:SS". */
  denotations: Map<string, string>
  commissioning?: CanopenCommissioning
}

const OBJECT = /^([0-9A-F]{4})(SUB([0-9A-F]+))?$/
const LIST = /^([0-9A-F]{4})(VALUE|DENOTATION)$/

function plain(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined
  const v = parseEdsIntegerText(text)
  return v && !v.nodeId ? Number(v.value) : undefined
}

/** The DCF part of a read file: its values, names and commissioning. */
export function readDcfContent(doc: EdsDocument): DcfContent {
  const values: DcfValue[] = []
  const denotations = new Map<string, string>()
  for (const [upper, section] of doc.sections) {
    const m = OBJECT.exec(upper)
    if (m) {
      const index = parseInt(m[1], 16)
      const subIndex = m[3] ? parseInt(m[3], 16) : 0
      const value = section.entries.get('parametervalue')?.value
      if (value !== undefined && value !== '') values.push({ index, subIndex, value })
      const denotation = section.entries.get('denotation')?.value
      if (denotation) denotations.set(objectRef(index, subIndex), denotation)
      continue
    }
    const l = LIST.exec(upper)
    if (!l) continue
    const index = parseInt(l[1], 16)
    for (const [key, entry] of section.entries) {
      if (!/^\d+$/.test(key) || entry.value === '') continue
      const subIndex = Number(key)
      if (l[2] === 'VALUE') values.push({ index, subIndex, value: entry.value })
      else denotations.set(objectRef(index, subIndex), entry.value)
    }
  }
  values.sort((a, b) => a.index - b.index || a.subIndex - b.subIndex)
  const c = commissioningSection(doc)
  let commissioning: CanopenCommissioning | undefined
  if (c) {
    const get = (k: string): string | undefined => c.entries.get(k.toLowerCase())?.value
    const manager = plain(get('CANopenManager'))
    commissioning = {
      ...(plain(get('NodeID')) !== undefined ? { nodeId: plain(get('NodeID')) } : {}),
      ...(get('NodeName') ? { nodeName: get('NodeName') } : {}),
      ...(plain(get('Baudrate')) !== undefined ? { baudrateKbit: plain(get('Baudrate')) } : {}),
      ...(plain(get('NetNumber')) !== undefined ? { netNumber: plain(get('NetNumber')) } : {}),
      ...(get('NetworkName') ? { networkName: get('NetworkName') } : {}),
      ...(manager !== undefined ? { canopenManager: manager === 1 } : {}),
      ...(plain(get('LSS_SerialNumber')) !== undefined ? { lssSerialNumber: plain(get('LSS_SerialNumber')) } : {}),
    }
  }
  return { values, denotations, commissioning }
}

/** Whether the file carries settings to take (ParameterValue entries or [DeviceComissioning]). */
export function hasDcfSettings(content: DcfContent): boolean {
  return content.values.length > 0 || content.commissioning !== undefined
}

export interface DcfImportLine {
  /** "0x1800:05" or a setting name such as "Node ID". */
  what: string
  detail: string
}

export interface DcfImportResult {
  node: CanopenNode
  taken: DcfImportLine[]
  notTaken: DcfImportLine[]
  warnings: string[]
}

export interface DcfImportOptions {
  id: string
  newId: () => string
  allocate: AllocateAddress
  defaults?: CanopenNewNodeDefaults
  /** True when an alias is already used elsewhere in the project. */
  aliasTaken?: (alias: string) => boolean
}

/** Indices whose values become node settings rather than startup SDOs. */
function isSettingObject(index: number, subIndex: number): boolean {
  if ([0x1007, 0x100c, 0x100d, 0x1012, 0x1014, 0x1016, 0x1017].includes(index)) return true
  if (index === 0x1029 && subIndex === 1) return true
  return index >= 0x1400 && index <= 0x1bff
}

/** The value as a number with $NODEID resolved; null when it is not an integer. */
function intValue(text: string, nodeId: number): number | null {
  const v = parseEdsIntegerText(text)
  if (!v) return null
  const n = v.value + (v.nodeId ? BigInt(nodeId) : 0n)
  return Number(BigInt.asUintN(32, n))
}

/** The value as the startup SDO editor writes it (decimal or a REAL); null when it cannot be one. */
function sdoText(object: CanopenObject, text: string, nodeId: number): string | null {
  const type = toCanopenDataType(object.dataType)
  if (!type) return null
  if (type === 'REAL32' || type === 'REAL64') {
    const v = parseEdsReal(text, type === 'REAL32' ? 32 : 64)
    return v === null ? null : String(v)
  }
  const v = parseEdsIntegerText(text)
  if (!v) return null
  return String(v.value + (v.nodeId ? BigInt(nodeId) : 0n))
}

function sameValue(object: CanopenObject, a: string, b: string | undefined, nodeId: number): boolean {
  if (b === undefined) return false
  const x = sdoText(object, a, nodeId)
  const y = sdoText(object, b, nodeId)
  return x !== null && x === y
}

const ON_ERROR: Record<number, CanopenOnCommError> = { 0: 'pre_operational', 1: 'no_change', 2: 'stopped' }

/** The node ID the DCF asks for, when it is free in the network; else the lowest free one. */
function chooseNodeId(config: CanopenConfig, wanted: number | undefined): { nodeId: number | null; note?: string } {
  if (wanted !== undefined && wanted >= 1 && wanted <= 127) {
    const used = wanted === config.network.masterNodeId || config.nodes.some((n) => n.nodeId === wanted)
    if (!used) return { nodeId: wanted }
    const free = lowestFreeNodeId(config)
    return { nodeId: free, note: `node ID ${wanted} is in use, so the node gets ${free ?? 'none'}` }
  }
  return { nodeId: lowestFreeNodeId(config) }
}

/**
 * A node from a DCF with its settings taken. Throws when the network has no free node ID.
 * `eds` is the file's description; the DCF values are read from `content`.
 */
export function importDcfSettings(
  eds: CanopenEdsInfo,
  content: DcfContent,
  config: CanopenConfig,
  options: DcfImportOptions,
): DcfImportResult {
  const taken: DcfImportLine[] = []
  const notTaken: DcfImportLine[] = []
  const warnings: string[] = []
  const commissioning = content.commissioning ?? {}
  const network = config.network
  const defaults = options.defaults ?? network.newNodeDefaults ?? defaultNewNodeDefaults()

  const chosen = chooseNodeId(config, commissioning.nodeId)
  if (chosen.nodeId === null) throw new Error('All node IDs of the network are in use.')
  const nodeId = chosen.nodeId
  if (chosen.note) warnings.push(`NodeID ${commissioning.nodeId}: ${chosen.note}.`)
  else if (commissioning.nodeId !== undefined) taken.push({ what: 'Node ID', detail: String(nodeId) })
  const name = uniqueNodeName(
    config,
    commissioning.nodeName ? toNodeName(commissioning.nodeName) : nodeNameFromEds(eds),
  )
  if (commissioning.nodeName) taken.push({ what: 'Name', detail: name })
  if (commissioning.baudrateKbit !== undefined && commissioning.baudrateKbit * 1000 !== network.bitrate)
    warnings.push(
      `The file is for ${commissioning.baudrateKbit} kbit/s and the network runs ${network.bitrate / 1000} kbit/s; the network is not changed.`,
    )

  const byRef = new Map(content.values.map((v) => [objectRef(v.index, v.subIndex), v]))
  const value = (index: number, subIndex: number): number | null => {
    const v = byRef.get(objectRef(index, subIndex))
    return v ? intValue(v.value, nodeId) : null
  }

  // PDOs: the DCF values stand in for the defaults the node's PDOs are built from.
  const overlaid: CanopenEdsInfo = {
    ...eds,
    objects: eds.objects.map((o) => {
      const v = o.index >= 0x1400 && o.index <= 0x1bff ? byRef.get(objectRef(o.index, o.subIndex)) : undefined
      return v ? { ...o, defaultValue: v.value } : o
    }),
  }
  const built = createCanopenNode(overlaid, {
    id: options.id,
    name,
    nodeId,
    newId: options.newId,
    allocate: options.allocate,
    defaults,
  })
  let node: CanopenNode = { ...built, eds }
  const pdoValues = content.values.filter((v) => v.index >= 0x1400 && v.index <= 0x1bff).length
  if (pdoValues > 0)
    taken.push({
      what: 'PDOs',
      detail: `mapping and communication parameters (${pdoValues} ${pdoValues === 1 ? 'value' : 'values'})`,
    })

  // Supervision: heartbeat producer, else node guarding, else none.
  const producer = value(0x1017, 0)
  const guard = value(0x100c, 0)
  const life = value(0x100d, 0)
  if (producer !== null && producer > 0) {
    node = {
      ...node,
      supervision: 'heartbeat',
      heartbeatProducerMs: producer,
      heartbeatConsumerMs: consumerTimeFor(producer, defaults.heartbeatTimeoutPercent),
    }
    taken.push({ what: 'Supervision', detail: `heartbeat every ${producer} ms` })
  } else if (guard !== null && guard > 0 && life !== null && life > 0) {
    node = { ...node, supervision: 'guarding', guardTimeMs: guard, lifeTimeFactor: life }
    taken.push({ what: 'Supervision', detail: `node guarding, ${guard} ms, life time factor ${life}` })
  } else if (content.values.length > 0) {
    node = { ...node, supervision: 'none' }
    taken.push({ what: 'Supervision', detail: 'none (the file sets no heartbeat or node guarding)' })
  }

  // Emergency: the DCF's 0x1014, else the EDS default (the generator writes only a change).
  const emcy = value(0x1014, 0) ?? edsDefault(eds, 0x1014, 0, nodeId)
  if (emcy !== null && findObject(eds, 0x1014, 0)) {
    node = { ...node, emcy: { enabled: (emcy & 0x80000000) === 0, cobId: emcy & 0x7ff || defaultEmcyCobId(nodeId) } }
    if (value(0x1014, 0) !== null)
      taken.push({ what: 'Emergency', detail: emcy & 0x80000000 ? 'off' : `COB-ID 0x${(emcy & 0x7ff).toString(16)}` })
  }

  const time = value(0x1012, 0)
  if (time !== null) {
    const consumes = (time & 0x80000000) !== 0
    node = { ...node, receiveTime: consumes }
    taken.push({ what: 'TIME', detail: consumes ? 'received' : 'not received' })
    if (consumes && (!network.time.enabled || (time & 0x7ff) !== network.time.cobId))
      warnings.push(
        `The file receives TIME on COB-ID 0x${(time & 0x7ff).toString(16)}; the network ${network.time.enabled ? `sends it on 0x${network.time.cobId.toString(16)}` : 'sends no TIME'}.`,
      )
  }

  const syncWindow = value(0x1007, 0)
  if (syncWindow !== null && syncWindow !== network.syncWindowUs)
    notTaken.push({ what: objectRef(0x1007, 0), detail: `synchronous window ${syncWindow} µs is a network setting` })

  // Heartbeat consumers (0x1016): the master's entry, then other nodes of the network.
  const consumers = content.values.filter((v) => v.index === 0x1016 && v.subIndex >= 1)
  let watchesMaster = false
  const heartbeatConsumers: CanopenNode['heartbeatConsumers'] = []
  for (const v of consumers) {
    const entry = intValue(v.value, nodeId)
    if (entry === null) continue
    const producerId = (entry >>> 16) & 0x7f
    const ms = entry & 0xffff
    if (producerId === 0 || ms === 0) continue
    if (producerId === network.masterNodeId) {
      watchesMaster = true
      node = { ...node, watchMaster: { ...node.watchMaster, enabled: true, consumerMs: ms } }
      taken.push({ what: 'Watch the master', detail: `${ms} ms` })
    } else if (producerId !== nodeId && config.nodes.some((n) => n.nodeId === producerId)) {
      heartbeatConsumers.push({ id: options.newId(), producerNodeId: producerId, consumerMs: ms })
      taken.push({ what: objectRef(0x1016, v.subIndex), detail: `watches node ${producerId}, ${ms} ms` })
    } else {
      notTaken.push({
        what: objectRef(0x1016, v.subIndex),
        detail: `watches node ${producerId}, which the network does not have`,
      })
    }
  }
  if (content.values.length > 0 && canWatchMaster(eds) && !watchesMaster)
    node = { ...node, watchMaster: { ...node.watchMaster, enabled: false } }
  node = { ...node, heartbeatConsumers }
  const onError = value(0x1029, 1)
  if (watchesMaster && onError !== null && ON_ERROR[onError])
    node = { ...node, watchMaster: { ...node.watchMaster, onError: ON_ERROR[onError] } }

  // Everything else: a startup SDO when it changes a writable object.
  const sdos: CanopenSdo[] = []
  for (const v of content.values) {
    if (isSettingObject(v.index, v.subIndex)) continue
    const ref = objectRef(v.index, v.subIndex)
    const object = findObject(eds, v.index, v.subIndex)
    if (NEVER_WRITTEN_INDICES.has(v.index)) {
      notTaken.push({ what: ref, detail: 'store and restore commands are never written from a file' })
      continue
    }
    if (!object) {
      notTaken.push({ what: ref, detail: 'the file describes no such object' })
      continue
    }
    if (sameValue(object, v.value, object.defaultValue, nodeId)) continue
    if (!masterMayWrite(object)) {
      if (object.access !== 'ro' && object.access !== 'const')
        notTaken.push({ what: ref, detail: 'the object refuses a write on download (ObjFlags)' })
      continue
    }
    const type = toCanopenDataType(object.dataType)
    const text = sdoText(object, v.value, nodeId)
    if (!type || text === null) {
      const typeName = EDS_TYPES[parseInt(object.dataType.replace(/^0x/i, ''), 16)]?.name ?? object.dataType
      notTaken.push({ what: ref, detail: `${v.value} (${typeName}) cannot be a startup SDO` })
      continue
    }
    sdos.push({ id: options.newId(), index: v.index, subIndex: v.subIndex, dataType: type, value: text })
    taken.push({ what: ref, detail: `startup SDO ${text}` })
  }
  node = { ...node, sdos }

  // Aliases from Denotation on mapped entries.
  const mapped = new Set<string>()
  for (const pdo of [...node.tpdos, ...node.rpdos])
    for (const e of pdo.entries) {
      const ref = objectRef(e.index, e.subIndex)
      const alias = content.denotations.get(ref)
      if (!alias || mapped.has(ref)) continue
      mapped.add(ref)
      if (!e.iecLocation) {
        notTaken.push({ what: ref, detail: `name "${alias}": the entry's PDO is off` })
        continue
      }
      if (options.aliasTaken?.(alias)) {
        notTaken.push({ what: ref, detail: `name "${alias}" is already used in the project or is not a valid alias` })
        continue
      }
      node = withEntryAlias(node, e.channelId, alias)
      taken.push({ what: ref, detail: `alias ${alias}` })
    }
  for (const [ref, alias] of content.denotations)
    if (!mapped.has(ref)) notTaken.push({ what: ref, detail: `name "${alias}": the object is not mapped` })

  const watch = node.configure ? watchMasterProblem(node, network.heartbeatProducerMs) : null
  if (watch)
    warnings.push(
      `0x1016: ${watch}. The build refuses this until the master heartbeat or the node's wait time is changed.`,
    )
  return { node, taken, notTaken, warnings }
}
