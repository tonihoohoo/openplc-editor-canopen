/**
 * PDO entries split into bits: an UNSIGNED8/16/32 entry whose bits each take their own %IX or %QX
 * address. The node still maps, sends and receives one value. Pure.
 */

import type {
  CanopenChannel,
  CanopenDataType,
  CanopenEdsInfo,
  CanopenEntry,
  CanopenEntryBit,
  CanopenPdo,
} from '../../ports/canopen-types'
import { canopenTypeBits } from './data-types'
import { findObject } from './eds-parser'

/** Types whose entries can be split into bits. */
export const SPLITTABLE_TYPES: readonly CanopenDataType[] = ['UNSIGNED8', 'UNSIGNED16', 'UNSIGNED32']

/** Whether the entry is split into bits. */
export function isSplitEntry(entry: CanopenEntry): boolean {
  return (entry.bits?.length ?? 0) > 0
}

/** Whether `entry` of `pdo` may be split: an exchanged PDO, an UNSIGNED8/16/32 object of the device file. */
export function canSplitEntry(eds: CanopenEdsInfo, pdo: CanopenPdo, entry: CanopenEntry): boolean {
  if (!pdo.exchanged || !SPLITTABLE_TYPES.includes(entry.dataType)) return false
  if (entry.index >= 1 && entry.index <= 7 && entry.subIndex === 0) return false
  return findObject(eds, entry.index, entry.subIndex) !== undefined
}

/** Registry channel id of bit `bit` of the entry with channel id `channelId`. */
export function entryBitChannel(channelId: string, bit: number): string {
  return `${channelId}.${bit}`
}

/**
 * Names of the entry's bits: from the device file's bit fields (an XDD or XDC struct), a field
 * wider than one bit naming each of its bits with its offset in the field; else "Bit n".
 */
export function entryBitNames(
  eds: CanopenEdsInfo,
  entry: Pick<CanopenEntry, 'index' | 'subIndex' | 'dataType'>,
): string[] {
  const count = canopenTypeBits(entry.dataType)
  const names = Array.from({ length: count }, (_, i) => `Bit ${i}`)
  const fields = findObject(eds, entry.index, entry.subIndex)?.info?.bits ?? []
  for (const field of fields) {
    const low = Number(field.value)
    const width = field.width ?? 1
    if (!Number.isInteger(low) || low < 0 || field.label.trim() === '') continue
    for (let k = 0; k < width && low + k < count; k++) names[low + k] = width > 1 ? `${field.label} ${k}` : field.label
  }
  return names
}

/**
 * The entry with its bits switched on or off. On: one bit per bit of its type, named from the
 * device file, with a placeholder address of `bitPrefix` (%IX or %QX) that the project's address
 * placement replaces, and no address or alias of its own. Off: the bits dropped and a placeholder
 * address of `wholePrefix` for the entry.
 */
export function withEntryBits(
  eds: CanopenEdsInfo,
  entry: CanopenEntry,
  on: boolean,
  bitPrefix: string,
  wholePrefix: string,
): CanopenEntry {
  if (on) {
    if (isSplitEntry(entry)) return entry
    const bits: CanopenEntryBit[] = entryBitNames(eds, entry).map((name, i) => ({
      channelId: entryBitChannel(entry.channelId, i),
      name,
      iecLocation: `${bitPrefix}0.0`,
    }))
    const { alias: _alias, ...rest } = entry
    return { ...rest, iecLocation: '', bits }
  }
  if (!isSplitEntry(entry)) return entry
  const { bits: _bits, ...rest } = entry
  return { ...rest, iecLocation: `${wholePrefix}0` }
}

/** The entry with its bit names read again from `eds`; addresses and aliases kept. */
export function withBitNamesFrom(eds: CanopenEdsInfo, entry: CanopenEntry): CanopenEntry {
  if (!entry.bits) return entry
  const names = entryBitNames(eds, entry)
  return { ...entry, bits: entry.bits.map((b, i) => ({ ...b, name: names[i] ?? b.name })) }
}

/** The address-holding channels of an entry: its bits when split, else the entry itself. */
export function entryChannels(entry: CanopenEntry): CanopenChannel[] {
  return isSplitEntry(entry) ? (entry.bits ?? []) : [entry]
}

/** Aliases the entry holds that switching its bits would drop: its own when on, its bits' when off. */
export function aliasesDroppedBySwitch(entry: CanopenEntry): string[] {
  const holders = isSplitEntry(entry) ? (entry.bits ?? []) : [entry]
  return holders.flatMap((h) => (h.alias ? [h.alias] : []))
}
