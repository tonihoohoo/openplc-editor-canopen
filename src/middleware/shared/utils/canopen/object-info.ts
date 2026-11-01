/**
 * Presenting what an XDD/XDC says about an object: value meanings, units, scaled values, bit
 * names and a one-line description, from the device file or else the standard (see
 * `standard-meanings.ts`). Pure.
 */

import type { CanopenObject } from '../../ports/canopen-types'
import { objectInfo, standardValueMeaning } from './standard-meanings'

function sameNumber(a: string, b: string): boolean {
  const x = Number(a.trim())
  const y = Number(b.trim())
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a.trim() === b.trim()
}

/** The meaning of @p raw from the object's value list, if it has one. */
export function valueMeaning(object: CanopenObject | undefined, raw: string): string | undefined {
  const hit = objectInfo(object)?.values?.find((v) => sameNumber(v.value, raw))?.label
  if (hit) return hit
  const n = Number(raw.trim())
  return Number.isInteger(n) ? standardValueMeaning(object, n) : undefined
}

/** (raw + offset) x multiplier, with the unit, or undefined when the object has no scaling or unit. */
export function scaledValue(object: CanopenObject | undefined, raw: string): string | undefined {
  const info = objectInfo(object)
  if (!info || (info.multiplier === undefined && info.offset === undefined && info.unit === undefined)) return undefined
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return undefined
  const value = (n + (info.offset ?? 0)) * (info.multiplier ?? 1)
  const shown = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)))
  return info.unit ? `${shown} ${info.unit}` : shown
}

/** "3 (profile velocity)", "1234 (12.34 bar)" or just the raw text. */
export function describeValue(object: CanopenObject | undefined, raw: string): string {
  const meaning = valueMeaning(object, raw)
  if (meaning) return `${raw} (${meaning})`
  const scaled = scaledValue(object, raw)
  if (scaled && scaled !== raw) return `${raw} (${scaled})`
  return raw
}

/** The names of the bits set in @p raw and "name=value" for each non-zero multi-bit field. */
export function setBitNames(object: CanopenObject | undefined, raw: string): string[] {
  const bits = objectInfo(object)?.bits
  if (!bits) return []
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 0) return []
  const field = (lsb: number, width: number): number => Math.floor(n / 2 ** lsb) % 2 ** width
  return bits.flatMap((b) => {
    const v = field(Number(b.value), b.width ?? 1)
    if (v === 0) return []
    if (!b.width || b.width === 1) return [b.label]
    const hex = /^(index|can-id|error code)$/i.test(b.label)
    return [`${b.label}=${hex ? `0x${v.toString(16).toUpperCase()}` : v}`]
  })
}

/** The first line of the description, at most @p max characters. */
export function shortDescription(object: CanopenObject | undefined, max = 140): string | undefined {
  const d = objectInfo(object)
    ?.description?.split('\n')
    .map((l) => l.replace(/^\s*[*-]\s*/, '').trim())
    .filter((l) => l !== '')
    .join('; ')
    .replace(/:;/g, ':')
  if (!d) return undefined
  return d.length > max ? `${d.slice(0, max - 1)}…` : d
}
