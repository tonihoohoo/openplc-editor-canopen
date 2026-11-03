/**
 * Export of a network or one node as a self-contained HTML document: network settings, nodes, CAN
 * identifiers, I/O list, PDO layouts, startup SDOs and boot writes. No scripts, no external files.
 */

import type {
  CanopenConfig,
  CanopenEntry,
  CanopenHtmlExportOptions,
  CanopenHtmlSection,
  CanopenNetworkSettings,
  CanopenNode,
  CanopenObject,
  CanopenPdo,
} from '../../ports/canopen-types'
import { canopenTypeBits, objectRef } from './data-types'
import type { DeviceFileExport } from './dcf-export'
import { objectLabel } from './editing'
import { findObject } from './eds-parser'
import { type BootWrite, nodeBootWrites } from './generate-canopen-config'
import { effectiveEmcy, effectiveProducerMs, isDummyEntry, pdoBits, restoreChoiceName } from './model'
import { describeValue, pdoMappingMeaning } from './object-info'

/** The sections in the order the dialog shows them, with their labels and how a left-out one is listed. */
export const HTML_SECTIONS: ReadonlyArray<{ section: CanopenHtmlSection; label: string; lost: string }> = [
  { section: 'network', label: 'Network', lost: 'the network settings' },
  { section: 'nodes', label: 'Nodes', lost: 'the table of the nodes' },
  { section: 'canIds', label: 'CAN identifiers', lost: 'the CAN identifier table' },
  { section: 'ioList', label: 'I/O list', lost: 'the I/O list' },
  { section: 'pdoPictures', label: 'PDO pictures', lost: 'the PDO pictures' },
  { section: 'sdos', label: 'Startup SDOs', lost: 'the startup SDOs' },
  { section: 'bootWrites', label: 'Boot writes', lost: 'the writes the master makes at boot' },
  { section: 'objects', label: 'Object dictionaries', lost: 'the object dictionaries' },
  { section: 'plcVariables', label: 'PLC variables', lost: 'the PLC variables that use each address' },
]

/** The sections in a document when the project has no choice stored: all but the object dictionaries. */
export function htmlSections(options: CanopenHtmlExportOptions | undefined): Set<CanopenHtmlSection> {
  const out = new Set<CanopenHtmlSection>()
  for (const { section } of HTML_SECTIONS) {
    const stored = options?.sections?.[section]
    if (stored ?? section !== 'objects') out.add(section)
  }
  return out
}

/** The config with new HTML export choices. */
export function withHtmlExportOptions(config: CanopenConfig, options: CanopenHtmlExportOptions): CanopenConfig {
  return { ...config, export: { ...config.export, html: options } }
}

/** What an HTML document does not hold: the sections left out first, then what it never holds. */
export function htmlLosses(config: CanopenConfig | undefined): string[] {
  const sections = htmlSections(config?.export?.html)
  const out = HTML_SECTIONS.filter((s) => !sections.has(s.section)).map((s) => `${s.lost} (left out above)`)
  out.push(
    'the device files themselves: only their names and SHA-256',
    'live values and node states from the online view',
    'anything the editor can read back: the document is for people only',
  )
  return out
}

/** A PLC variable that names an address or an alias in its location. */
export interface PlcVariableUse {
  pou: string
  variable: string
}

/** The variables of one POU, or of the global variable list (`pou` "global"). */
export interface PlcVariableList {
  pou: string
  variables: ReadonlyArray<{ name: string; location: string }>
}

/** The variables of the lists by the alias or the literal address their location holds. */
export function plcVariableUses(lists: readonly PlcVariableList[]): Map<string, PlcVariableUse[]> {
  const out = new Map<string, PlcVariableUse[]>()
  for (const list of lists)
    for (const v of list.variables) {
      const key = v.location.trim()
      if (!key) continue
      const uses = out.get(key) ?? []
      uses.push({ pou: list.pou, variable: v.name })
      out.set(key, uses)
    }
  return out
}

export interface HtmlExportInput {
  projectName: string
  networkName: string
  config: CanopenConfig
  /** From {@link plcVariableUses}. */
  uses: ReadonlyMap<string, readonly PlcVariableUse[]>
  sections: ReadonlySet<CanopenHtmlSection>
  editorVersion: string
  now: Date
  /** Only this node; the whole network when absent. */
  nodeId?: string
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hex = (n: number, width = 3): string => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`
const code = (s: string): string => `<code>${esc(s)}</code>`
const dim = (s: string): string => `<span class="dim">${s}</span>`
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const SYNC_MODE: Record<CanopenNetworkSettings['syncMode'], string> = {
  none: 'off',
  period: 'fixed period',
  plc_cycle: 'every PLC cycle',
}
const ON_PLC_STOP: Record<CanopenNetworkSettings['onPlcStop'], string> = {
  pre_operational: 'nodes to pre-operational',
  stopped: 'nodes to stopped',
  none: 'nodes keep running',
}
const SUPERVISION: Record<CanopenNode['supervision'], string> = {
  none: 'none',
  heartbeat: 'heartbeat',
  guarding: 'node guarding',
}
const ON_COMM_ERROR: Record<CanopenNode['watchMaster']['onError'], string> = {
  pre_operational: 'pre-operational',
  no_change: 'no change',
  stopped: 'stopped',
}

function bitrateText(bitrate: number): string {
  if (bitrate === 0) return 'set by the interface'
  return bitrate >= 1000000 ? `${bitrate / 1000000} Mbit/s` : `${bitrate / 1000} kbit/s`
}

function transmissionText(type: number): string {
  if (type === 0) return '0 (SYNC, acyclic)'
  if (type === 1) return '1 (every SYNC)'
  if (type <= 240) return `${type} (every ${type}th SYNC)`
  if (type === 254 || type === 255) return `${type} (event)`
  return String(type)
}

function kv(rows: ReadonlyArray<readonly [string, string]>): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

function table(head: readonly string[], rows: readonly string[][], className = ''): string {
  if (rows.length === 0) return '<p class="dim">None.</p>'
  const cls = className ? ` class="${className}"` : ''
  const th = head.map((h) => `<th>${esc(h)}</th>`).join('')
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
  return `<table${cls}><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

function entryObject(node: CanopenNode, entry: CanopenEntry): CanopenObject | undefined {
  return findObject(node.eds, entry.index, entry.subIndex)
}

function entryName(node: CanopenNode, entry: CanopenEntry): string {
  const object = entryObject(node, entry)
  return object ? objectLabel(object) : entry.name
}

function usesCell(input: HtmlExportInput, entry: CanopenEntry): string {
  const uses = [
    ...(entry.alias ? (input.uses.get(entry.alias) ?? []) : []),
    ...(input.uses.get(entry.iecLocation) ?? []),
  ]
  return uses.length ? uses.map((u) => code(`${u.pou}.${u.variable}`)).join('<br>') : dim('not used')
}

/** Unit, scaling, value meanings and bit names of an entry's object, from an XDD or XDC. */
function meaningCell(node: CanopenNode, entry: CanopenEntry): string {
  const info = entryObject(node, entry)?.info
  if (!info) return ''
  const parts: string[] = []
  if (info.unit) parts.push(esc(info.unit))
  if (info.multiplier !== undefined && info.multiplier !== 1) parts.push(`&times;${info.multiplier}`)
  if (info.offset) parts.push(`offset ${info.offset}`)
  if (info.values?.length) parts.push(info.values.map((v) => `${esc(v.value)} = ${esc(v.label)}`).join(', '))
  const text = parts.join(', ')
  if (!info.bits?.length) return text
  const bits = info.bits
    .map((b) => {
      const last = b.width && b.width > 1 ? `-${Number(b.value) + b.width - 1}` : ''
      return `<span class="b"><span class="bit">${esc(b.value)}${last}</span> ${esc(b.label)}</span>`
    })
    .join(' ')
  return `${text}${text ? '<br>' : ''}<span class="bits">${bits}</span>`
}

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d']

/** The PDO as a bar of bits: a byte ruler above one segment per entry; gaps hatched. */
function pdoPicture(node: CanopenNode, pdo: CanopenPdo): string {
  const total = Math.max(8, Math.ceil(pdoBits(pdo) / 8) * 8)
  let at = 0
  const segments = pdo.entries.map((entry, i) => {
    const bits = canopenTypeBits(entry.dataType)
    const gap = isDummyEntry(entry)
    const label = gap ? 'gap' : entry.alias ? entry.alias : entryName(node, entry)
    const range = bits > 1 ? `${at}-${at + bits - 1}` : `${at}`
    const colour = gap ? '' : `;--c:${PALETTE[i % PALETTE.length]}`
    const cell = `<div class="seg${gap ? ' gap' : ''}" style="grid-column:${at + 1} / span ${bits}${colour}" title="${esc(label)}"><span>${esc(label)}</span><small>bit ${range}</small></div>`
    at += bits
    return cell
  })
  const ruler = Array.from(
    { length: total / 8 },
    (_, b) => `<div class="tick" style="grid-column:${b * 8 + 1} / span 8">byte ${b}</div>`,
  )
  return `<div class="bar" style="grid-template-columns:repeat(${total},1fr)">${ruler.join('')}${segments.join('')}</div>`
}

function pdoBlock(input: HtmlExportInput, node: CanopenNode, pdo: CanopenPdo, kind: 'TPDO' | 'RPDO'): string {
  const facts = [
    `COB-ID ${code(hex(pdo.cobId))}${pdo.followsNodeId ? ' (node ID + base)' : ''}`,
    `transmission ${esc(transmissionText(pdo.transmissionType))}`,
  ]
  if (kind === 'TPDO') {
    if (pdo.eventTimerMs) facts.push(`event timer ${pdo.eventTimerMs} ms`)
    if (pdo.inhibitTime) facts.push(`inhibit ${pdo.inhibitTime / 10} ms`)
    if (pdo.receiveTimeoutMs) facts.push(`reported late after ${pdo.receiveTimeoutMs} ms`)
  } else if (pdo.deadlineMs) facts.push(`node deadline ${pdo.deadlineMs} ms`)
  if (!pdo.exchanged) facts.push('<b>not exchanged with the PLC</b>')
  if (pdo.fixedMapping) facts.push('fixed mapping')
  facts.push(plural(Math.ceil(pdoBits(pdo) / 8), 'byte'))
  const withUses = input.sections.has('plcVariables')
  const head = ['Bit', 'Bits', 'Object', 'Index', 'Type', 'Address', 'Alias', 'Unit / meaning']
  let at = 0
  const rows = pdo.entries.map((entry) => {
    const bits = canopenTypeBits(entry.dataType)
    const ref = code(objectRef(entry.index, entry.subIndex))
    const row = isDummyEntry(entry)
      ? [`${at}`, `${bits}`, dim('gap'), ref, esc(entry.dataType), '', '', '']
      : [
          `${at}`,
          `${bits}`,
          esc(entryName(node, entry)),
          ref,
          esc(entry.dataType),
          code(entry.iecLocation),
          entry.alias ? code(entry.alias) : '',
          meaningCell(node, entry),
        ]
    if (withUses) row.push(isDummyEntry(entry) ? '' : usesCell(input, entry))
    at += bits
    return row
  })
  if (withUses) head.push('PLC variables')
  const picture = input.sections.has('pdoPictures') ? pdoPicture(node, pdo) : ''
  return `<div class="pdo"><h4>${kind} ${pdo.number}</h4><p class="facts">${facts.join(' &middot; ')}</p>${picture}${table(head, rows, 'entries')}</div>`
}

const BOOT_SOURCE: Record<Exclude<BootWrite['source']['kind'], 'pdo'>, string> = {
  supervision: 'Supervision',
  emcy: 'Emergency messages',
  syncWindow: 'SYNC window',
  time: 'TIME',
  startup: 'Startup SDO',
  watchMaster: 'Watch the master',
  heartbeatConsumer: 'Heartbeat consumer',
}

function isCobIdObject(index: number, subIndex: number): boolean {
  const pdoComm = (index >= 0x1400 && index < 0x1600) || (index >= 0x1800 && index < 0x1a00)
  return (pdoComm && subIndex === 1) || index === 0x1012 || index === 0x1014
}

/** A boot write's value in words: COB-IDs, mapping entries and consumer entries decoded, else its meaning. */
function bootWriteValue(node: CanopenNode, write: BootWrite): string {
  const bytes = write.data.match(/../g) ?? []
  if (bytes.length === 0 || bytes.length > 4) return code(write.data)
  const value = parseInt([...bytes].reverse().join(''), 16) >>> 0
  const object = findObject(node.eds, write.index, write.subindex)
  const mapping = object ? pdoMappingMeaning(object, String(value), node.eds.objects) : undefined
  if (mapping) return `${code(hex(value, 8))} ${dim(esc(mapping))}`
  if (isCobIdObject(write.index, write.subindex)) {
    const off = (value & 0x80000000) !== 0
    const state = write.index === 0x1012 ? (off ? ', consumed' : '') : off ? ', switched off' : ''
    return `${code(hex(value, 8))} ${dim(`COB-ID ${hex(value & 0x7ff)}${state}`)}`
  }
  if (write.index === 0x1016)
    return `${code(hex(value, 8))} ${dim(`node ${(value >>> 16) & 0x7f}, ${value & 0xffff} ms`)}`
  return esc(describeValue(object, String(value)))
}

function bootWriteSource(write: BootWrite): string {
  const s = write.source
  return s.kind === 'pdo' ? `${s.direction === 'input' ? 'TPDO' : 'RPDO'} ${s.number}` : BOOT_SOURCE[s.kind]
}

function refusalText(node: CanopenNode, index: number): string {
  const sdo = node.sdos[index]
  if (sdo.onAbort === 'continue') return 'continue'
  if (sdo.onAbort === 'jump') {
    const target = node.sdos.findIndex((s) => s.id === sdo.jumpTo)
    return target >= 0 ? `jump to line ${target + 1}` : 'stop the boot'
  }
  return 'stop the boot'
}

function nodeSection(input: HtmlExportInput, node: CanopenNode): string {
  const { network } = input.config
  const eds = node.eds
  const emcy = effectiveEmcy(node)
  const supervision =
    node.supervision === 'heartbeat'
      ? `heartbeat: the node sends every ${effectiveProducerMs(node)} ms, the master times out after ${node.heartbeatConsumerMs} ms`
      : node.supervision === 'guarding'
        ? `node guarding: every ${node.guardTimeMs} ms, life time factor ${node.lifeTimeFactor}`
        : 'none'
  const checks = [
    node.checkVendorId ? 'vendor ID' : '',
    node.checkProductCode ? 'product code' : '',
    node.checkRevision ? 'revision' : '',
  ].filter((c) => c)
  const file = eds.source
    ? `${code(eds.source.fileName)} ${dim(`${eds.source.format.toUpperCase()}, SHA-256 ${eds.source.sha256.slice(0, 12)}&hellip;`)}`
    : code(eds.fileName)
  const out: string[] = []
  out.push(`<section class="node" id="node-${node.nodeId}">`)
  out.push(`<h2><span class="nid">${node.nodeId}</span> ${esc(node.name)}</h2>`)
  const product = [eds.vendorName, eds.productName, eds.details?.productText ?? ''].filter((p) => p)
  out.push(`<p class="sub">${product.map(esc).join(' &middot; ')}</p>`)
  out.push('<div class="cols">')
  out.push(
    `<div><h3>Device</h3>${kv([
      ['Vendor ID', code(hex(eds.vendorId, 8))],
      ['Product code', code(hex(eds.productCode, 8))],
      ['Revision', code(hex(eds.revision, 8))],
      ['Device type', code(hex(eds.deviceType, 8))],
      ['Device file', file],
    ])}</div>`,
  )
  const restore = node.restoreDefaults
    ? `0x1011 sub ${node.restoreDefaults} (${esc(restoreChoiceName(node.restoreDefaults))})`
    : 'no'
  const watchMaster = node.watchMaster.enabled
    ? `${node.watchMaster.consumerMs} ms, then ${ON_COMM_ERROR[node.watchMaster.onError]}`
    : 'no'
  const consumers = node.heartbeatConsumers.length
    ? node.heartbeatConsumers.map((c) => `node ${c.producerNodeId} (${c.consumerMs} ms)`).join(', ')
    : 'no'
  out.push(
    `<div><h3>How the master handles it</h3>${kv([
      ['Required', node.optional ? 'no, optional' : 'yes'],
      ['Configured by the master', node.configure ? 'yes' : 'no, only started'],
      ['Identity checks', checks.length ? checks.join(', ') : 'none'],
      ['Restore before configuring', restore],
      ['Supervision', esc(supervision)],
      ['Inputs on loss', node.onLoss === 'hold' ? 'hold the last value' : 'set to zero'],
      ['Emergency messages', emcy.enabled ? `on, COB-ID ${code(hex(emcy.cobId))}` : 'off'],
      ['TIME', node.receiveTime && network.time.enabled ? 'receives it' : 'no'],
      ['Watches the master', watchMaster],
      ['Watches other nodes', consumers],
      ['NMT state', `${code(node.state.iecLocation)}${node.state.alias ? ` ${code(node.state.alias)}` : ''}`],
    ])}</div>`,
  )
  out.push('</div>')
  if (node.tpdos.length) {
    out.push('<h3>Inputs (transmit PDOs of the node)</h3>')
    for (const pdo of node.tpdos) out.push(pdoBlock(input, node, pdo, 'TPDO'))
  }
  if (node.rpdos.length) {
    out.push('<h3>Outputs (receive PDOs of the node)</h3>')
    for (const pdo of node.rpdos) out.push(pdoBlock(input, node, pdo, 'RPDO'))
  }
  if (input.sections.has('sdos')) {
    out.push('<h3>Startup SDOs</h3>')
    const rows = node.sdos.map((sdo, i) => {
      const object = findObject(eds, sdo.index, sdo.subIndex)
      return [
        `${i + 1}`,
        code(objectRef(sdo.index, sdo.subIndex)),
        object ? esc(objectLabel(object)) : dim('not in the device file'),
        esc(sdo.dataType),
        esc(describeValue(object, sdo.value)),
        refusalText(node, i),
      ]
    })
    out.push(table(['Line', 'Index', 'Object', 'Type', 'Value', 'When refused'], rows))
  }
  if (input.sections.has('bootWrites')) {
    const writes = nodeBootWrites(node, network)
    out.push(`<h3>What the master writes at boot (${plural(writes.length, 'SDO write')}, in order)</h3>`)
    if (!node.configure) out.push('<p class="dim">The master does not configure this node; it only starts it.</p>')
    else
      out.push(
        table(
          ['#', 'Index', 'Object', 'Value', 'Setting'],
          writes.map((w, i) => {
            const object = findObject(eds, w.index, w.subindex)
            return [
              `${i + 1}`,
              code(objectRef(w.index, w.subindex)),
              object ? esc(objectLabel(object)) : '',
              bootWriteValue(node, w),
              esc(bootWriteSource(w)),
            ]
          }),
          'compact',
        ),
      )
  }
  if (input.sections.has('objects')) {
    const rows = eds.objects.map((o) => [
      code(objectRef(o.index, o.subIndex)),
      esc(objectLabel(o)),
      esc(o.dataType),
      esc(o.access),
      o.pdoMapping ? 'yes' : '',
      esc(o.defaultValue ?? ''),
      esc(
        [o.lowLimit && o.highLimit ? `${o.lowLimit} to ${o.highLimit}` : '', o.info?.unit ?? '']
          .filter((p) => p)
          .join(' '),
      ),
    ])
    out.push(
      `<details class="od"><summary>Object dictionary (${plural(eds.objects.length, 'object')})</summary>${table(
        ['Index', 'Name', 'Type', 'Access', 'PDO', 'Default', 'Range, unit'],
        rows,
        'compact',
      )}</details>`,
    )
  }
  out.push('</section>')
  return out.join('\n')
}

/** One frame the configured network puts on the bus. */
export interface CanIdRow {
  cobId: number
  frame: string
  from: string
  to: string
  when: string
  /** Another frame with this COB-ID has a different sender. */
  duplicate: boolean
}

/** Every frame of the network's configuration, by COB-ID; `nodes` limits the node frames. */
export function canIdRows(network: CanopenNetworkSettings, nodes: readonly CanopenNode[]): CanIdRow[] {
  type Row = Omit<CanIdRow, 'duplicate'> & { sender: string | null }
  const rows: Row[] = [{ cobId: 0, frame: 'NMT', from: 'master', to: 'all nodes', when: 'on change', sender: 'master' }]
  if (network.syncMode !== 'none')
    rows.push({
      cobId: 0x80,
      frame: 'SYNC',
      from: 'master',
      to: 'all nodes',
      when: network.syncMode === 'period' ? `every ${network.syncPeriodUs / 1000} ms` : 'every PLC cycle',
      sender: 'master',
    })
  if (network.time.enabled)
    rows.push({
      cobId: network.time.cobId,
      frame: 'TIME',
      from: 'master',
      to: 'nodes that receive it',
      when: `every ${network.time.periodMs} ms`,
      sender: 'master',
    })
  if (network.heartbeatProducerMs > 0)
    rows.push({
      cobId: 0x700 + network.masterNodeId,
      frame: 'Heartbeat',
      from: 'master',
      to: 'nodes that watch it',
      when: `every ${network.heartbeatProducerMs} ms`,
      sender: 'master',
    })
  for (const n of nodes) {
    const name = `${n.nodeId} ${n.name}`
    const emcy = effectiveEmcy(n)
    if (emcy.enabled)
      rows.push({ cobId: emcy.cobId, frame: 'EMCY', from: name, to: 'master', when: 'on error', sender: name })
    for (const p of n.tpdos)
      rows.push({
        cobId: p.cobId,
        frame: `TPDO ${p.number}`,
        from: name,
        to: p.exchanged ? 'master (PLC inputs)' : 'other nodes',
        when: p.eventTimerMs
          ? `${transmissionText(p.transmissionType)}, at least every ${p.eventTimerMs} ms`
          : transmissionText(p.transmissionType),
        sender: name,
      })
    for (const p of n.rpdos)
      rows.push({
        cobId: p.cobId,
        frame: `RPDO ${p.number}`,
        from: p.exchanged ? 'master (PLC outputs)' : 'another node',
        to: name,
        when: transmissionText(p.transmissionType),
        sender: p.exchanged ? 'master' : null,
      })
    rows.push({
      cobId: 0x600 + n.nodeId,
      frame: 'SDO request',
      from: 'master',
      to: name,
      when: 'at boot and on request',
      sender: 'master',
    })
    rows.push({
      cobId: 0x580 + n.nodeId,
      frame: 'SDO response',
      from: name,
      to: 'master',
      when: 'at boot and on request',
      sender: name,
    })
    if (n.supervision === 'heartbeat')
      rows.push({
        cobId: 0x700 + n.nodeId,
        frame: 'Heartbeat',
        from: name,
        to: 'master',
        when: `every ${effectiveProducerMs(n)} ms`,
        sender: name,
      })
    if (n.supervision === 'guarding')
      rows.push({
        cobId: 0x700 + n.nodeId,
        frame: 'Node guarding',
        from: 'master and node',
        to: 'master and node',
        when: `every ${n.guardTimeMs} ms`,
        sender: name,
      })
  }
  const senders = new Map<number, Set<string>>()
  for (const r of rows)
    if (r.sender) senders.set(r.cobId, (senders.get(r.cobId) ?? new Set()).add(`${r.sender}/${r.frame}`))
  return rows
    .sort((a, b) => a.cobId - b.cobId)
    .map(({ sender: _sender, ...r }) => ({ ...r, duplicate: (senders.get(r.cobId)?.size ?? 0) > 1 }))
}

/** "%IB10" before "%IB9" otherwise; numbers compare by value. */
function addressKey(address: string): string {
  return address.replace(/\d+/g, (d) => d.padStart(6, '0'))
}

function ioList(input: HtmlExportInput, nodes: readonly CanopenNode[]): string {
  const withUses = input.sections.has('plcVariables')
  const rows: Array<{ key: string; cells: string[] }> = []
  const add = (node: CanopenNode, entry: CanopenEntry, object: string, pdo: string, meaning: string): void => {
    const cells = [
      code(entry.iecLocation),
      entry.alias ? code(entry.alias) : '',
      `${node.nodeId} ${esc(node.name)}`,
      object,
      pdo,
      esc(entry.dataType),
      meaning,
    ]
    if (withUses) cells.push(usesCell(input, entry))
    rows.push({ key: addressKey(entry.iecLocation), cells })
  }
  for (const node of nodes) {
    add(node, node.state, 'NMT state', '', '')
    for (const [kind, list] of [
      ['TPDO', node.tpdos],
      ['RPDO', node.rpdos],
    ] as const)
      for (const pdo of list)
        for (const entry of pdo.entries)
          if (!isDummyEntry(entry))
            add(node, entry, esc(entryName(node, entry)), `${kind} ${pdo.number}`, meaningCell(node, entry))
  }
  rows.sort((a, b) => a.key.localeCompare(b.key))
  const head = ['Address', 'Alias', 'Node', 'Object', 'PDO', 'Type', 'Unit / meaning']
  if (withUses) head.push('PLC variables')
  return table(
    head,
    rows.map((r) => r.cells),
    'compact',
  )
}

const CSS = `
:root{--fg:#111827;--dim:#6b7280;--line:#e5e7eb;--soft:#f9fafb;--link:#0464fb;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
body{margin:0;background:#fff}
.page{display:grid;grid-template-columns:220px minmax(0,1fr);max-width:1280px;margin:0 auto}
nav{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;box-sizing:border-box;padding:24px 16px;border-right:1px solid var(--line);font-size:12px}
nav a{display:block;color:var(--fg);text-decoration:none;padding:2px 0}nav a:hover{color:var(--link)}
nav .grp{margin:12px 0 4px;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
main{padding:24px 32px 64px;min-width:0}
header h1{font-size:22px;margin:0 0 2px}header p{margin:0;color:var(--dim)}
h2{font-size:17px;margin:36px 0 4px;padding-top:8px;border-top:2px solid var(--fg)}
h3{font-size:13px;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:#374151}
h4{font-size:13px;margin:14px 0 2px}
a{color:var(--link)}
.sub,.facts{margin:0 0 8px;color:var(--dim)}
.nid{display:inline-block;min-width:26px;padding:0 6px;margin-right:4px;border-radius:4px;background:var(--fg);color:#fff;text-align:center}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:3px 16px;margin:0}dl.kv dt{color:var(--dim)}dl.kv dd{margin:0}
table{width:100%;border-collapse:collapse;margin:4px 0 8px;font-size:12px}
th{text-align:left;font-weight:600;color:#374151;background:var(--soft);border-bottom:1px solid var(--line);padding:4px 8px;white-space:nowrap}
td{border-bottom:1px solid var(--line);padding:4px 8px;vertical-align:top}
table.compact td{padding:2px 8px}
code{font:11.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dim{color:var(--dim)}
.dup{color:#b91c1c;font-weight:600}
.b{white-space:nowrap;margin-right:6px}.bits{font-size:11px;color:#374151}
.bit{display:inline-block;min-width:14px;padding:0 3px;border-radius:3px;background:#eef2ff;color:#3730a3;font:10px ui-monospace,Menlo,monospace;text-align:center}
.bar{display:grid;margin:6px 0;border:1px solid var(--line);border-radius:4px;overflow:hidden;font-size:11px}
.bar .tick{grid-row:1;color:var(--dim);background:var(--soft);border-left:1px solid var(--line);padding:1px 4px;font-size:10px}
.bar .seg{grid-row:2;border-left:1px solid #fff;background:#eef2ff;background:color-mix(in srgb,var(--c) 14%,#fff);border-top:3px solid var(--c);padding:3px 5px;min-width:0;overflow:hidden}
.bar .seg span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.bar .seg small{color:var(--dim)}
.bar .seg.gap{background:repeating-linear-gradient(45deg,#f3f4f6 0 4px,#fff 4px 8px);border-top:3px solid #d1d5db}
details{margin:12px 0}summary{cursor:pointer;font-weight:600}
.summary{display:flex;gap:16px;margin:16px 0 0;flex-wrap:wrap}
.summary div{border:1px solid var(--line);border-radius:6px;padding:8px 14px}.summary b{display:block;font-size:18px}
.summary span{color:var(--dim);font-size:11px}
footer{margin-top:40px;color:var(--dim);font-size:11px;border-top:1px solid var(--line);padding-top:8px}
@media (max-width:800px){.page{display:block}nav{display:none}.cols{grid-template-columns:1fr}main{padding:16px}}
@media print{
 @page{size:A4 landscape;margin:12mm}
 :root{font-size:10.5px;-webkit-print-color-adjust:exact;print-color-adjust:exact}table{font-size:9.5px}code{font-size:9px}
 .page{display:block}nav{display:none}main{padding:0}
 section.node{break-before:page}
 h2,h3,h4{break-after:avoid}
 tr,.bar{break-inside:avoid}
 thead{display:table-header-group}
 a{color:inherit;text-decoration:none}
}
`

/** The document of the network, or of one node with the network's settings. */
export function buildHtmlDocument(input: HtmlExportInput): string {
  const { config, sections } = input
  const net = config.network
  const single = input.nodeId === undefined ? undefined : config.nodes.find((n) => n.id === input.nodeId)
  const nodes = (single ? [single] : config.nodes).slice().sort((a, b) => a.nodeId - b.nodeId)
  const entries = nodes.flatMap((n) =>
    [...n.tpdos, ...n.rpdos].flatMap((p) => p.entries.filter((e) => !isDummyEntry(e))),
  )
  const pdoCount = nodes.reduce((s, n) => s + n.tpdos.length + n.rpdos.length, 0)
  const title = single
    ? `CANopen node ${single.nodeId} ${single.name} on ${input.networkName}`
    : `CANopen network ${input.networkName}`
  const stamp = `${input.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const toc: string[] = []
  const body: string[] = []

  body.push(
    `<header><h1>${esc(title)}</h1><p>Project ${esc(input.projectName)} &middot; exported ${stamp} &middot; OpenPLC Editor ${esc(input.editorVersion)}${
      net.enabled ? '' : ' &middot; <b>the network is switched off</b>'
    }</p><div class="summary"><div><b>${nodes.length}</b><span>${nodes.length === 1 ? 'node' : 'nodes'}</span></div><div><b>${bitrateText(
      net.bitrate,
    )}</b><span>bit rate</span></div><div><b>${entries.length}</b><span>mapped entries</span></div><div><b>${pdoCount}</b><span>PDOs</span></div></div></header>`,
  )

  if (sections.has('network')) {
    toc.push('<a href="#network">Network</a>')
    const sync = `${SYNC_MODE[net.syncMode]}${net.syncMode === 'period' ? `, ${net.syncPeriodUs / 1000} ms` : ''}${
      net.syncWindowUs ? `, window ${net.syncWindowUs} &micro;s` : ''
    }`
    body.push(
      `<h2 id="network">Network</h2>${kv([
        ['Interface', code(net.interface)],
        ['Bit rate', bitrateText(net.bitrate)],
        ['Master node ID', String(net.masterNodeId)],
        ['SYNC', sync],
        ['Master heartbeat', net.heartbeatProducerMs > 0 ? `${net.heartbeatProducerMs} ms` : 'off'],
        ['TIME', net.time.enabled ? `COB-ID ${code(hex(net.time.cobId))}, every ${net.time.periodMs} ms` : 'off'],
        ['SDO timeout', `${net.sdoTimeoutMs} ms`],
        ['Boot timeout', `${net.bootTimeoutMs} ms`],
        ['Node error', net.onNodeError === 'restart' ? 'restart the node' : 'stop the node'],
        ['On PLC stop', ON_PLC_STOP[net.onPlcStop]],
        ['Bus thread priority', String(net.priority)],
      ])}`,
    )
  }
  if (sections.has('nodes')) {
    toc.push('<a href="#nodes">Nodes</a>')
    const pdoText = (list: readonly CanopenPdo[]): string =>
      `${list.length} PDO, ${Math.ceil(list.reduce((s, p) => s + pdoBits(p), 0) / 8)} B`
    body.push(
      `<h2 id="nodes">Nodes</h2>${table(
        ['ID', 'Name', 'Device', 'Revision', 'Supervision', 'Required', 'Inputs', 'Outputs', 'Startup SDOs'],
        nodes.map((n) => [
          `<a href="#node-${n.nodeId}">${n.nodeId}</a>`,
          esc(n.name),
          `${esc(n.eds.productName)}<br>${dim(esc(n.eds.vendorName))}`,
          code(hex(n.eds.revision, 8)),
          SUPERVISION[n.supervision],
          n.optional ? 'optional' : 'yes',
          pdoText(n.tpdos),
          pdoText(n.rpdos),
          String(n.sdos.length),
        ]),
      )}`,
    )
  }
  if (sections.has('canIds')) {
    toc.push('<a href="#can-ids">CAN identifiers</a>')
    const rows = canIdRows(net, nodes).map((r) => [
      `${code(hex(r.cobId))}${r.duplicate ? ' <span class="dup" title="Another frame has this COB-ID">used twice</span>' : ''}`,
      esc(r.frame),
      esc(r.from),
      esc(r.to),
      esc(r.when),
    ])
    body.push(
      `<h2 id="can-ids">CAN identifiers</h2><p class="sub">Every frame the configured network puts on the bus, by COB-ID.</p>${table(
        ['COB-ID', 'Frame', 'From', 'To', 'When'],
        rows,
        'compact',
      )}`,
    )
  }
  if (sections.has('ioList')) {
    toc.push('<a href="#io">I/O list</a>')
    body.push(
      `<h2 id="io">I/O list</h2><p class="sub">PLC inputs (%I) and outputs (%Q) by address.</p>${ioList(input, nodes)}`,
    )
  }
  toc.push(`<div class="grp">${nodes.length === 1 ? 'Node' : 'Nodes'}</div>`)
  for (const n of nodes) {
    toc.push(`<a href="#node-${n.nodeId}">${n.nodeId} ${esc(n.name)}</a>`)
    body.push(nodeSection(input, n))
  }
  body.push(
    `<footer>Written by OpenPLC Editor ${esc(input.editorVersion)} from project ${esc(
      input.projectName,
    )} on ${stamp}: a record of the configuration at that time. The editor does not read this file back.</footer>`,
  )
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="OpenPLC Editor ${esc(input.editorVersion)}">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="page"><nav><b>${esc(input.networkName)}</b>${toc.join('')}</nav><main>
${body.join('\n')}
</main></div></body></html>
`
}

/** The document as an export file: `<network>.html`, or `node_<id>.html` for one node. */
export function buildHtmlExport(input: HtmlExportInput): DeviceFileExport {
  const node = input.nodeId === undefined ? undefined : input.config.nodes.find((n) => n.id === input.nodeId)
  const text = buildHtmlDocument(input)
  const nodes = node ? [node] : input.config.nodes
  const io = nodes.reduce(
    (s, n) =>
      s + 1 + [...n.tpdos, ...n.rpdos].reduce((k, p) => k + p.entries.filter((e) => !isDummyEntry(e)).length, 0),
    0,
  )
  const kb = Math.max(1, Math.round(new TextEncoder().encode(text).length / 1024))
  return {
    fileName: node ? `node_${node.nodeId}.html` : `${input.networkName}.html`,
    text,
    summary: `${plural(nodes.length, 'node')}, ${io} I/O, ${kb} KB`,
    errors: [],
    problems: [],
  }
}
