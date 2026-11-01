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

  it('keeps parent names, limits and unsupported bit rates', () => {
    const eds = genericIoEds()
    expect(findObject(eds, 0x6401, 1)?.parentName).toBe('Analogue inputs')
    expect(findObject(eds, 0x2200, 2)?.parentName).toBe('Counters')
    expect(findObject(eds, 0x2100, 0)?.parentName).toBeUndefined()
    expect(eds.unsupportedBitrates).toEqual([])
    const text = GENERIC_IO_EDS.replace('BaudRate_1000=1', 'BaudRate_1000=0').replace(
      'ParameterName=Parameter\n',
      'ParameterName=Parameter\nLowLimit=1\nHighLimit=0x64\n',
    )
    const limited = parseEds(text, 'x.eds')
    expect(limited.unsupportedBitrates).toEqual([1000000])
    expect(findObject(limited, 0x2100, 0)).toMatchObject({ lowLimit: '1', highLimit: '0x64' })
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

  it('reads past lines CiA 306 does not allow, which the check reports', () => {
    const text = '[DeviceInfo]\nVendorName=x\nbroken line\nNrOfTXPDO=2 ; two\n'
    const eds = parseEds(text, 'x.eds')
    expect(eds.vendorName).toBe('x')
    expect(eds.txPdoCount).toBe(2)
  })

  it('leaves out objects whose DataType or AccessType it cannot read', () => {
    const text =
      '[DeviceInfo]\n[1000]\nObjectType=0x7\nDataType=0x0007\nAccessType=rx\n[1001]\nObjectType=0x7\n' +
      '[1008]\nDataType=0x0009\nAccessType=const\n'
    expect(parseEds(text, 'x.eds').objects.map((o) => o.index)).toEqual([0x1008])
    expect(parseEds('[DeviceInfo]\nVendorNumber=abc\n', 'x.eds').vendorId).toBe(0)
  })

  it('keeps ObjFlags', () => {
    const text = '[DeviceInfo]\n[2200]\nDataType=0x0007\nAccessType=rw\nObjFlags=0x1\n'
    expect(findObject(parseEds(text, 'x.eds'), 0x2200, 0)?.objFlags).toBe(1)
  })

  it('adds the PDOs CompactPDO implies, numbered from the lowest ones not described', () => {
    const text =
      '[DeviceInfo]\nNrOfTXPDO=4\nCompactPDO=0x13\n[1800]\nObjectType=0x9\nSubNumber=2\n' +
      '[1800sub0]\nDataType=0x0005\nAccessType=ro\nDefaultValue=1\n[1800sub1]\nDataType=0x0007\nAccessType=rw\n' +
      'DefaultValue=$NODEID+0x180\n[1A00]\nObjectType=0x9\nSubNumber=1\n[1A00sub0]\nDataType=0x0005\nAccessType=rw\n'
    const eds = parseEds(text, 'x.eds')
    for (const index of [0x1801, 0x1802, 0x1803]) {
      expect(findObject(eds, index, 1)?.dataType).toBe('UNSIGNED32')
      expect(findObject(eds, index, 2)?.access).toBe('rw')
      expect(findObject(eds, index, 3)).toBeUndefined()
      expect(findObject(eds, index, 5)?.dataType).toBe('UNSIGNED16')
      expect(findObject(eds, index + 0x200, 8)?.access).toBe('rw')
    }
    expect(findObject(eds, 0x1804, 1)).toBeUndefined()
    expect(findObject(eds, 0x1800, 2)).toBeUndefined()
  })

  it('keeps DOMAIN objects for startup SDOs and skips DEFTYPE objects', () => {
    const text =
      '[DeviceInfo]\n[1F50]\nObjectType=0x2\nParameterName=Program\nDataType=0x000F\nAccessType=rw\n' +
      '[2001]\nObjectType=0x2\nParameterName=Block\nAccessType=wo\n[0005]\nObjectType=0x5\n'
    expect(parseEds(text, 'x.eds').objects.map((o) => [o.index, o.name, o.dataType, o.access])).toEqual([
      [0x1f50, 'Program', '0x000F', 'rw'],
      [0x2001, 'Block', '0x000F', 'wo'],
    ])
  })

  it('reads the dummy objects [DummyUsage] allows', () => {
    const text = '[DeviceInfo]\n[DummyUsage]\nDummy0001=0\nDummy0005=1\nDummy0007=1\n'
    expect(parseEds(text, 'x.eds').dummyUsage).toEqual([5, 7])
    expect(parseEds('[DeviceInfo]\n', 'x.eds').dummyUsage).toBeUndefined()
  })
})
