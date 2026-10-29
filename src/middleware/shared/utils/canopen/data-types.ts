import type { CanopenAccess, CanopenDataType } from '../../ports/canopen-types'

/** CiA 301 data type codes of the supported basic types. */
export const CANOPEN_TYPE_CODES: Readonly<Record<number, CanopenDataType>> = {
  0x0001: 'BOOLEAN',
  0x0002: 'INTEGER8',
  0x0003: 'INTEGER16',
  0x0004: 'INTEGER32',
  0x0005: 'UNSIGNED8',
  0x0006: 'UNSIGNED16',
  0x0007: 'UNSIGNED32',
  0x0008: 'REAL32',
  0x0011: 'REAL64',
  0x0015: 'INTEGER64',
  0x001b: 'UNSIGNED64',
}

const TYPE_BITS: Readonly<Record<CanopenDataType, number>> = {
  BOOLEAN: 1,
  INTEGER8: 8,
  UNSIGNED8: 8,
  INTEGER16: 16,
  UNSIGNED16: 16,
  INTEGER32: 32,
  UNSIGNED32: 32,
  REAL32: 32,
  INTEGER64: 64,
  UNSIGNED64: 64,
  REAL64: 64,
}

export const CANOPEN_DATA_TYPES: readonly CanopenDataType[] = [
  'BOOLEAN',
  'INTEGER8',
  'INTEGER16',
  'INTEGER32',
  'INTEGER64',
  'UNSIGNED8',
  'UNSIGNED16',
  'UNSIGNED32',
  'UNSIGNED64',
  'REAL32',
  'REAL64',
]

export function toCanopenDataType(name: string): CanopenDataType | undefined {
  return CANOPEN_DATA_TYPES.find((t) => t === name)
}

/** Bits the type occupies in a PDO. */
export function canopenTypeBits(type: CanopenDataType): number {
  return TYPE_BITS[type]
}

/** IEC size letter of a location that holds the type (X, B, W, D or L). */
export function iecSizeLetter(type: CanopenDataType): 'X' | 'B' | 'W' | 'D' | 'L' {
  switch (TYPE_BITS[type]) {
    case 1:
      return 'X'
    case 8:
      return 'B'
    case 16:
      return 'W'
    case 32:
      return 'D'
    default:
      return 'L'
  }
}

/** Prefix of the location for an entry of this type: inputs (%I) for TPDOs, outputs (%Q) for RPDOs. */
export function iecPrefixFor(type: CanopenDataType, direction: 'input' | 'output'): string {
  return `%${direction === 'input' ? 'I' : 'Q'}${iecSizeLetter(type)}`
}

/** Whether the master may map an object with this access into a PDO in this direction. */
export function accessFits(access: CanopenAccess, direction: 'input' | 'output'): boolean {
  if (direction === 'input') return access === 'ro' || access === 'rw' || access === 'rwr' || access === 'const'
  return access === 'wo' || access === 'rw' || access === 'rww'
}

/** Bit rates of the CiA 301 table, in bit/s. */
export const CANOPEN_BITRATES = [10000, 20000, 50000, 125000, 250000, 500000, 800000, 1000000] as const

/** "0x6000:01" for index 0x6000, sub-index 1. */
export function objectRef(index: number, subIndex: number): string {
  return `0x${index.toString(16).toUpperCase().padStart(4, '0')}:${subIndex.toString(16).toUpperCase().padStart(2, '0')}`
}
