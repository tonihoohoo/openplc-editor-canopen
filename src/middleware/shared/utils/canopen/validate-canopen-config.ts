/**
 * Checks a project's CANopen devices before build, with the same rules the runtime's parser
 * applies, so a problem is reported in the editor and not on the device. Each message names the
 * network, node and PDO it concerns.
 */

import type { CanopenNode, CanopenPdo } from '../../ports/canopen-types'
import type { PLCRemoteDevice } from '../../ports/types'
import { checkCanopenNetwork, checkText, reservedCobId } from './check-fix'
import { CANOPEN_BITRATES, iecPrefixFor } from './data-types'
import { findObject } from './eds-parser'
import { pdoConfigured, watchesMaster } from './generate-canopen-config'
import {
  MAX_BUS_PRIORITY,
  MAX_PDO_BITS,
  MIN_BUS_PRIORITY,
  pdoBits,
  type PdoDirection,
  RTR_TRANSMISSION_TYPES,
} from './model'
import { encodeCanopenValue } from './sdo-value'

const hex = (v: number, width: number): string => `0x${v.toString(16).toUpperCase().padStart(width, '0')}`

/**
 * Errors that stop the build. `cycleUs` is the PLC cycle (see `plcCycleUs`), used to check a SYNC
 * window against SYNC once per PLC cycle; timings off the cycle are warnings and do not stop it.
 * Networks that are off are skipped unless `includeOff` is set, as the device editor does.
 */
export function validateCanopenProject(
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
  cycleUs: number | null = null,
  options: { includeOff?: boolean } = {},
): string[] {
  const errors: string[] = []
  const interfaces = new Map<string, string>()
  const inputs = new Map<string, string>()

  for (const device of remoteDevices ?? []) {
    if (device.protocol !== 'canopen' || !device.canopenConfig) continue
    if (!device.canopenConfig.network.enabled && !options.includeOff) continue
    const { network, nodes } = device.canopenConfig
    const net = `CANopen "${device.name}"`
    const iface = network.interface.trim()
    if (iface === '') errors.push(`${net}: no CAN interface`)
    else if (iface.length > 15) errors.push(`${net}: interface name "${iface}" is longer than 15 characters`)
    else if (interfaces.has(iface)) errors.push(`${net}: interface ${iface} is also used by ${interfaces.get(iface)}`)
    else interfaces.set(iface, net)
    if (network.bitrate !== 0 && !CANOPEN_BITRATES.some((b) => b === network.bitrate))
      errors.push(`${net}: bit rate ${network.bitrate} is not a CANopen bit rate`)
    if (network.syncMode === 'period' && network.syncPeriodUs <= 0) errors.push(`${net}: periodic SYNC needs a period`)
    if (network.priority < MIN_BUS_PRIORITY || network.priority > MAX_BUS_PRIORITY)
      errors.push(`${net}: real-time priority ${network.priority} is outside ${MIN_BUS_PRIORITY} - ${MAX_BUS_PRIORITY}`)
    if (nodes.length === 0) errors.push(`${net}: no nodes`)

    for (const p of checkCanopenNetwork(device.canopenConfig, cycleUs))
      if (p.level === 'error') errors.push(p.where ? `${net} ${checkText(p)}` : `${net}: ${p.text}`)
    if (network.bootTimeoutMs < 100 || network.bootTimeoutMs > 60000)
      errors.push(`${net}: the boot-up timeout must be 100 - 60000 ms`)
    if (network.time.enabled && (network.time.periodMs < 10 || network.time.periodMs > 65535))
      errors.push(`${net}: the TIME period must be 10 - 65535 ms`)

    const ids = new Map<number, string>()
    const names = new Set<string>()
    for (const node of nodes) {
      const label = `${net} node ${node.nodeId} (${node.name})`
      if (node.nodeId === network.masterNodeId) errors.push(`${label}: has the master's node ID`)
      const other = ids.get(node.nodeId)
      if (other) errors.push(`${label} and ${other} have the same node ID`)
      else ids.set(node.nodeId, `node ${node.nodeId} (${node.name})`)
      if (names.has(node.name)) errors.push(`${label}: another node has the name "${node.name}"`)
      names.add(node.name)

      const checkPdos = (pdos: CanopenPdo[], direction: PdoDirection): void => {
        for (const pdo of pdos) {
          if (!pdoConfigured(pdo)) continue
          const where = `${label} ${direction === 'input' ? 'TPDO' : 'RPDO'} ${pdo.number}`
          if (pdoBits(pdo) > MAX_PDO_BITS) errors.push(`${where}: maps ${pdoBits(pdo)} bits; a PDO holds at most 64`)
          if (RTR_TRANSMISSION_TYPES.includes(pdo.transmissionType))
            errors.push(
              `${where}: transmission type ${pdo.transmissionType} needs remote requests (RTR), which are not supported`,
            )
          else if (pdo.transmissionType > 240 && pdo.transmissionType < 252)
            errors.push(`${where}: transmission type ${pdo.transmissionType} is reserved`)
          const reserved = reservedCobId(pdo.cobId)
          if (reserved) errors.push(`${where}: COB-ID ${hex(pdo.cobId, 3)} is reserved for ${reserved}`)
          for (const e of pdo.exchanged ? pdo.entries : []) {
            const prefix = iecPrefixFor(e.dataType, direction)
            if (!e.iecLocation.startsWith(prefix)) {
              errors.push(`${where}: ${e.name} needs a ${prefix} address, has "${e.iecLocation}"`)
              continue
            }
            if (direction === 'input') {
              const owner = inputs.get(e.iecLocation)
              if (owner) errors.push(`${where}: ${e.iecLocation} is also written by ${owner}`)
              else inputs.set(e.iecLocation, where)
            }
          }
        }
      }
      checkPdos(node.tpdos, 'input')
      checkPdos(node.rpdos, 'output')

      const watch = node.configure ? watchMasterProblem(node, network.heartbeatProducerMs) : null
      if (watch) errors.push(`${label}: ${watch}`)

      for (const sdo of node.sdos) {
        const where = `${label} startup SDO ${hex(sdo.index, 4)}:${sdo.subIndex}`
        if (sdo.index === 0x1010) errors.push(`${where}: the master never writes 0x1010 (store parameters)`)
        else if (sdo.index === 0x1011)
          errors.push(`${where}: 0x1011 is written only by the node's "Restore defaults" setting`)
        if (!node.configure) continue
        const encoded = encodeCanopenValue(sdo.dataType, sdo.value)
        if (!encoded.ok) errors.push(`${where}: ${encoded.message}`)
      }
    }
  }
  return errors
}

/** Why the node's "Watch the master" setting cannot work with this master heartbeat, or null. */
export function watchMasterProblem(node: CanopenNode, masterHeartbeatMs: number): string | null {
  if (!watchesMaster(node)) return null
  if (masterHeartbeatMs === 0)
    return "watches the master's heartbeat, but the master sends none; set the master heartbeat"
  if (masterHeartbeatMs >= node.watchMaster.consumerMs)
    return `the master's heartbeat (${masterHeartbeatMs} ms) must be shorter than the time the node waits for it (${node.watchMaster.consumerMs} ms)`
  return null
}

/** Warnings shown in the editor; they do not stop the build. */
export function canopenSdoWarnings(device: PLCRemoteDevice): Array<{ nodeId: string; sdoId: string; message: string }> {
  const out: Array<{ nodeId: string; sdoId: string; message: string }> = []
  for (const node of device.canopenConfig?.nodes ?? []) {
    for (const sdo of node.sdos) {
      const object = findObject(node.eds, sdo.index, sdo.subIndex)
      if (!object)
        out.push({ nodeId: node.id, sdoId: sdo.id, message: "This object is not in the node's device file." })
      else if (object.access === 'ro' || object.access === 'const')
        out.push({ nodeId: node.id, sdoId: sdo.id, message: 'The device file marks this object read-only.' })
      else if (watchesMaster(node) && (sdo.index === 0x1016 || sdo.index === 0x1029))
        out.push({
          nodeId: node.id,
          sdoId: sdo.id,
          message: '"Watch the master" writes this object after the startup SDOs.',
        })
    }
  }
  return out
}
