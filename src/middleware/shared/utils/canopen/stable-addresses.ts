/**
 * Stable CANopen IEC addresses: an entry keeps its address when other entries, PDOs, nodes or
 * devices change. Only a new entry is given an address, the lowest free one, and only an entry
 * whose address is taken by a fixed address moves.
 */

import type { CanopenConfig, CanopenEntry, CanopenSlaveConfig, CanopenSlaveObject } from '../../ports/canopen-types'
import { type AddressPool, nextFreeAddress } from '../iec-address'
import type { IecAddressRegistry } from '../iec-address/registry/types'
import { nodeEntries } from './model'
import { isSlavePacked, slaveBitPrefix, slaveIecPrefix } from './slave'

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

/**
 * `next` with an address from `pool` for every slave object that had none in `previous` (a new row,
 * a constant made a PDO or SDO object, or a row whose type or direction changed the prefix), lowest
 * free first. Constants have no address. Objects that kept their prefix keep their address.
 */
export function addressNewSlaveObjects(
  previous: CanopenSlaveConfig | undefined,
  next: CanopenSlaveConfig,
  pool: AddressPool,
): CanopenSlaveConfig {
  const had = new Map<string, string>()
  const hadBits = new Map<string, string>()
  for (const o of previous?.objects ?? []) {
    if (o.iecLocation) had.set(o.id, o.iecLocation)
    if (o.bits) hadBits.set(o.id, o.bits.map((b) => b.iecLocation).join(','))
  }
  const pending = new Set<string>()
  const placeBits = (o: CanopenSlaveObject): CanopenSlaveObject => {
    const bits = o.bits ?? []
    const prefix = slaveBitPrefix(o.direction)
    const locations = bits.map((b) => b.iecLocation)
    if (hadBits.get(o.id) === locations.join(',') && locations.every((l) => l.startsWith(prefix)))
      return o.iecLocation === '' ? o : { ...o, iecLocation: '' }
    const given = locations.every((l) => l.startsWith(prefix) && BIT_ADDRESS.test(l) && !pending.has(l))
    if (!hadBits.has(o.id) && given && new Set(locations).size === locations.length) {
      for (const l of locations) pending.add(l)
      return { ...o, iecLocation: '' }
    }
    const byte = nextFreeByte(pool, prefix, pending)
    const placed = bits.map((b, i) => ({ ...b, iecLocation: `${prefix}${byte}.${i}` }))
    for (const b of placed) pending.add(b.iecLocation)
    return { ...o, iecLocation: '', bits: placed }
  }
  const place = (o: CanopenSlaveObject): CanopenSlaveObject => {
    if (isSlavePacked(o)) return placeBits(o)
    if (o.exchange === 'constant' || o.dataType === 'VISIBLE_STRING')
      return o.iecLocation === '' ? o : { ...o, iecLocation: '' }
    const prefix = slaveIecPrefix(o.dataType, o.direction)
    const old = had.get(o.id)
    if (old && old.startsWith(prefix) && o.iecLocation === old) return o
    if (!old && o.iecLocation.startsWith(prefix) && /^%[IQ][BWDL]\d+$/.test(o.iecLocation)) {
      pending.add(o.iecLocation)
      return o
    }
    const address = nextFreeAddress(pool, prefix, false, undefined, pending)
    pending.add(address)
    return { ...o, iecLocation: address }
  }
  return { ...next, objects: next.objects.map(place) }
}

const BIT_ADDRESS = /^%[IQ]X\d+\.[0-7]$/

/** The lowest image byte whose 8 bits under `prefix` (%IX or %QX) the pool and `alsoUsed` leave free. */
export function nextFreeByte(pool: AddressPool, prefix: string, alsoUsed: ReadonlySet<string>): number {
  const used = new Set<number>()
  const take = (address: string): void => {
    if (!address.startsWith(prefix)) return
    const byte = Number(address.slice(prefix.length).split('.')[0])
    if (Number.isInteger(byte)) used.add(byte)
  }
  for (const claim of pool.byPrefix.get(prefix) ?? []) take(claim.address)
  for (const address of alsoUsed) take(address)
  let byte = 0
  while (used.has(byte)) byte++
  return byte
}
