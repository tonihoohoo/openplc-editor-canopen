import { readFileSync } from 'fs'
import { join } from 'path'

import type { CanopenConfig, CanopenEdsInfo, CanopenNode } from '../../../../ports/canopen-types'
import { parseEds } from '../../eds-parser'
import { type AllocateAddress, createCanopenNode, defaultCanopenConfig } from '../../model'

export const GENERIC_IO_EDS = readFileSync(join(__dirname, 'generic-io-module.eds'), 'utf8')

export function genericIoEds(): CanopenEdsInfo {
  return parseEds(GENERIC_IO_EDS, 'generic-io-module.eds')
}

/** Allocates %IB0, %IB1, ... per prefix, in call order. */
export function sequentialAllocator(): AllocateAddress {
  const next = new Map<string, number>()
  return (prefix, isBit) => {
    const n = next.get(prefix) ?? 0
    next.set(prefix, n + 1)
    return isBit ? `${prefix}${Math.floor(n / 8)}.${n % 8}` : `${prefix}${n}`
  }
}

export function genericNode(nodeId = 2, allocate: AllocateAddress = sequentialAllocator()): CanopenNode {
  let id = 0
  return createCanopenNode(genericIoEds(), {
    id: `node-${nodeId}`,
    name: `io${nodeId}`,
    nodeId,
    newId: () => `ch${++id}`,
    allocate,
  })
}

export function canopenDevice(
  name: string,
  config: CanopenConfig,
): { name: string; protocol: 'canopen'; canopenConfig: CanopenConfig } {
  return { name, protocol: 'canopen', canopenConfig: config }
}

export function configWith(...nodes: CanopenNode[]): CanopenConfig {
  return { ...defaultCanopenConfig(), nodes }
}
