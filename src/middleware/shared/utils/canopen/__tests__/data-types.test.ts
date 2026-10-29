import { accessFits, canopenTypeBits, iecPrefixFor, iecSizeLetter, objectRef, toCanopenDataType } from '../data-types'

describe('CANopen data types', () => {
  it('maps types to bits and IEC locations', () => {
    expect(canopenTypeBits('BOOLEAN')).toBe(1)
    expect(canopenTypeBits('REAL64')).toBe(64)
    expect(iecSizeLetter('BOOLEAN')).toBe('X')
    expect(iecSizeLetter('INTEGER8')).toBe('B')
    expect(iecSizeLetter('UNSIGNED16')).toBe('W')
    expect(iecSizeLetter('REAL32')).toBe('D')
    expect(iecSizeLetter('UNSIGNED64')).toBe('L')
    expect(iecPrefixFor('UNSIGNED8', 'input')).toBe('%IB')
    expect(iecPrefixFor('BOOLEAN', 'output')).toBe('%QX')
  })

  it('knows only the supported type names', () => {
    expect(toCanopenDataType('UNSIGNED8')).toBe('UNSIGNED8')
    expect(toCanopenDataType('0x0009')).toBeUndefined()
  })

  it('lets inputs map readable objects and outputs writable ones', () => {
    expect(accessFits('ro', 'input')).toBe(true)
    expect(accessFits('wo', 'input')).toBe(false)
    expect(accessFits('rww', 'output')).toBe(true)
    expect(accessFits('ro', 'output')).toBe(false)
  })

  it('formats an object reference', () => {
    expect(objectRef(0x6000, 1)).toBe('0x6000:01')
  })
})
