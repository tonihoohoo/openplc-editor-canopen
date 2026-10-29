import type { CanopenDataType } from '../../ports/canopen-types'
import { canopenTypeBits } from './data-types'

export type EncodeResult = { ok: true; bytes: number[] } | { ok: false; message: string }

function parseBigInt(text: string): bigint | null {
  const t = text.trim()
  if (/^-?0x[0-9a-f]+$/i.test(t)) {
    const neg = t.startsWith('-')
    const v = BigInt(t.replace('-', ''))
    return neg ? -v : v
  }
  if (/^-?\d+$/.test(t)) return BigInt(t)
  return null
}

/** Encodes a value of this type as little-endian bytes, as an SDO download sends it. */
export function encodeCanopenValue(type: CanopenDataType, text: string): EncodeResult {
  const t = text.trim()
  if (type === 'BOOLEAN') {
    const lower = t.toLowerCase()
    if (lower === '1' || lower === 'true') return { ok: true, bytes: [1] }
    if (lower === '0' || lower === 'false') return { ok: true, bytes: [0] }
    return { ok: false, message: `"${text}" is not a BOOLEAN (0, 1, true or false)` }
  }
  if (type === 'REAL32' || type === 'REAL64') {
    if (t === '' || !Number.isFinite(Number(t))) return { ok: false, message: `"${text}" is not a number` }
    const size = type === 'REAL32' ? 4 : 8
    const view = new DataView(new ArrayBuffer(size))
    if (size === 4) view.setFloat32(0, Number(t), true)
    else view.setFloat64(0, Number(t), true)
    return { ok: true, bytes: Array.from(new Uint8Array(view.buffer)) }
  }
  const bits = canopenTypeBits(type)
  const value = parseBigInt(t)
  if (value === null) return { ok: false, message: `"${text}" is not an integer (decimal or 0x hexadecimal)` }
  const signed = type.startsWith('INTEGER')
  const one = BigInt(1)
  const min = signed ? -(one << BigInt(bits - 1)) : BigInt(0)
  const max = signed ? (one << BigInt(bits - 1)) - one : (one << BigInt(bits)) - one
  if (value < min || value > max)
    return { ok: false, message: `${text} is out of range for ${type} (${min} to ${max})` }
  let raw = value < BigInt(0) ? (one << BigInt(bits)) + value : value
  const bytes: number[] = []
  for (let i = 0; i < bits / 8; i++) {
    bytes.push(Number(raw & BigInt(0xff)))
    raw >>= BigInt(8)
  }
  return { ok: true, bytes }
}

export function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')
}
