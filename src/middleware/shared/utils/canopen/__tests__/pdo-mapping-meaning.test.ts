import type { CanopenObject } from '../../../ports/canopen-types'
import { displayFor, isPdoMappingEntry, pdoMappingMeaning } from '../object-info'

const object = (index: number, subIndex: number, extra: Partial<CanopenObject> = {}): CanopenObject => ({
  index,
  subIndex,
  name: 'x',
  dataType: 'UNSIGNED32',
  access: 'rw',
  pdoMapping: false,
  ...extra,
})

const objects = [
  object(0x6000, 1, { name: 'Read input 8 bits', parentName: 'Read input 8 bits', dataType: 'UNSIGNED8' }),
  object(0x6401, 2, { name: 'Analogue input 2', parentName: 'Read analogue input 16 bit', dataType: 'INTEGER16' }),
]

describe('pdoMappingMeaning', () => {
  it('names the mapped object and its bit length', () => {
    expect(pdoMappingMeaning(object(0x1a00, 1), String(0x60000108), objects)).toBe(
      '0x6000:01 Read input 8 bits, 8\u00a0bits',
    )
    expect(pdoMappingMeaning(object(0x1600, 64), String(0x64010210), objects)).toBe(
      '0x6401:02 Read analogue input 16 bit / Analogue input 2, 16\u00a0bits',
    )
  })

  it('gives the reference alone for an object the file does not describe', () => {
    expect(pdoMappingMeaning(object(0x1bff, 3), String(0x20000320), objects)).toBe('0x2000:03, 32\u00a0bits')
  })

  it('reads 0 as not used', () => {
    expect(pdoMappingMeaning(object(0x1a00, 2), '0', objects)).toBe('not used')
  })

  it.each([
    [0x1a00, 0],
    [0x1a00, 65],
    [0x1800, 1],
    [0x15ff, 1],
    [0x1c00, 1],
    [0x6000, 1],
  ])('says nothing for 0x%s sub %s', (index, subIndex) => {
    expect(pdoMappingMeaning(object(index, subIndex), String(0x60000108), objects)).toBeUndefined()
  })

  it('says nothing for a value that is not a 32-bit number', () => {
    expect(pdoMappingMeaning(object(0x1a00, 1), 'abc', objects)).toBeUndefined()
    expect(pdoMappingMeaning(object(0x1a00, 1), '-1', objects)).toBeUndefined()
    expect(pdoMappingMeaning(object(0x1a00, 1), String(0x100000000), objects)).toBeUndefined()
  })
})

describe('displayFor', () => {
  it('shows mapping entries in hex when the format is decimal', () => {
    expect(isPdoMappingEntry(object(0x1a00, 1))).toBe(true)
    expect(displayFor(object(0x1a00, 1), 'decimal')).toBe('hex')
    expect(displayFor(object(0x17ff, 64), 'decimal')).toBe('hex')
  })

  it('keeps the chosen format for other objects and for hex', () => {
    expect(displayFor(object(0x1a00, 0), 'decimal')).toBe('decimal')
    expect(displayFor(object(0x1800, 1), 'decimal')).toBe('decimal')
    expect(displayFor(object(0x1a00, 1), 'hex')).toBe('hex')
  })
})
