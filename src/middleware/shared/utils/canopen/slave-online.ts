/**
 * The CANopen slave's Online tab: what the runtime reports about a running slave, read against the
 * project. Values decoded by the project's types, the settings the master changed since the slave's
 * start, the one notice the tab shows, and the events as text.
 */

import type { CanopenSlaveEvent, CanopenSlavePdoStatus, CanopenSlaveStatus } from '../../ports/canopen-status'
import type {
  CanopenSlaveConfig,
  CanopenSlaveObject,
  CanopenSlaveOnMasterLost,
  CanopenSlaveOnPlcStop,
  CanopenSlaveOnPlcStopState,
} from '../../ports/canopen-types'
import { canopenTypeBits, objectRef } from './data-types'
import { busStateLabel, emcyText, hex, resetText, sdoAbortText } from './diagnostics'
import { formatCanopenValue, type ValueDisplay } from './online'
import {
  isSlavePacked,
  isSlaveString,
  parseSlaveValue,
  SLAVE_PDO_COUNT,
  slaveBitsOn,
  slavePdoLayout,
  slaveTpdoSettings,
} from './slave'

// ---- values ----

/** The bytes of a value the runtime reports as little-endian hex. */
export function slaveValueBytes(data: string): number[] {
  return (data.match(/[0-9a-fA-F]{2}/g) ?? []).map((b) => parseInt(b, 16))
}

/** The runtime's value of an object in the tab's display, or "-" when the runtime does not report it. */
export function slaveValueText(
  object: CanopenSlaveObject,
  slave: CanopenSlaveStatus | null,
  display: ValueDisplay,
): string {
  if (isSlaveString(object)) return object.defaultValue === '' ? '""' : `"${object.defaultValue}"`
  const data = slaveValueData(slave, object.index, object.subIndex)
  return data === undefined ? '-' : formatCanopenValue(object.dataType, slaveValueBytes(data), display)
}

/** The bits of a packed object's reported value: each bit's state, bit 0 first, and the names of those on. */
export function slavePackedValue(
  object: CanopenSlaveObject,
  slave: CanopenSlaveStatus | null,
): { on: boolean[]; names: string[] } | null {
  if (!isSlavePacked(object)) return null
  const data = slaveValueData(slave, object.index, object.subIndex)
  if (data === undefined) return null
  const byte = slaveValueBytes(data)[0] ?? 0
  return { on: (object.bits ?? []).map((_, i) => ((byte >> i) & 1) === 1), names: slaveBitsOn(object, byte) }
}

function slaveValueData(slave: CanopenSlaveStatus | null, index: number, subIndex: number): string | undefined {
  return slave?.values?.find((v) => v.index === index && v.subindex === subIndex)?.data
}

/** The project default of an object in the tab's display. */
export function slaveDefaultText(object: CanopenSlaveObject, display: ValueDisplay): string {
  if (isSlaveString(object)) return `"${object.defaultValue}"`
  const bytes = defaultBytes(object)
  return bytes ? formatCanopenValue(object.dataType, bytes, display) : object.defaultValue
}

/** The default's bytes as the runtime stores them, or null when the text is not a value of the type. */
function defaultBytes(object: CanopenSlaveObject): number[] | null {
  const type = object.dataType
  if (type === 'VISIBLE_STRING') return null
  const value = parseSlaveValue(object.defaultValue.trim() === '' ? '0' : object.defaultValue, type)
  if (value === null) return null
  const size = canopenTypeBits(type) / 8
  const view = new DataView(new ArrayBuffer(size))
  if (type === 'REAL32') view.setFloat32(0, value, true)
  else if (type === 'REAL64') view.setFloat64(0, value, true)
  else {
    let v = BigInt(value)
    if (v < 0n) v += 1n << BigInt(size * 8)
    for (let i = 0; i < size; i++) view.setUint8(i, Number((v >> BigInt(8 * i)) & 0xffn))
  }
  return Array.from(new Uint8Array(view.buffer))
}

// ---- settings changed by the master ----

export interface SlaveChange {
  /** `heartbeat`, `master_watch`, `on_master_lost`, `rx1`/`tx1`... for a PDO, or the object's ref for a value. */
  key: string
  /** What changed, for example "Heartbeat time" or "TPDO 1 mapping". */
  label: string
  project: string
  running: string
}

const ON_MASTER_LOST: Readonly<Record<CanopenSlaveOnMasterLost | 'other', string>> = {
  pre_operational: 'go pre-operational',
  no_change: 'no change',
  stopped: 'go stopped',
  other: 'another behaviour',
}

export function onMasterLostText(value: CanopenSlaveOnMasterLost | 'other'): string {
  return ON_MASTER_LOST[value]
}

const ON_PLC_STOP_STATE: Readonly<Record<CanopenSlaveOnPlcStopState | 'other', string>> = {
  none: 'no change',
  pre_operational: 'go pre-operational',
  stopped: 'go stopped',
  other: 'another behaviour',
}

export function onPlcStopStateText(value: CanopenSlaveOnPlcStopState | 'other'): string {
  return ON_PLC_STOP_STATE[value]
}

/** A PDO as the project's slave has it after a PLC start. */
export interface ExpectedSlavePdo {
  dir: 'rx' | 'tx'
  pdo: number
  valid: boolean
  cob_id: number
  transmission: number
  inhibit_100us: number
  event_ms: number
  mapping: { index: number; subindex: number; bits: number }[]
  objects: CanopenSlaveObject[]
}

/** Every RPDO and TPDO 1-4 of the project's slave, the unused ones invalid. */
export function expectedSlavePdos(config: CanopenSlaveConfig): ExpectedSlavePdo[] {
  const layout = slavePdoLayout(config)
  const tpdoSettings = slaveTpdoSettings(config)
  const out: ExpectedSlavePdo[] = []
  for (const dir of ['rx', 'tx'] as const) {
    const used = dir === 'rx' ? layout.rpdos : layout.tpdos
    for (let n = 1; n <= SLAVE_PDO_COUNT; n++) {
      const p = used.find((u) => u.number === n)
      const s = dir === 'tx' ? tpdoSettings[n - 1] : { transmissionType: 255, inhibitTime: 0, eventTimerMs: 0 }
      out.push({
        dir,
        pdo: n,
        valid: p !== undefined,
        cob_id: p?.cobId ?? 0,
        transmission: s.transmissionType,
        inhibit_100us: s.inhibitTime,
        event_ms: s.eventTimerMs,
        mapping: (p?.objects ?? []).map((o) => ({
          index: o.index,
          subindex: o.subIndex,
          bits: canopenTypeBits(o.dataType === 'VISIBLE_STRING' ? 'UNSIGNED8' : o.dataType),
        })),
        objects: p?.objects ?? [],
      })
    }
  }
  return out
}

export function pdoName(dir: 'rx' | 'tx', pdo: number): string {
  return `${dir === 'rx' ? 'RPDO' : 'TPDO'} ${pdo}`
}

/** How a PDO is sent, in words: "any time", "on change", "every 2 SYNC". */
export function transmissionText(dir: 'rx' | 'tx', transmission: number, inhibit100us = 0, eventMs = 0): string {
  const parts: string[] = []
  if (dir === 'rx') parts.push(transmission >= 254 ? 'any time' : 'at the SYNC')
  else if (transmission === 0) parts.push('at the SYNC after a change')
  else if (transmission <= 240) parts.push(transmission === 1 ? 'every SYNC' : `every ${transmission} SYNC`)
  else if (transmission >= 254) parts.push('on change')
  else parts.push(`type ${transmission}`)
  if (inhibit100us > 0) parts.push(`inhibit ${inhibit100us / 10} ms`)
  if (eventMs > 0) parts.push(`${dir === 'rx' ? 'timeout' : 'every'} ${eventMs} ms`)
  return parts.join(', ')
}

export function mappingText(
  mapping: readonly { index: number; subindex: number; bits: number }[],
  config: CanopenSlaveConfig,
): string {
  if (mapping.length === 0) return 'nothing mapped'
  const names = mapping.map(
    (m) =>
      config.objects.find((o) => o.index === m.index && o.subIndex === m.subindex)?.name ??
      objectRef(m.index, m.subindex),
  )
  const bytes = mapping.reduce((sum, m) => sum + m.bits, 0) / 8
  return `${names.join(', ')} (${bytes} of 8 bytes)`
}

const sameMapping = (a: ExpectedSlavePdo['mapping'], b: CanopenSlavePdoStatus['mapping']): boolean =>
  a.length === b.length &&
  a.every((m, i) => m.index === b[i].index && m.subindex === b[i].subindex && m.bits === b[i].bits)

function pdoChanges(expected: ExpectedSlavePdo, running: CanopenSlavePdoStatus, config: CanopenSlaveConfig) {
  const changes: SlaveChange[] = []
  const name = pdoName(expected.dir, expected.pdo)
  const key = `${expected.dir}${expected.pdo}`
  if (!expected.valid && !running.valid) return changes
  if (expected.valid !== running.valid) {
    changes.push({
      key,
      label: name,
      project: expected.valid ? 'in use' : 'not used',
      running: running.valid ? 'in use' : 'not used',
    })
    return changes
  }
  if (expected.cob_id !== running.cob_id)
    changes.push({ key, label: `${name} COB-ID`, project: hex(expected.cob_id, 3), running: hex(running.cob_id, 3) })
  if (expected.transmission !== running.transmission)
    changes.push({
      key,
      label: `${name} transmission`,
      project: transmissionText(expected.dir, expected.transmission),
      running: transmissionText(expected.dir, running.transmission),
    })
  if (expected.dir === 'tx' && expected.inhibit_100us !== (running.inhibit_100us ?? 0))
    changes.push({
      key,
      label: `${name} inhibit time`,
      project: `${expected.inhibit_100us / 10} ms`,
      running: `${(running.inhibit_100us ?? 0) / 10} ms`,
    })
  if (expected.event_ms !== running.event_ms)
    changes.push({
      key,
      label: `${name} ${expected.dir === 'tx' ? 'event timer' : 'timeout'}`,
      project: `${expected.event_ms} ms`,
      running: `${running.event_ms} ms`,
    })
  if (!sameMapping(expected.mapping, running.mapping))
    changes.push({
      key,
      label: `${name} mapping`,
      project: mappingText(expected.mapping, config),
      running: mappingText(running.mapping, config),
    })
  return changes
}

/**
 * The project's slave with the node ID the running slave uses, which an LSS master may have set;
 * the PDO COB-IDs that follow the node ID are then compared against it.
 */
export function slaveConfigInUse(config: CanopenSlaveConfig, slave: CanopenSlaveStatus): CanopenSlaveConfig {
  return slave.lss && slave.node_id !== null && slave.node_id !== config.nodeId
    ? { ...config, nodeId: slave.node_id }
    : config
}

/**
 * The settings where the running slave differs from the project's slave after a PLC start: the
 * heartbeat time, the master watch, the behaviour on master loss, each PDO, and the values of the
 * SDO parameters from the master (PDO objects change with every frame and are not compared).
 */
export function slaveChanges(project: CanopenSlaveConfig, slave: CanopenSlaveStatus): SlaveChange[] {
  const changes: SlaveChange[] = []
  const config = slaveConfigInUse(project, slave)
  if (slave.heartbeat_ms !== undefined && slave.heartbeat_ms !== config.heartbeatMs)
    changes.push({
      key: 'heartbeat',
      label: 'Heartbeat time',
      project: `${config.heartbeatMs} ms`,
      running: `${slave.heartbeat_ms} ms`,
    })
  if (slave.master_watch_ms !== undefined && slave.master_watch_ms !== config.masterWatch.timeMs)
    changes.push({
      key: 'master_watch',
      label: 'Master heartbeat allowed',
      project: config.masterWatch.timeMs > 0 ? `${config.masterWatch.timeMs} ms` : 'not watched',
      running: slave.master_watch_ms > 0 ? `${slave.master_watch_ms} ms` : 'not watched',
    })
  if (slave.on_master_lost !== undefined && slave.on_master_lost !== config.onMasterLost)
    changes.push({
      key: 'on_master_lost',
      label: 'When the master is lost',
      project: onMasterLostText(config.onMasterLost),
      running: onMasterLostText(slave.on_master_lost),
    })
  if (slave.on_plc_stop_state !== undefined && slave.on_plc_stop_state !== config.onPlcStopState)
    changes.push({
      key: 'on_plc_stop_state',
      label: 'When the PLC stops: NMT state',
      project: onPlcStopStateText(config.onPlcStopState),
      running: onPlcStopStateText(slave.on_plc_stop_state),
    })
  if (slave.pdos && slave.node_id !== null)
    for (const expected of expectedSlavePdos(config)) {
      const running = slave.pdos.find((p) => p.dir === expected.dir && p.pdo === expected.pdo)
      if (running) changes.push(...pdoChanges(expected, running, config))
    }
  for (const object of config.objects) {
    if (object.direction !== 'from_master' || object.exchange !== 'sdo' || isSlaveString(object)) continue
    const data = slaveValueData(slave, object.index, object.subIndex)
    const expected = defaultBytes(object)
    if (data === undefined || !expected) continue
    const bytes = slaveValueBytes(data)
    if (bytes.length === expected.length && bytes.every((b, i) => b === expected[i])) continue
    changes.push({
      key: objectRef(object.index, object.subIndex),
      label: object.name,
      project: formatCanopenValue(object.dataType, expected, 'decimal'),
      running: formatCanopenValue(object.dataType, bytes, 'decimal'),
    })
  }
  return changes
}

// ---- what the tab says ----

/** What the runtime runs differs from the project: another node ID, interface or object list. */
export interface SlaveVersionDiff {
  nodeId: boolean
  interface: boolean
  /** Project objects the runtime does not report. */
  missing: number
  /** Objects the runtime reports that the project does not have. */
  extra: number
  runningObjects: number
}

export function slaveVersionDiff(config: CanopenSlaveConfig, slave: CanopenSlaveStatus): SlaveVersionDiff | null {
  const project = config.objects.filter((o) => !isSlaveString(o)).map((o) => objectRef(o.index, o.subIndex))
  const running = (slave.values ?? []).map((v) => objectRef(v.index, v.subindex))
  const diff: SlaveVersionDiff = {
    nodeId: (slave.lss ? slave.lss.project_node_id : slave.node_id) !== config.nodeId,
    interface: slave.interface !== config.interface.trim(),
    missing: project.filter((r) => !running.includes(r)).length,
    extra: running.filter((r) => !project.includes(r)).length,
    runningObjects: running.length,
  }
  return diff.nodeId || diff.interface || diff.missing > 0 || diff.extra > 0 ? diff : null
}

export type SlaveNotice =
  | { kind: 'not_connected' }
  | { kind: 'no_status' }
  | { kind: 'too_old' }
  | { kind: 'off' }
  | { kind: 'not_running' }
  | { kind: 'offline'; problem?: string }
  | { kind: 'master_lost'; since?: number; onMasterLost: CanopenSlaveOnMasterLost | 'other' }
  | {
      kind: 'plc_stopped'
      since?: number
      onPlcStop: CanopenSlaveOnPlcStop
      onPlcStopState: CanopenSlaveOnPlcStopState | 'other'
    }
  | { kind: 'other_version'; diff: SlaveVersionDiff }
  | { kind: 'changed'; count: number }

/** The notices that leave nothing live to show; the tab shows only the notice. */
export function noticeHidesLiveData(notice: SlaveNotice | null): boolean {
  return (
    notice !== null &&
    (notice.kind === 'not_connected' ||
      notice.kind === 'no_status' ||
      notice.kind === 'too_old' ||
      notice.kind === 'off' ||
      notice.kind === 'not_running' ||
      notice.kind === 'offline')
  )
}

export interface SlaveNoticeInput {
  config: CanopenSlaveConfig
  /** Connected to a runtime that reports the CANopen status. */
  connected: boolean
  answered: boolean
  slave: CanopenSlaveStatus | null
  changes: number
}

const lastEvent = (slave: CanopenSlaveStatus, match: (e: CanopenSlaveEvent) => boolean) =>
  slave.events?.find(match)?.time

/** The one notice the tab shows, by priority, or null when there is nothing to say. */
export function slaveNotice({ config, connected, answered, slave, changes }: SlaveNoticeInput): SlaveNotice | null {
  if (!connected) return { kind: 'not_connected' }
  if (!config.enabled) return { kind: 'off' }
  if (!answered) return { kind: 'no_status' }
  if (!slave) return { kind: 'not_running' }
  if (slave.bus === undefined) return { kind: 'too_old' }
  if (!slave.bus_open) return { kind: 'offline', problem: slave.problem }
  if (slave.master_node_id !== undefined && slave.master_seen === false && (slave.master_watch_ms ?? 0) > 0)
    return {
      kind: 'master_lost',
      since: lastEvent(slave, (e) => e.kind === 'heartbeat' && e.seen === false),
      onMasterLost: slave.on_master_lost ?? config.onMasterLost,
    }
  if (!slave.plc_running)
    return {
      kind: 'plc_stopped',
      since: lastEvent(slave, (e) => e.kind === 'plc' && e.running === false),
      onPlcStop: config.onPlcStop,
      onPlcStopState: slave.on_plc_stop_state ?? config.onPlcStopState,
    }
  const diff = slaveVersionDiff(config, slave)
  if (diff) return { kind: 'other_version', diff }
  if (changes > 0) return { kind: 'changed', count: changes }
  return null
}

export type NoticeTone = 'info' | 'warning' | 'error'

const localTime = (ms: number): string => new Date(ms).toLocaleTimeString()

const LOST_DOES: Readonly<Record<CanopenSlaveOnMasterLost | 'other', string>> = {
  pre_operational: 'so the slave went pre-operational',
  no_change: 'and the slave stays in its state',
  stopped: 'so the slave went stopped',
  other: 'and the slave did what its error behaviour (0x1029) says',
}

const STOP_STATE_DOES: Readonly<Record<CanopenSlaveOnPlcStopState | 'other', string>> = {
  none: '',
  pre_operational: "; it went pre-operational, and the master's NMT start brings it back",
  stopped: "; it went stopped, and the master's NMT start brings it back",
  other: '',
}

/** The notice as a tone and a text. */
export function slaveNoticeText(notice: SlaveNotice, config: CanopenSlaveConfig): { tone: NoticeTone; text: string } {
  switch (notice.kind) {
    case 'not_connected':
      return { tone: 'info', text: 'Not connected. Connect to the runtime to see this slave live.' }
    case 'no_status':
      return { tone: 'info', text: 'Reading the status from the runtime...' }
    case 'too_old':
      return { tone: 'info', text: 'This runtime is too old to show slaves live. Update the runtime.' }
    case 'off':
      return {
        tone: 'info',
        text: 'This slave is off in the project ("Run this slave"), so the runtime does not run it.',
      }
    case 'not_running':
      return {
        tone: 'info',
        text:
          'The runtime does not run this slave. Build and upload the project, then start the PLC once: the slave ' +
          'joins the bus at the first PLC start and stays on it while the PLC is stopped.',
      }
    case 'offline':
      return {
        tone: 'error',
        text: `The slave is not on the bus${notice.problem ? `: ${notice.problem}` : ''}. The runtime tries again every second.`,
      }
    case 'master_lost': {
      const at = notice.since !== undefined ? ` at ${localTime(notice.since)}` : ''
      return {
        tone: 'error',
        text:
          `The master is lost. Its heartbeat stopped${at}, ${LOST_DOES[notice.onMasterLost]}. Values from the ` +
          'master hold their last value. Check the cable and the master.',
      }
    }
    case 'plc_stopped': {
      const to =
        notice.onPlcStop === 'zero' ? 'values to the master are zero' : 'values to the master hold their last value'
      const state = STOP_STATE_DOES[notice.onPlcStopState]
      return {
        tone: 'warning',
        text:
          `The PLC is stopped. The slave stays on the bus and answers the master${state}. Values from the master ` +
          `are not read by the program; ${to} (settings "When the PLC stops" on General).`,
      }
    }
    case 'other_version': {
      const d = notice.diff
      const parts: string[] = []
      if (d.nodeId || d.interface) parts.push(`node ID ${config.nodeId}, ${config.interface} in the project`)
      if (d.missing > 0 || d.extra > 0) {
        const projectCount = config.objects.filter((o) => !isSlaveString(o)).length
        parts.push(`${d.runningObjects} objects, the project has ${projectCount}`)
      }
      const dash = d.missing > 0 ? ` Values of the ${d.missing} objects it does not have are shown as "-".` : ''
      return {
        tone: 'warning',
        text: `The runtime runs another version of this slave (${parts.join('; ')}).${dash} Build and upload to bring it up to date.`,
      }
    }
    case 'changed':
      return {
        tone: 'info',
        text:
          `The master changed ${notice.count} setting${notice.count === 1 ? '' : 's'} of this slave. They hold until ` +
          'the slave restarts; the project and its exported EDS keep their own values.',
      }
  }
}

// ---- state strip and events ----

const STATE_LABELS: Readonly<Record<CanopenSlaveStatus['state'], string>> = {
  boot_up: 'Boot-up',
  pre_operational: 'Pre-operational',
  operational: 'Operational',
  stopped: 'Stopped',
  unknown: 'Unknown',
  offline: 'Not on the bus',
}

export function slaveStateLabel(state: CanopenSlaveStatus['state']): string {
  return STATE_LABELS[state]
}

/** Who set the slave's NMT state, in words: "Started by the master (node 127)". */
export function slaveNmtByText(slave: CanopenSlaveStatus): string {
  const master = slave.master_node_id !== undefined ? ` (node ${slave.master_node_id})` : ''
  switch (slave.nmt_by ?? 'boot') {
    case 'master':
      return slave.state === 'operational' ? `Started by the master${master}` : `Set by the master${master}`
    case 'self':
      return 'By itself'
    case 'start_alone':
      return 'Started by itself (start alone)'
    case 'program':
      return slave.state === 'operational' ? 'Started by the PLC program' : 'Set by the PLC program'
    case 'plc_stop':
      return 'By the PLC stop'
    case 'boot':
      return slave.state === 'pre_operational' ? 'After its boot-up, waiting for the master' : 'After its boot-up'
  }
}

/** An age in words: "9 ms", "1.4 s", "41 s", "3 min". */
export function ageText(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 120) return `${Math.round(s)} s`
  if (s < 7200) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}

const refName = (config: CanopenSlaveConfig, index: number, subIndex: number): string => {
  const object = config.objects.find((o) => o.index === index && o.subIndex === subIndex)
  if (object) return ` (${object.name})`
  if (index === 0x1017) return ' (heartbeat time)'
  if (index === 0x1016) return ' (master watch)'
  if (index === 0x1029) return ' (error behaviour)'
  if (index === 0x1010) return ' (store parameters)'
  if (index === 0x1011) return ' (restore defaults)'
  const pdo = (base: number, what: string) =>
    index >= base && index < base + SLAVE_PDO_COUNT ? ` (${what} ${index - base + 1})` : ''
  return (
    pdo(0x1400, 'RPDO communication') ||
    pdo(0x1600, 'RPDO mapping') ||
    pdo(0x1800, 'TPDO communication') ||
    pdo(0x1a00, 'TPDO mapping')
  )
}

function nmtEventText(event: CanopenSlaveEvent): string {
  const label = slaveStateLabel(event.state ?? 'unknown')
  const state = label.toLowerCase()
  switch (event.by ?? 'boot') {
    case 'master':
      return state === 'operational'
        ? 'The master started the slave: operational.'
        : `The master set the slave ${state}.`
    case 'self':
      return `Went ${state} by itself.`
    case 'start_alone':
      return 'Went operational by itself (start alone).'
    case 'program':
      return state === 'operational'
        ? 'The PLC program started the slave: operational.'
        : `The PLC program set the slave ${state}.`
    case 'plc_stop':
      return `Went ${state} at the PLC stop (setting "When the PLC stops: NMT state").`
    case 'boot':
      return `${label} after its boot-up.`
  }
}

/** What a slave event says, without its time. */
export function slaveEventText(
  event: CanopenSlaveEvent,
  slave: CanopenSlaveStatus,
  config: CanopenSlaveConfig,
): string {
  const masterNode = slave.master_node_id !== undefined ? ` node ${slave.master_node_id}` : ''
  switch (event.kind) {
    case 'on_bus':
      return slave.node_id === null
        ? 'On the bus with no node ID, waiting for an LSS master.'
        : `On the bus as node ${slave.node_id}.`
    case 'nmt':
      return nmtEventText(event)
    case 'reset':
      return event.what === 'communication'
        ? "The master reset the slave's communication: communication objects back to the project."
        : 'The master reset the slave: every object back to the project.'
    case 'sdo_write': {
      const ref = objectRef(event.index ?? 0, event.subindex ?? 0)
      const name = refName(config, event.index ?? 0, event.subindex ?? 0)
      if (event.ok ?? true) return `The master wrote ${ref}${name}.`
      const code = event.abort_code
      return code !== undefined
        ? `The master's write to ${ref}${name} was refused: ${sdoAbortText(code)} (${hex(code, 8)}).`
        : `The master's write to ${ref}${name} was refused.`
    }
    case 'heartbeat':
      return event.seen ? `Heartbeat of master${masterNode} seen.` : `Heartbeat of master${masterNode} lost.`
    case 'emcy': {
      const code = event.code ?? 0
      const who = event.program ? 'The PLC program sent' : 'Sent'
      return `${who} EMCY ${hex(code, 4)}: ${emcyText(code)}, error register ${hex(event.register ?? 0, 2)}.`
    }
    case 'emcy_reset':
      return 'Sent EMCY 0x0000: no error active.'
    case 'plc':
      return event.running ? 'PLC started.' : 'PLC stopped.'
    case 'bus_state':
      return `${busStateLabel(event.bus_state ?? 'unknown')}.`
    case 'bus_reset':
      return event.outcome === 'done' || event.outcome === undefined
        ? 'The runtime reset the bus-off link; the slave went on without a new boot-up.'
        : resetText(event.outcome, 'bus_off')
  }
}

/** Whether an event is a warning (amber) or an error (red) in the list. */
export function slaveEventTone(event: CanopenSlaveEvent): NoticeTone {
  if (event.kind === 'emcy' || event.kind === 'bus_reset') return 'error'
  if (event.kind === 'heartbeat' && event.seen === false) return 'error'
  if (event.kind === 'sdo_write' && event.ok === false) return 'warning'
  if (event.kind === 'nmt' && event.by === 'self') return 'warning'
  if (event.kind === 'bus_state' && event.bus_state !== 'error_active') return 'warning'
  return 'info'
}

// ---- LSS ----

/** One fact of the slave's LSS card. */
export interface SlaveLssFact {
  key: 'node_id' | 'bitrate' | 'serial' | 'state'
  label: string
  value: string
  detail: string
}

function bitrateText(bitrate: number | undefined): string {
  if (!bitrate) return 'Set on the interface'
  return bitrate >= 1000000 ? `${bitrate / 1000000} Mbit/s` : `${bitrate / 1000} kbit/s`
}

/** The node ID, bit rate, serial number and LSS state of a running LSS slave, or null without LSS. */
export function slaveLssFacts(slave: CanopenSlaveStatus): SlaveLssFact[] | null {
  const lss = slave.lss
  if (!lss) return null
  const projectNode = `project ${lss.project_node_id}`
  const nodeDetail: Record<typeof lss.node_id_from, string> = {
    none: 'Waiting for an LSS master to give one',
    project: 'From the project',
    stored: `Stored by an LSS master (${projectNode})`,
    lss: `Given by an LSS master, not stored (${projectNode})`,
  }
  const serial = slave.serial
  return [
    {
      key: 'node_id',
      label: 'Node ID in use',
      value: slave.node_id === null ? 'None' : String(slave.node_id),
      detail: nodeDetail[lss.node_id_from],
    },
    {
      key: 'bitrate',
      label: 'Bit rate in use',
      value: bitrateText(lss.bitrate),
      detail:
        lss.bitrate_from === 'stored'
          ? `Stored by an LSS master (project ${bitrateText(lss.project_bitrate).toLowerCase()})`
          : 'From the project',
    },
    {
      key: 'serial',
      label: 'Serial number',
      value: serial === undefined ? '-' : `${hex(serial, 8)} (${serial})`,
      detail: lss.serial_auto ? 'Picked by the runtime and kept' : 'From the project',
    },
    {
      key: 'state',
      label: 'LSS state',
      value: lss.state === 'configuration' ? 'Configuration' : 'Waiting',
      detail:
        lss.state === 'configuration' ? 'An LSS master selected the slave to configure it' : 'Answers an LSS master',
    },
  ]
}

/** What the runtime keeps for the slave from an LSS store, or null when nothing is stored. */
export function slaveLssStoredText(slave: CanopenSlaveStatus): string | null {
  const lss = slave.lss
  if (!lss || (lss.stored_node_id === undefined && lss.stored_bitrate === undefined)) return null
  const parts: string[] = []
  if (lss.stored_node_id !== undefined) parts.push(`node ID ${lss.stored_node_id}`)
  if (lss.stored_bitrate !== undefined) parts.push(bitrateText(lss.stored_bitrate))
  return `Stored on the runtime: ${parts.join(', ')}. Stored values win over the project at every start and upload.`
}

/** The question before Forget, naming what the slave starts with afterwards. */
export function slaveLssForgetText(config: CanopenSlaveConfig, waitForMaster: boolean): string {
  const node = waitForMaster ? 'no node ID, waiting for an LSS master' : `node ID ${config.nodeId}`
  return `Forget the node ID and bit rate an LSS master stored? The slave restarts with the project's values (${node}, ${bitrateText(config.bitrate).toLowerCase()}).`
}
