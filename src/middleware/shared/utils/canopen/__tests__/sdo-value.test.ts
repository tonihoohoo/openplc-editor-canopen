import { encodeCanopenValue, toHex } from '../sdo-value'

const bytes = (type: Parameters<typeof encodeCanopenValue>[0], text: string): string | null => {
  const r = encodeCanopenValue(type, text)
  return r.ok ? toHex(r.bytes) : null
}

describe('encodeCanopenValue', () => {
  it('encodes integers little-endian', () => {
    expect(bytes('UNSIGNED8', '255')).toBe('FF')
    expect(bytes('UNSIGNED16', '100')).toBe('6400')
    expect(bytes('UNSIGNED32', '0x12345678')).toBe('78563412')
    expect(bytes('INTEGER16', '-2')).toBe('FEFF')
    expect(bytes('INTEGER8', '-128')).toBe('80')
    expect(bytes('UNSIGNED64', '0xFFFFFFFFFFFFFFFF')).toBe('FFFFFFFFFFFFFFFF')
    expect(bytes('INTEGER64', '-1')).toBe('FFFFFFFFFFFFFFFF')
  })

  it('refuses values out of range', () => {
    expect(encodeCanopenValue('UNSIGNED8', '256')).toEqual({
      ok: false,
      message: '256 is out of range for UNSIGNED8 (0 to 255)',
    })
    expect(bytes('INTEGER8', '128')).toBeNull()
    expect(bytes('UNSIGNED16', '-1')).toBeNull()
  })

  it('refuses text that is not a number', () => {
    expect(bytes('UNSIGNED8', 'x')).toBeNull()
    expect(bytes('UNSIGNED8', '1.5')).toBeNull()
    expect(bytes('REAL32', 'abc')).toBeNull()
    expect(bytes('REAL32', '')).toBeNull()
  })

  it('encodes reals as IEEE 754', () => {
    expect(bytes('REAL32', '1')).toBe('0000803F')
    expect(bytes('REAL64', '-2.5')).toBe('00000000000004C0')
  })

  it('encodes booleans', () => {
    expect(bytes('BOOLEAN', 'true')).toBe('01')
    expect(bytes('BOOLEAN', '0')).toBe('00')
    expect(bytes('BOOLEAN', 'yes')).toBeNull()
  })
})
