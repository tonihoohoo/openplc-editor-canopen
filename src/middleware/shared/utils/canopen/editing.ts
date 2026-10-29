/**
 * Rules the CANopen device editor applies while the user edits PDOs and startup SDOs: the
 * transmission types a PDO may use, which communication parameters are written, the objects
 * offered as startup SDOs, object search and list moves. Pure.
 */

import type { CanopenEdsInfo, CanopenNode, CanopenObject } from '../../ports/canopen-types'
import { objectRef, toCanopenDataType } from './data-types'
import { findObject, parseEdsInteger } from './eds-parser'
import { isWritableObject, pdoActive, watchesMaster } from './generate-canopen-config'
import { type PdoDirection, pdoObjectIndices, RTR_TRANSMISSION_TYPES } from './model'

export type TransmissionMode = 'sync_acyclic' | 'sync_cyclic' | 'event_manufacturer' | 'event_profile'

export const TRANSMISSION_MODE_LABELS: Readonly<Record<TransmissionMode, string>> = {
  sync_acyclic: 'Sync, acyclic (0)',
  sync_cyclic: 'Sync, every N (1-240)',
  event_manufacturer: 'Event, manufacturer (254)',
  event_profile: 'Event, profile (255)',
}

/** The mode of a transmission type, or null for a reserved or RTR type. */
export function transmissionMode(type: number): TransmissionMode | null {
  if (type === 0) return 'sync_acyclic'
  if (type >= 1 && type <= 240) return 'sync_cyclic'
  if (type === 254) return 'event_manufacturer'
  if (type === 255) return 'event_profile'
  return null
}

/** Whether PDOs of this type act on SYNC. */
export function isSynchronousType(type: number): boolean {
  return type >= 0 && type <= 240
}

export interface TransmissionChoice {
  mode: TransmissionMode
  label: string
  /** Null when the mode can be chosen, else why not. */
  disabledReason: string | null
  /** The EDS's default type has this mode. */
  edsDefault: boolean
}

export interface TransmissionChoices {
  /** Null when the transmission type can be changed, else why not. */
  readOnlyReason: string | null
  choices: TransmissionChoice[]
  /** Range of N for "every N SYNC", within the EDS limits. */
  cyclicMin: number
  cyclicMax: number
  /** The EDS default, when it is an RTR type the editor replaced with 255. */
  replacedEdsDefault: number | null
}

function limits(object: CanopenObject | undefined, nodeId: number): { low: number; high: number } {
  const low = object?.lowLimit !== undefined ? parseEdsInteger(object.lowLimit, nodeId) : null
  const high = object?.highLimit !== undefined ? parseEdsInteger(object.highLimit, nodeId) : null
  return { low: low ?? 0, high: high ?? 255 }
}

/** The transmission types PDO `number` may use, from CiA 301 and the EDS. RTR types are never offered. */
export function transmissionChoices(
  eds: CanopenEdsInfo,
  direction: PdoDirection,
  number: number,
  nodeId: number,
): TransmissionChoices {
  const { comm } = pdoObjectIndices(direction, number)
  const object = findObject(eds, comm, 2)
  const { low, high } = limits(object, nodeId)
  const rawDefault = object?.defaultValue !== undefined ? parseEdsInteger(object.defaultValue, nodeId) : null
  const replaced = rawDefault !== null && RTR_TRANSMISSION_TYPES.includes(rawDefault)
  const defaultMode = transmissionMode(replaced ? 255 : (rawDefault ?? 255))
  const outside = 'Outside the range the EDS allows'
  const inRange = (v: number): boolean => v >= low && v <= high
  const cyclicMin = Math.max(1, low)
  const cyclicMax = Math.min(240, high)
  const modes: Array<[TransmissionMode, boolean]> = [
    ['sync_acyclic', inRange(0)],
    ['sync_cyclic', cyclicMin <= cyclicMax],
    ['event_manufacturer', inRange(254)],
    ['event_profile', inRange(255)],
  ]
  let readOnlyReason: string | null = null
  if (!object) readOnlyReason = 'The EDS has no transmission type for this PDO, so it is not written'
  else if (!isWritableObject(eds, comm, 2)) readOnlyReason = 'Read-only in the EDS, not written'
  return {
    readOnlyReason,
    choices: modes.map(([mode, allowed]) => ({
      mode,
      label: TRANSMISSION_MODE_LABELS[mode],
      disabledReason: allowed ? null : outside,
      edsDefault: mode === defaultMode,
    })),
    cyclicMin,
    cyclicMax: Math.max(cyclicMin, cyclicMax),
    replacedEdsDefault: replaced ? rawDefault : null,
  }
}

/** The transmission type a mode stands for; `cyclicN` is kept when the mode is "every N SYNC". */
export function transmissionTypeFor(mode: TransmissionMode, cyclicN: number): number {
  switch (mode) {
    case 'sync_acyclic':
      return 0
    case 'sync_cyclic':
      return cyclicN
    case 'event_manufacturer':
      return 254
    case 'event_profile':
      return 255
    default: {
      const never: never = mode
      return never
    }
  }
}

export interface ParameterState {
  /** "0x1800:05". */
  ref: string
  /** Null when the master writes the value, else why not. */
  notWrittenReason: string | null
}

/** Where a PDO communication parameter lives and whether the master writes it. */
export function pdoParameterState(
  eds: CanopenEdsInfo,
  direction: PdoDirection,
  number: number,
  subIndex: number,
): ParameterState {
  const { comm } = pdoObjectIndices(direction, number)
  return objectParameterState(eds, comm, subIndex)
}

/** Where a node parameter lives and whether the master writes it. */
export function objectParameterState(eds: CanopenEdsInfo, index: number, subIndex: number): ParameterState {
  const ref = objectRef(index, subIndex)
  if (!findObject(eds, index, subIndex)) return { ref, notWrittenReason: 'not in the EDS, not written' }
  if (!isWritableObject(eds, index, subIndex)) return { ref, notWrittenReason: 'read-only in the EDS, not written' }
  return { ref, notWrittenReason: null }
}

/** The object's name, with its array or record name in front for a sub-index. */
export function objectLabel(object: CanopenObject): string {
  return object.parentName && object.parentName !== object.name ? `${object.parentName} / ${object.name}` : object.name
}

/** Whether the object matches a search: index ("6401", "0x6401", "6401:1") or words of its names. */
export function matchesObjectQuery(object: CanopenObject, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const ref = /^(?:0x)?([0-9a-f]{1,4})(?::(?:0x)?([0-9a-f]{1,2}))?$/.exec(q)
  if (ref) {
    const index = parseInt(ref[1], 16)
    const indexHit = ref[1].length === 4 ? object.index === index : object.index.toString(16).startsWith(ref[1])
    if (indexHit && (ref[2] === undefined || object.subIndex === parseInt(ref[2], 16))) return true
  }
  const text = objectLabel(object).toLowerCase()
  return q.split(/\s+/).every((word) => text.includes(word))
}

/** Store and restore parameters; the master never writes them. */
export const NEVER_WRITTEN_INDICES: ReadonlySet<number> = new Set([0x1010, 0x1011])

export interface SdoCandidate {
  object: CanopenObject
  /** Null when the object is offered by default, else why it is normally hidden. */
  hiddenReason: string | null
}

function hiddenReason(node: CanopenNode, object: CanopenObject, rpdoMapped: ReadonlySet<string>): string | null {
  const { index, subIndex } = object
  const key = objectRef(index, subIndex)
  if (node.sdos.some((s) => s.index === index && s.subIndex === subIndex)) return 'Already in the list'
  if (index >= 0x1400 && index <= 0x1bff) return 'The editor writes it from the PDO settings'
  if (index === 0x1017) return 'The editor writes it from the supervision settings'
  if ((index === 0x1016 || index === 0x1029) && watchesMaster(node))
    return 'The editor writes it from "Watch the master"'
  if (subIndex === 0 && node.eds.objects.some((o) => o.index === index && o.subIndex > 0))
    return 'Number of entries, rarely a setting'
  if (rpdoMapped.has(key)) return 'Mapped in an RPDO, which overwrites it every cycle'
  return null
}

/** Writable objects of the node for a startup SDO, each with why it is hidden by default. */
export function startupSdoCandidates(node: CanopenNode): SdoCandidate[] {
  const rpdoMapped = new Set(
    node.rpdos.filter(pdoActive).flatMap((p) => p.entries.map((e) => objectRef(e.index, e.subIndex))),
  )
  return node.eds.objects
    .filter(
      (o) =>
        o.access !== 'ro' &&
        o.access !== 'const' &&
        !NEVER_WRITTEN_INDICES.has(o.index) &&
        toCanopenDataType(o.dataType) !== undefined,
    )
    .map((object) => ({ object, hiddenReason: hiddenReason(node, object, rpdoMapped) }))
}

/** The list with the item at `from` moved to `to`; unchanged when either is out of range. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list]
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}
