/**
 * Stable CANopen IEC addresses: an entry keeps its address when other entries, PDOs, nodes or
 * devices change. Only a new entry is given an address, the lowest free one, and only an entry
 * whose address is taken by a fixed address moves.
 */

import type { CanopenConfig, CanopenEntry } from '../../ports/canopen-types'
import { type AddressPool, nextFreeAddress } from '../iec-address'
import type { IecAddressRegistry } from '../iec-address/registry/types'
import { nodeEntries } from './model'

const CANOPEN_KIND = 'canopen'

/**
 * The registry with CANopen channels left pinned at their addresses, except a channel whose
 * address an earlier pinned channel holds (a fixed address, or another CANopen entry), which is
 * unpinned so it takes the lowest free address.
 */
export function keepCanopenAddresses(registry: IecAddressRegistry): IecAddressRegistry {
  const held = new Set<string>()
  for (const consumer of registry.consumers) {
    if (consumer.kind === CANOPEN_KIND) continue
    for (const channel of consumer.channels) if (channel.pinned) held.add(channel.pinned)
  }
  const consumers = [...registry.consumers]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((consumer) => {
      if (consumer.kind !== CANOPEN_KIND) return consumer
      return {
        ...consumer,
        channels: consumer.channels.map((channel) => {
          if (!channel.pinned) return channel
          if (!held.has(channel.pinned)) {
            held.add(channel.pinned)
            return channel
          }
          const { pinned: _pinned, ...rest } = channel
          return rest
        }),
      }
    })
  return { ...registry, consumers }
}

const PREFIX = /^%[IQ][XBWDL]/i

/**
 * `next` with an address from `pool` for every entry that had none in `previous` (a new entry, or
 * one of a PDO the master now exchanges), lowest free first. Entries that had an address keep it.
 */
export function addressNewCanopenEntries(
  previous: CanopenConfig | undefined,
  next: CanopenConfig,
  pool: AddressPool,
): CanopenConfig {
  const had = new Set<string>()
  for (const node of previous?.nodes ?? [])
    for (const entry of nodeEntries(node)) if (entry.iecLocation) had.add(`${node.id}:${entry.channelId}`)
  const pending = new Set<string>()
  const place = (nodeId: string, entry: CanopenEntry): CanopenEntry => {
    if (!entry.iecLocation || had.has(`${nodeId}:${entry.channelId}`)) return entry
    const prefix = PREFIX.exec(entry.iecLocation)?.[0]?.toUpperCase()
    if (!prefix) return entry
    const address = nextFreeAddress(pool, prefix, prefix.endsWith('X'), undefined, pending)
    pending.add(address)
    return { ...entry, iecLocation: address }
  }
  return {
    ...next,
    nodes: next.nodes.map((node) => ({
      ...node,
      state: place(node.id, node.state),
      tpdos: node.tpdos.map((p) => ({ ...p, entries: p.entries.map((e) => place(node.id, e)) })),
      rpdos: node.rpdos.map((p) => ({ ...p, entries: p.entries.map((e) => place(node.id, e)) })),
    })),
  }
}
