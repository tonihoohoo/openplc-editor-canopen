import { EdsParseError, findObject, parseEds, parseEdsInteger } from '../eds-parser'
import { GENERIC_IO_EDS, genericIoEds } from './fixtures/helpers'

describe('parseEdsInteger', () => {
  it('reads decimal, hexadecimal and octal numbers', () => {
    expect(parseEdsInteger('42')).toBe(42)
    expect(parseEdsInteger('0x2A')).toBe(42)
    expect(parseEdsInteger('052')).toBe(42)
    expect(parseEdsInteger('-5')).toBe(-5)
    expect(parseEdsInteger('0')).toBe(0)
  })

  it('replaces $NODEID with the node ID', () => {
    expect(parseEdsInteger('$NODEID+0x180', 2)).toBe(0x182)
    expect(parseEdsInteger('0x200 + $nodeid', 5)).toBe(0x205)
  })

  it('returns null for text that is not a number', () => {
    expect(parseEdsInteger('')).toBeNull()
    expect(parseEdsInteger('abc')).toBeNull()
    expect(parseEdsInteger('1+')).toBeNull()
    expect(parseEdsInteger('1.5')).toBeNull()
  })
})

describe('parseEds', () => {
  it('reads the identity and PDO counts', () => {
    const eds = genericIoEds()
    expect(eds).toMatchObject({
      fileName: 'generic-io-module.eds',
      vendorName: 'Simulated',
      productName: 'Generic I/O module',
      deviceType: 0x191,
      vendorId: 1,
      productCode: 2,
      revision: 3,
      rxPdoCount: 1,
      txPdoCount: 1,
    })
  })

  it('reads VAR, RECORD and ARRAY objects with their sub-indices, sorted', () => {
    const eds = genericIoEds()
    expect(findObject(eds, 0x1017, 0)).toMatchObject({ dataType: 'UNSIGNED16', access: 'rw', defaultValue: '0' })
    expect(findObject(eds, 0x1018, 2)).toMatchObject({ name: 'Product code', dataType: 'UNSIGNED32', access: 'ro' })
    expect(findObject(eds, 0x6401, 1)).toMatchObject({ dataType: 'INTEGER16', pdoMapping: true })
    expect(findObject(eds, 0x1800, 4)).toBeUndefined()
    const keys = eds.objects.map((o) => o.index * 256 + o.subIndex)
    expect(keys).toEqual([...keys].sort((a, b) => a - b))
  })

  it('keeps the code of a type the master does not support', () => {
    expect(findObject(genericIoEds(), 0x1008, 0)?.dataType).toBe('0x0009')
  })

  it('expands CompactSubObj with the names of the Name section', () => {
    const eds = genericIoEds()
    expect(findObject(eds, 0x2200, 0)).toMatchObject({ dataType: 'UNSIGNED8', defaultValue: '2' })
    expect(findObject(eds, 0x2200, 1)?.name).toBe('First counter')
    expect(findObject(eds, 0x2200, 2)).toMatchObject({ name: 'Counters 2', dataType: 'UNSIGNED16', pdoMapping: true })
  })

  it('accepts CRLF line ends and lower-case section names', () => {
    const text = GENERIC_IO_EDS.replace(/\n/g, '\r\n').replace('[6000sub1]', '[6000SUB1]')
    expect(findObject(parseEds(text, 'x.eds'), 0x6000, 1)?.name).toBe('Inputs 1-8')
  })

  it('refuses a file without a DeviceInfo section', () => {
    expect(() => parseEds('[FileInfo]\nFileName=x\n', 'x.eds')).toThrow(/no \[DeviceInfo\] section/)
  })

  it('names the line of a malformed entry', () => {
    expect(() => parseEds('[DeviceInfo]\nVendorName=x\nbroken line\n', 'x.eds')).toThrow(
      new EdsParseError('line 3: expected "key=value", found "broken line"'),
    )
    expect(() => parseEds('[DeviceInfo\n', 'x.eds')).toThrow(/line 1: section header/)
    expect(() => parseEds('Key=1\n[DeviceInfo]\n', 'x.eds')).toThrow(/line 1: "Key=1" is outside any section/)
  })

  it('names the section of a bad value', () => {
    const text = '[DeviceInfo]\nVendorNumber=abc\n'
    expect(() => parseEds(text, 'x.eds')).toThrow(/\[DEVICEINFO\] line 2: VendorNumber "abc" is not a number/)
    const access = '[DeviceInfo]\n[1000]\nObjectType=0x7\nDataType=0x0007\nAccessType=rx\n'
    expect(() => parseEds(access, 'x.eds')).toThrow(/AccessType "rx"/)
    const noType = '[DeviceInfo]\n[1000]\nObjectType=0x7\n'
    expect(() => parseEds(noType, 'x.eds')).toThrow(/missing DataType/)
  })

  it('skips DOMAIN and DEFTYPE objects', () => {
    const text = '[DeviceInfo]\n[1F50]\nObjectType=0x2\nDataType=0x000F\n[0005]\nObjectType=0x5\n'
    expect(parseEds(text, 'x.eds').objects).toEqual([])
  })
})
