/** Adding PDOs to a node: the device file's defaults and, beyond the predefined set, a free COB-ID. */

import type { CanopenConfig } from '../../ports/canopen-types'
import { freePdoCobId } from './check-fix'
import { addablePdoNumbers, type AllocateAddress, edsPdo, type PdoDirection, updateNode, withPdos } from './model'

/** Why no PDO can be added in this direction, or null when one can. */
export function cannotAddPdo(config: CanopenConfig, nodeId: string, direction: PdoDirection): string | null {
  const node = config.nodes.find((n) => n.id === nodeId)
  if (!node) return 'The node is gone.'
  if (addablePdoNumbers(node, direction).length > 0) return null
  return `The device has no more ${direction === 'input' ? 'TPDOs' : 'RPDOs'}.`
}

/**
 * The config with the node's lowest unused PDO of the device file added, with the file's defaults;
 * a PDO without a predefined COB-ID gets the lowest free one of the network. Unchanged when none is left.
 */
export function addPdo(
  config: CanopenConfig,
  nodeId: string,
  direction: PdoDirection,
  newId: () => string,
  allocate: AllocateAddress,
): { config: CanopenConfig; number: number | null } {
  const node = config.nodes.find((n) => n.id === nodeId)
  const number = node ? addablePdoNumbers(node, direction)[0] : undefined
  if (!node || number === undefined) return { config, number: null }
  let pdo = edsPdo(node.eds, direction, number, node.nodeId, newId, allocate)
  if (pdo.cobId === 0) pdo = { ...pdo, cobId: freePdoCobId(config) ?? 0, followsNodeId: false }
  const list = direction === 'input' ? node.tpdos : node.rpdos
  return { config: updateNode(config, nodeId, (n) => withPdos(n, direction, [...list, pdo])), number }
}
