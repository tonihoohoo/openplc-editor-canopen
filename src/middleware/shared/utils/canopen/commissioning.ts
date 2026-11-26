/**
 * The device commissioning window: one list from a bus scan and an LSS search, the project's device
 * files that match a device, the rules for giving a node ID and a bit rate over LSS, the save and
 * restore scopes of a device without a device file, and adding a device to the project.
 */

import type { CanopenCanInterface } from '../../ports/canopen-online'
import type { CanopenConfig, CanopenEdsInfo, CanopenNode, CanopenStoredFile } from '../../ports/canopen-types'
import { withFreePdoCobIds } from './check-fix'
import { withStoredFile } from './device-import'
import {
  type AllocateAddress,
  createCanopenNode,
  defaultNetworkSettings,
  nodeNameFromEds,
  uniqueNodeName,
} from './model'
import { LSS_BITRATES, type LssDevice, type NvmScope, type ScanDevice } from './online'

/** The bit rate the window opens the bus at without a project network on the interface. */
export const DEFAULT_COMMISSION_BITRATE = 125000

/** The CiA 301 bit rates the window offers (bit/s). */
export const COMMISSION_BITRATES: readonly number[] = LSS_BITRATES

/** The network name the window opens service mode under. */
export const COMMISSION_SERVICE_NAME = 'Device commissioning'

/** One device of the window's list. */
export type CommissionDevice =
  | { kind: 'node'; key: string; nodeId: number; scan: ScanDevice }
  | { kind: 'heard'; key: string; nodeId: number; scan: ScanDevice }
  | { kind: 'unconfigured'; key: string; lss: LssDevice }

const hex8 = (v: number): string => `0x${v.toString(16).toUpperCase().padStart(8, '0')}`

const lssKey = (d: LssDevice): string => `lss:${d.vendorId}:${d.productCode}:${d.revision}:${d.serialNumber}`

/**
 * The list: devices with a node ID that answered (by node ID), then IDs only heard, then devices
 * without a node ID (by LSS address).
 */
export function commissionList(scan: readonly ScanDevice[], lss: readonly LssDevice[]): CommissionDevice[] {
  const sorted = [...scan].sort((a, b) => a.nodeId - b.nodeId)
  const nodes: CommissionDevice[] = sorted
    .filter((d) => d.answered)
    .map((d) => ({ kind: 'node', key: `node:${d.nodeId}`, nodeId: d.nodeId, scan: d }))
  const heard: CommissionDevice[] = sorted
    .filter((d) => !d.answered && d.heard.length > 0)
    .map((d) => ({ kind: 'heard', key: `heard:${d.nodeId}`, nodeId: d.nodeId, scan: d }))
  const unconfigured: CommissionDevice[] = lss.map((d) => ({ kind: 'unconfigured', key: lssKey(d), lss: d }))
  return [...nodes, ...heard, ...unconfigured]
}

/** How many devices answered: those with a node ID that answered SDO reads, and those found over LSS. */
export function answeredCount(list: readonly CommissionDevice[]): number {
  return list.filter((d) => d.kind !== 'heard').length
}

/** The device's identity as far as it is known: vendor ID, product code, revision, serial number. */
export interface DeviceIdentity {
  vendorId: number | null
  productCode: number | null
  revision: number | null
  serialNumber: number | null
}

export function deviceIdentity(device: CommissionDevice): DeviceIdentity {
  if (device.kind === 'unconfigured') return device.lss
  const { vendorId, productCode, revision, serialNumber } = device.scan
  return { vendorId, productCode, revision, serialNumber }
}

/** The device's full LSS address, or null when a part of it was not read. */
export function deviceLssAddress(device: CommissionDevice): LssDevice | null {
  const { vendorId, productCode, revision, serialNumber } = deviceIdentity(device)
  if (vendorId === null || productCode === null || revision === null || serialNumber === null) return null
  return { vendorId, productCode, revision, serialNumber }
}

/** The key of the same device in a new list: matched by its LSS address when it has one, else by its key. */
export function sameDeviceKey(device: CommissionDevice, list: readonly CommissionDevice[]): string | null {
  const address = deviceLssAddress(device)
  const same = address
    ? list.find((d) => {
        const a = deviceLssAddress(d)
        return (
          a !== null &&
          a.vendorId === address.vendorId &&
          a.productCode === address.productCode &&
          a.revision === address.revision &&
          a.serialNumber === address.serialNumber
        )
      })
    : undefined
  return (same ?? list.find((d) => d.key === device.key))?.key ?? null
}

/** A device's LSS address in one line. */
export function lssAddressText(d: LssDevice, vendorName: string | null = null): string {
  const vendor = vendorName ? `${vendorName} (${hex8(d.vendorId)})` : hex8(d.vendorId)
  return `Vendor ${vendor}, product ${hex8(d.productCode)}, revision ${hex8(d.revision)}, serial ${hex8(d.serialNumber)}`
}

/** The vendor's name from a device file with this vendor ID (any product), else null. */
export function vendorNameOf(files: readonly CommissionFile[], vendorId: number | null): string | null {
  if (vendorId === null) return null
  for (const f of files) {
    const name = f.eds.vendorName.trim()
    if (f.eds.vendorId === vendorId && name !== '') return name
  }
  return null
}

/** The vendor as the window shows it: its name with the ID, or the ID alone. */
export function vendorText(files: readonly CommissionFile[], vendorId: number): string {
  const name = vendorNameOf(files, vendorId)
  return name ? `${name} (${hex8(vendorId)})` : hex8(vendorId)
}

/** A VISIBLE_STRING read from a device (such as 0x1008): printable text up to its first NUL, trimmed. */
export function visibleString(bytes: readonly number[]): string {
  const end = bytes.indexOf(0)
  const chars = (end < 0 ? bytes : bytes.slice(0, end)).map((b) =>
    b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ',
  )
  return chars.join('').replace(/\s+/g, ' ').trim()
}

/** A device file the window can use: one of the project's, or one the user picked for a device. */
export interface CommissionFile {
  eds: CanopenEdsInfo
  /** The file's name, as listed. */
  fileName: string
  /** The file's text, to store it with a node added to the project; absent when the project has none. */
  text?: string
  /** Picked by the user in the window, not yet in the project. */
  picked: boolean
}

const fileKey = (eds: CanopenEdsInfo): string =>
  eds.source?.sha256 ?? `${eds.vendorId}:${eds.productCode}:${eds.revision}:${eds.fileName}`

/** The device files of the project's CANopen networks, each once. */
export function projectDeviceFiles(configs: readonly CanopenConfig[]): CommissionFile[] {
  const seen = new Map<string, CommissionFile>()
  for (const config of configs) {
    for (const node of config.nodes) {
      const k = fileKey(node.eds)
      if (seen.has(k)) continue
      const stored: CanopenStoredFile | undefined = node.eds.source ? config.files?.[node.eds.source.sha256] : undefined
      seen.set(k, {
        eds: node.eds,
        fileName: node.eds.source?.fileName ?? node.eds.fileName,
        text: stored?.text,
        picked: false,
      })
    }
  }
  return [...seen.values()]
}

/**
 * The files with the device's vendor ID and product code: the same revision first, then the others
 * by revision, newest first. None while the device's vendor ID or product code is unknown.
 */
export function matchingFiles(files: readonly CommissionFile[], identity: DeviceIdentity): CommissionFile[] {
  if (identity.vendorId === null || identity.productCode === null) return []
  const same = files.filter((f) => f.eds.vendorId === identity.vendorId && f.eds.productCode === identity.productCode)
  return same.sort((a, b) => {
    const exact = Number(b.eds.revision === identity.revision) - Number(a.eds.revision === identity.revision)
    return exact || b.eds.revision - a.eds.revision
  })
}

/** A warning for a picked file whose vendor ID or product code differs from the device's, or null. */
export function pickedFileWarning(eds: CanopenEdsInfo, identity: DeviceIdentity): string | null {
  const parts: string[] = []
  if (identity.vendorId !== null && eds.vendorId !== identity.vendorId)
    parts.push(`vendor ID ${hex8(eds.vendorId)}, the device has ${hex8(identity.vendorId)}`)
  if (identity.productCode !== null && eds.productCode !== identity.productCode)
    parts.push(`product code ${hex8(eds.productCode)}, the device has ${hex8(identity.productCode)}`)
  return parts.length > 0 ? `This file is for another device: ${parts.join('; ')}.` : null
}

/** LSS support by the device file: yes, no, or unknown without a file. */
export type LssSupport = 'yes' | 'no' | 'unknown'

export function lssSupportOf(eds: CanopenEdsInfo | null): LssSupport {
  if (!eds) return 'unknown'
  return eds.lssSupported ? 'yes' : 'no'
}

/**
 * Why a new node ID cannot be given, or null: out of range, unchanged, or used by another device of
 * the last search.
 */
export function nodeIdRefusal(
  list: readonly CommissionDevice[],
  device: CommissionDevice,
  nodeId: number,
): string | null {
  if (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > 127) return 'A node ID is 1 to 127.'
  if (device.kind !== 'unconfigured' && device.nodeId === nodeId) return `The device has node ID ${nodeId} already.`
  const other = list.find((d) => d.kind !== 'unconfigured' && d.nodeId === nodeId && d.key !== device.key)
  return other ? `Node ${nodeId} is already on the bus.` : null
}

/** Why the bit rate cannot be set, or null when exactly one device answered the last search. */
export function bitrateBlock(list: readonly CommissionDevice[]): string | null {
  const n = answeredCount(list)
  if (n === 1) return null
  return n === 0
    ? 'Find the device first.'
    : `The device must be alone on the link to change its bit rate; ${n} devices answered.`
}

/** Save (0x1010) or restore (0x1011) scopes of a device without a device file, from its sub-index 0. */
export function scopesFromCount(count: number): NvmScope[] {
  const scopes: NvmScope[] = []
  for (let sub = 1; sub <= Math.min(count, 127); sub++) scopes.push({ subIndex: sub, name: nvmScopeName(sub) })
  return scopes
}

/** The CiA 301 name of a save or restore sub-index. */
export function nvmScopeName(subIndex: number): string {
  if (subIndex === 1) return 'All parameters'
  if (subIndex === 2) return 'Communication parameters'
  if (subIndex === 3) return 'Application parameters'
  return `Manufacturer specific (sub ${subIndex})`
}

/** The bit rate to open the bus at on @p iface: the project network's there, else 125 kbit/s. */
export function defaultCommissionBitrate(configs: readonly CanopenConfig[], iface: string): number {
  const network = configs.find((c) => c.network.interface === iface && c.network.bitrate > 0)
  return network?.network.bitrate ?? DEFAULT_COMMISSION_BITRATE
}

/** The interfaces of the project's CANopen networks, each once, can0 when there is none. */
export function projectInterfaces(configs: readonly CanopenConfig[]): string[] {
  const names = [...new Set(configs.map((c) => c.network.interface).filter((i) => i !== ''))]
  return names.length > 0 ? names : ['can0']
}

const kbit = (bitrate: number): string => `${bitrate / 1000} kbit/s`

/** One entry of the window's CAN interface list. */
export interface InterfaceChoice {
  name: string
  /** What the list says after the name: state and bit rate on the runtime, or where it comes from. */
  note: string
  /** The link's bit rate on the runtime, 0 when none is set or reported. */
  bitrate: number
}

/**
 * The CAN interface list: the runtime computer's CAN links (when it lists them), then the project's
 * networks' interfaces it does not have. Without the runtime's list, only the project's interfaces.
 */
export function interfaceChoices(
  configs: readonly CanopenConfig[],
  links: readonly CanopenCanInterface[] | null,
): InterfaceChoice[] {
  const project = projectInterfaces(configs)
  if (links === null) return project.map((name) => ({ name, note: 'used in the project', bitrate: 0 }))
  const own: InterfaceChoice[] = links.map((l) => {
    const virtual = l.kind === 'vcan'
    const state = l.up ? 'up' : 'down'
    const rate = !virtual && l.bitrate > 0 ? `, ${kbit(l.bitrate)}` : ''
    return { name: l.name, note: virtual ? `virtual, ${state}` : `${state}${rate}`, bitrate: virtual ? 0 : l.bitrate }
  })
  const missing = project
    .filter((name) => (configs.length > 0 || links.length === 0) && !links.some((l) => l.name === name))
    .map((name) => ({ name, note: 'not on the runtime', bitrate: 0 }))
  return [...own, ...missing]
}

/** What adding the device to a network says: an error that refuses it, or a warning. */
export interface AddCheck {
  error: string | null
  warning: string | null
}

/** The name a commissioned device gets as a node: from its device file, free in @p config when given. */
export function commissionNodeName(config: CanopenConfig | null, eds: CanopenEdsInfo): string {
  const base = nodeNameFromEds(eds)
  return config ? uniqueNodeName(config, base) : base
}

/**
 * The check of the Add to project dialog: an ID the network uses, or the master's, is refused; a
 * window bit rate other than the network's is a warning.
 */
export function addToProjectCheck(
  config: CanopenConfig | null,
  nodeId: number,
  windowBitrate: number,
  name = '',
): AddCheck {
  if (!Number.isInteger(nodeId) || nodeId < 1 || nodeId > 127) return { error: 'A node ID is 1 to 127.', warning: null }
  if (!config) return { error: null, warning: null }
  if (nodeId === config.network.masterNodeId)
    return { error: `The network's master uses node ID ${nodeId}.`, warning: null }
  const used = config.nodes.find((n) => n.nodeId === nodeId)
  if (used) return { error: `The network has node ${nodeId} already (${used.name}).`, warning: null }
  if (name.trim() !== '' && config.nodes.some((n) => n.name === name.trim()))
    return { error: `The network has a node named ${name.trim()} already.`, warning: null }
  const rate = config.network.bitrate
  const warning =
    rate > 0 && rate !== windowBitrate
      ? `The network runs at ${kbit(rate)}, the device was found at ${kbit(windowBitrate)}. Set the device to ${kbit(rate)} first.`
      : null
  return { error: null, warning }
}

/** A new network for the device when the project has none: the window's interface and bit rate. */
export function newCommissionNetwork(iface: string, bitrate: number): CanopenConfig {
  return { network: { ...defaultNetworkSettings(), interface: iface, bitrate }, nodes: [] }
}

export interface AddToProjectOptions {
  id: string
  newId: () => string
  allocate: AllocateAddress
  name?: string
}

/**
 * The network with a node for the device: the file's default PDOs, free PDO COB-IDs, and the file
 * stored once when its text is known.
 */
export function addCommissionedNode(
  config: CanopenConfig,
  file: CommissionFile,
  nodeId: number,
  options: AddToProjectOptions,
): { config: CanopenConfig; node: CanopenNode } {
  const created = createCanopenNode(file.eds, {
    id: options.id,
    newId: options.newId,
    allocate: options.allocate,
    name: options.name?.trim() || uniqueNodeName(config, nodeNameFromEds(file.eds)),
    nodeId,
    defaults: config.network.newNodeDefaults,
  })
  const node = withFreePdoCobIds(config, created)
  const withNode = { ...config, nodes: [...config.nodes, node] }
  const source = file.eds.source
  return {
    node,
    config: source && file.text !== undefined ? withStoredFile(withNode, { source, text: file.text }) : withNode,
  }
}

/** A free name for a new CANopen network: `canopen_network`, then `canopen_network_2` and on. */
export function newNetworkName(taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  if (!used.has('canopen_network')) return 'canopen_network'
  for (let i = 2; ; i++) if (!used.has(`canopen_network_${i}`)) return `canopen_network_${i}`
}

/** A device file description with no objects, for a device the window reads by raw index only. */
export function noDeviceFile(identity: DeviceIdentity): CanopenEdsInfo {
  return {
    fileName: '',
    vendorName: '',
    productName: 'Device without a device file',
    deviceType: 0,
    vendorId: identity.vendorId ?? 0,
    productCode: identity.productCode ?? 0,
    revision: identity.revision ?? 0,
    rxPdoCount: 0,
    txPdoCount: 0,
    objects: [],
  }
}
