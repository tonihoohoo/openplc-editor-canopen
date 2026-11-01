import type { CanopenByteType, CanopenSdoDataType } from '../../ports/canopen-types'
import { canopenTypeBits, isByteType } from './data-types'

/** The most bytes the runtime writes in one startup SDO. */
export const MAX_SDO_BYTES = 1024

function encodeBytes(type: CanopenByteType, text: string): EncodeResult {
  let bytes: number[]
  if (type === 'VISIBLE_STRING') {
    bytes = []
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20 || code > 0x7e) return { ok: false, message: `"${ch}" is not a visible character (space to ~)` }
      bytes.push(code)
    }
  } else {
    const hex = text.replace(/\s+/g, '')
    if (!/^([0-9a-f]{2})*$/i.test(hex))
      return { ok: false, message: 'Enter the bytes as hexadecimal digits, two per byte, such as 01 A2 FF' }
    bytes = []
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }
  if (bytes.length === 0) return { ok: false, message: 'Enter at least one byte' }
  if (bytes.length > MAX_SDO_BYTES)
    return { ok: false, message: `${bytes.length} bytes; a startup SDO writes at most ${MAX_SDO_BYTES}` }
  return { ok: true, bytes }
}

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

/**
 * Encodes a value of this type as an SDO download sends it: numbers little-endian, text as its
 * characters without a terminator, OCTET_STRING and DOMAIN as the bytes given.
 */
export function encodeCanopenValue(type: CanopenSdoDataType, text: string): EncodeResult {
  if (isByteType(type)) return encodeBytes(type, text)
  const t = text.trim()
  if (type === 'BOOLEAN') {
    const lower = t.toLowerCase()
    if (lower === '1' || lower === 'true') return { ok: true, bytes: [1] }
    if (lower === '0' || lower === 'false') return { ok: true, bytes: [0] }
    return { ok: false, message: `"${text}" is not a BOOLEAN (0, 1, true or false)` }
  }
  if (type === 'REAL32' || type === 'REAL64') {
    const size = type === 'REAL32' ? 4 : 8
    // 0x text is the IEEE 754 bit pattern, as the EDS and DCF readers read it.
    if (/^0x[0-9a-f]+$/i.test(t)) {
      let raw = BigInt(t)
      if (raw >= BigInt(1) << BigInt(size * 8)) return { ok: false, message: `${text} has more than ${size * 8} bits` }
      const bytes: number[] = []
      for (let i = 0; i < size; i++) {
        bytes.push(Number(raw & BigInt(0xff)))
        raw >>= BigInt(8)
      }
      return { ok: true, bytes }
    }
    if (t === '' || !Number.isFinite(Number(t))) return { ok: false, message: `"${text}" is not a number` }
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
