/**
 * Values in EDS and DCF files (CiA 306 4.3): integers in decimal, hexadecimal or octal, the
 * `$NODEID+n` formula, and the ranges of the CiA 301 data types.
 */

export interface EdsIntegerText {
  value: bigint
  /** The value adds the node ID ($NODEID). */
  nodeId: boolean
  /** Written in octal (leading 0). */
  octal: boolean
  /** Written as "n+$NODEID", which CiA 306 does not read as a formula. */
  suffixFormula: boolean
}

const NUMBER = /^[+-]?(0x[0-9a-f]+|0[0-7]+|\d+)$/i

function numberPart(text: string): { value: bigint; octal: boolean } | null {
  if (!NUMBER.test(text)) return null
  const negative = text.startsWith('-')
  const body = text.replace(/^[+-]/, '')
  let value: bigint
  let octal = false
  if (/^0x/i.test(body)) value = BigInt(body)
  else if (/^0[0-7]+$/.test(body)) {
    value = BigInt(`0o${body.slice(1)}`)
    octal = true
  } else value = BigInt(body)
  return { value: negative ? -value : value, octal }
}

/** An integer entry value; null when the text is not one. */
export function parseEdsIntegerText(text: string): EdsIntegerText | null {
  const t = text.replace(/\s+/g, '')
  if (t === '') return null
  if (/^\$NODEID$/i.test(t)) return { value: 0n, nodeId: true, octal: false, suffixFormula: false }
  const prefix = /^\$NODEID\+(.+)$/i.exec(t)
  if (prefix) {
    const n = numberPart(prefix[1])
    return n && { value: n.value, nodeId: true, octal: n.octal, suffixFormula: false }
  }
  const suffix = /^(.+)\+\$NODEID$/i.exec(t)
  if (suffix) {
    const n = numberPart(suffix[1])
    return n && { value: n.value, nodeId: true, octal: n.octal, suffixFormula: true }
  }
  const n = numberPart(t)
  return n && { value: n.value, nodeId: false, octal: n.octal, suffixFormula: false }
}

export interface EdsTypeInfo {
  name: string
  /** Integer range; absent for non-integer types. */
  range?: readonly [bigint, bigint]
  real?: 32 | 64
  /** Octet string or domain: hexadecimal bytes. */
  octets?: boolean
  string?: boolean
}

function signed(bits: number): readonly [bigint, bigint] {
  const half = 1n << BigInt(bits - 1)
  return [-half, half - 1n]
}

function unsigned(bits: number): readonly [bigint, bigint] {
  return [0n, (1n << BigInt(bits)) - 1n]
}

/** CiA 301 static data types by code. */
export const EDS_TYPES: Readonly<Record<number, EdsTypeInfo>> = {
  0x0001: { name: 'BOOLEAN', range: [0n, 1n] },
  0x0002: { name: 'INTEGER8', range: signed(8) },
  0x0003: { name: 'INTEGER16', range: signed(16) },
  0x0004: { name: 'INTEGER32', range: signed(32) },
  0x0005: { name: 'UNSIGNED8', range: unsigned(8) },
  0x0006: { name: 'UNSIGNED16', range: unsigned(16) },
  0x0007: { name: 'UNSIGNED32', range: unsigned(32) },
  0x0008: { name: 'REAL32', real: 32 },
  0x0009: { name: 'VISIBLE_STRING', string: true },
  0x000a: { name: 'OCTET_STRING', octets: true },
  0x000b: { name: 'UNICODE_STRING', octets: true },
  0x000c: { name: 'TIME_OF_DAY' },
  0x000d: { name: 'TIME_DIFFERENCE' },
  0x000f: { name: 'DOMAIN', octets: true },
  0x0010: { name: 'INTEGER24', range: signed(24) },
  0x0011: { name: 'REAL64', real: 64 },
  0x0012: { name: 'INTEGER40', range: signed(40) },
  0x0013: { name: 'INTEGER48', range: signed(48) },
  0x0014: { name: 'INTEGER56', range: signed(56) },
  0x0015: { name: 'INTEGER64', range: signed(64) },
  0x0016: { name: 'UNSIGNED24', range: unsigned(24) },
  0x0018: { name: 'UNSIGNED40', range: unsigned(40) },
  0x0019: { name: 'UNSIGNED48', range: unsigned(48) },
  0x001a: { name: 'UNSIGNED56', range: unsigned(56) },
  0x001b: { name: 'UNSIGNED64', range: unsigned(64) },
}

/** The range a value written with or without $NODEID covers for node IDs 1 to 127. */
export function edsValueSpan(v: EdsIntegerText): readonly [bigint, bigint] {
  return v.nodeId ? [v.value + 1n, v.value + 127n] : [v.value, v.value]
}

/** A REAL value: decimal, or the IEEE 754 bit pattern in hexadecimal. Null when it is neither. */
export function parseEdsReal(text: string, bits: 32 | 64): number | null {
  const t = text.trim()
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) {
    const v = Number(t)
    return Number.isFinite(v) ? v : null
  }
  if (/^0x[0-9a-f]+$/i.test(t)) {
    const raw = BigInt(t)
    if (raw >= 1n << BigInt(bits)) return null
    const view = new DataView(new ArrayBuffer(8))
    if (bits === 32) {
      view.setUint32(0, Number(raw))
      return view.getFloat32(0)
    }
    view.setBigUint64(0, raw)
    return view.getFloat64(0)
  }
  return null
}

/** CiA 306 4.3: an octet string or domain value is hexadecimal bytes without 0x. */
export function isEdsOctets(text: string): boolean {
  return /^([0-9a-f]{2})*$/i.test(text.trim())
}
