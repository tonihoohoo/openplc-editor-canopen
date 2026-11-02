/**
 * Export of a node or a network as DCF, EDS, XDC or XDD, whatever format the node's device file
 * came in, or as a DBC of its frames, and the list of what each format does not hold.
 */

import type { CanopenConfig, CanopenNode } from '../../ports/canopen-types'
import { buildDbc, dbcExportOptions, dbcOptionLosses } from './dbc-export'
import {
  buildNodeDcf,
  buildNodeEds,
  type DcfExportOptions,
  type DeviceFileExport,
  edsFileName,
  type NetworkExport,
  uniqueFileName,
} from './dcf-export'
import { writeEds } from './device-writer'
import { buildNetworkXdcs, buildNetworkXdds, buildNodeXdc, buildNodeXdd } from './xdd-export'

/** The formats a node or a network can be exported as. */
export type ExportFormat = 'dcf' | 'eds' | 'xdc' | 'xdd' | 'dbc'

export const EXPORT_FORMATS: ReadonlyArray<{ format: ExportFormat; label: string; description: string }> = [
  {
    format: 'dcf',
    label: 'DCF',
    description: 'The device file with ParameterValue on every object the master writes when it configures the node.',
  },
  { format: 'eds', label: 'EDS', description: 'The device description only, without values.' },
  {
    format: 'xdc',
    label: 'XDC',
    description: 'The CiA 311 description with actualValue on every object the master writes, and the commissioning.',
  },
  { format: 'xdd', label: 'XDD', description: 'The CiA 311 device description only, without values.' },
  {
    format: 'dbc',
    label: 'DBC',
    description:
      'For CAN analysers: the frames on the bus and how to decode them. Not a device file, and it cannot be read back.',
  },
]

/** Whether the format is built from the node's stored device file. */
export function exportNeedsDeviceFile(format: ExportFormat): boolean {
  return format !== 'dbc'
}

/** The file's MIME type and file dialog filter. */
export function exportFileType(format: ExportFormat): { mime: string; name: string; extensions: string[] } {
  const xml = format === 'xdc' || format === 'xdd'
  if (format === 'dbc') return { mime: 'text/plain;charset=utf-8', name: 'DBC file', extensions: ['dbc'] }
  return {
    mime: xml ? 'application/xml' : 'text/plain;charset=utf-8',
    name: `${format.toUpperCase()} file`,
    extensions: [format],
  }
}

/** The check the exported files get: CiA 311 for XDC and XDD, the DBC rules for DBC, else CiA 306. */
export function exportStandard(format: ExportFormat): 'CiA 306' | 'CiA 311' | 'DBC' {
  if (format === 'dbc') return 'DBC'
  return format === 'xdc' || format === 'xdd' ? 'CiA 311' : 'CiA 306'
}

function fromXml(node: CanopenNode): boolean {
  return node.eds.source?.format === 'xdd' || node.eds.source?.format === 'xdc'
}

/** The node's description as EDS text: the stored EDS or DCF, or written from an XDD or XDC. */
function edsText(node: CanopenNode, storedText: string, now: Date): string {
  return fromXml(node) ? writeEds(node.eds, { fileName: edsFileName(node, storedText), now }) : storedText
}

function hasXddInformation(node: CanopenNode): boolean {
  return node.eds.objects.some((o) => o.info !== undefined) || node.eds.details !== undefined
}

function nodeLosses(format: ExportFormat, node: CanopenNode): string[] {
  const out: string[] = []
  const pdos = [...node.tpdos, ...node.rpdos]
  const mapped = pdos.reduce((n, p) => n + p.entries.length, 0)
  const description = format === 'eds' || format === 'xdd'
  if (description) {
    out.push(
      "the settings made in the editor: node ID, name, PDO settings and mappings, supervision, emergency, TIME, heartbeat consumers, watching the master and startup SDOs (the file keeps the device's defaults)",
    )
    if (pdos.some((p) => p.entries.some((e) => e.alias))) out.push('the aliases of the mapped entries')
  }
  if ((format === 'eds' || format === 'dcf') && fromXml(node) && hasXddInformation(node))
    out.push(
      'what only an XDD holds: the descriptions, units and scaling, value meanings, bit names, groups, other languages and characteristics',
    )
  if ((format === 'xdd' || format === 'xdc') && !fromXml(node)) {
    out.push('the comments of the EDS, ObjFlags and CompactPDO hints')
    if (node.eds.objects.some((o) => o.access === 'rwr' || o.access === 'rww'))
      out.push('the rwr and rww access types, which CiA 311 writes as rw')
  }
  if (mapped > 0) out.push(`the IEC addresses of ${mapped} mapped entr${mapped === 1 ? 'y' : 'ies'} (%I, %Q)`)
  out.push(
    "how the master handles the node: optional or required, identity checks, the master's heartbeat timeout and what the inputs do on loss",
  )
  const timeouts = pdos.filter((p) => p.receiveTimeoutMs > 0).length
  if (timeouts > 0) out.push(`receive timeouts on ${timeouts} PDO${timeouts === 1 ? '' : 's'}`)
  const values = format === 'dcf' || format === 'xdc'
  if (values && !node.configure)
    out.push(
      format === 'dcf'
        ? 'that the master does not configure the node: the file has no values, only a comment says so'
        : 'that the master does not configure the node: the file has no actual values',
    )
  else if (values && node.restoreDefaults > 0)
    out.push(
      format === 'dcf'
        ? `the restore step before the configuration (0x1011 sub ${node.restoreDefaults}): only a comment says so`
        : `the restore step before the configuration (0x1011 sub ${node.restoreDefaults})`,
    )
  return out
}

function dbcLosses(nodes: readonly CanopenNode[], network: boolean, config: CanopenConfig | undefined): string[] {
  const options = config ? dbcExportOptions(config) : undefined
  const out = config ? dbcOptionLosses(config) : []
  out.push(
    options?.sdoValues === 'configured'
      ? 'the object dictionaries: SDO values decode only for the startup SDO and mapped objects'
      : 'the object dictionaries beyond names and types: access, defaults and limits',
    'the startup SDOs as a list: their frames decode, but the file does not say which writes the master makes at boot',
    'the data of SDO transfers over 4 bytes (strings, domains): shown as raw segment bytes, not linked to the object',
    'the device files and the device identity (vendor ID, product code, revision)',
    'how the master handles the nodes: optional or required, identity checks, restore, supervision and receive timeouts, what the inputs do on loss',
  )
  if (network)
    out.push('the network settings beyond bit rate, SYNC and TIME: interface, master node ID, behaviour on PLC stop')
  if (nodes.some((n) => [...n.tpdos, ...n.rpdos].some((p) => p.entries.length > 0)))
    out.push(
      'the IEC addresses and aliases as data: they are kept as signal names, comments and an IecLocation attribute',
    )
  if (config?.network.syncMode === 'plc_cycle')
    out.push('the cycle time of SYNC and of synchronous PDOs: SYNC follows the PLC cycle')
  return out
}

/**
 * What the exported files do not hold, in plain sentences, so the dialog can say what is lost.
 * `nodes` are the exported nodes; a network export adds the network's own settings. `config` gives
 * the export options of the formats that have them.
 */
export function exportLosses(
  format: ExportFormat,
  nodes: readonly CanopenNode[],
  network: boolean,
  config?: CanopenConfig,
): string[] {
  if (format === 'dbc') return dbcLosses(nodes, network, config)
  const out: string[] = []
  const perNode = format === 'dcf' || format === 'xdc'
  if (network)
    out.push(
      perNode
        ? `the network settings (interface, master node ID, SYNC, behaviour on PLC stop); each ${format.toUpperCase()} keeps the bit rate`
        : 'the network settings (interface, bit rate, master node ID, SYNC, behaviour on PLC stop)',
    )
  if (network && !perNode && new Set(nodes.map((n) => n.eds.source?.sha256)).size < nodes.length)
    out.push(`which nodes use each file: nodes that share a device file share one ${format.toUpperCase()}`)
  for (const node of nodes) {
    const prefix = nodes.length > 1 || network ? `node ${node.nodeId}: ` : ''
    out.push(...nodeLosses(format, node).map((l) => prefix + l))
  }
  return out
}

/** The node's file in the format; `storedText` is its stored device file. */
export function buildNodeExport(
  format: ExportFormat,
  node: CanopenNode,
  storedText: string,
  config: CanopenConfig,
  options: DcfExportOptions,
): DeviceFileExport {
  switch (format) {
    case 'dcf':
      return buildNodeDcf(node, edsText(node, storedText, options.now), config, options)
    case 'eds': {
      if (!fromXml(node)) return buildNodeEds(node, storedText)
      const fileName = edsFileName(node, storedText)
      return {
        fileName,
        text: writeEds(node.eds, { fileName, now: options.now }),
        summary: `written from the ${node.eds.source?.format === 'xdc' ? 'XDC' : 'XDD'}`,
        errors: [],
        problems: [],
      }
    }
    case 'xdc':
      return buildNodeXdc(node, storedText, config, options)
    case 'xdd':
      return buildNodeXdd(node, storedText, options.now)
    case 'dbc':
      return buildDbc(config, { networkName: options.networkName ?? '', nodes: [node] })
    default: {
      const never: never = format
      throw new Error(`Unknown export format ${String(never)}`)
    }
  }
}

/** The network's files in the format. */
export function buildNetworkExport(
  format: ExportFormat,
  config: CanopenConfig,
  options: DcfExportOptions,
): NetworkExport {
  if (format === 'dbc') return { files: [buildDbc(config, { networkName: options.networkName ?? '' })], missing: [] }
  if (format === 'xdc') return buildNetworkXdcs(config, options)
  if (format === 'xdd') return buildNetworkXdds(config, options.now)
  const files: DeviceFileExport[] = []
  const missing: CanopenNode[] = []
  const seen = new Set<string>()
  const names = new Set<string>()
  for (const node of config.nodes) {
    const hash = node.eds.source?.sha256
    const stored = hash ? config.files?.[hash] : undefined
    if (!hash || !stored) {
      missing.push(node)
      continue
    }
    if (format === 'dcf') {
      files.push(buildNodeExport('dcf', node, stored.text, config, options))
      continue
    }
    if (seen.has(hash)) continue
    seen.add(hash)
    const file = buildNodeExport('eds', node, stored.text, config, options)
    files.push({ ...file, fileName: uniqueFileName(file.fileName, names) })
  }
  return { files, missing }
}
