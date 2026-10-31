import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { decodeDeviceFile, deviceFileFormat, deviceFileHash } from '../device-file'
import { checkEds, CIA306_RULES, commDataType, findingPlace, ruleClause } from '../eds-check'
import { readEdsDocument } from '../eds-document'
import { parseEdsIntegerText, parseEdsReal } from '../eds-values'

const FIXTURES = join(__dirname, 'fixtures', 'cia306')

/** A small EDS with no findings; tests add one defect each. */
export const CLEAN_EDS = [
  '[FileInfo]',
  'FileName=clean.eds',
  'FileVersion=1',
  'FileRevision=0',
  'EDSVersion=4.0',
  'Description=Generic I/O module',
  'CreationTime=09:45AM',
  'CreationDate=05-15-2026',
  'CreatedBy=Test',
  '',
  '[DeviceInfo]',
  'VendorName=Vendor',
  'VendorNumber=0x100',
  'ProductName=Generic I/O module',
  'ProductNumber=1',
  'RevisionNumber=1',
  'OrderCode=IO-1',
  'BaudRate_10=0',
  'BaudRate_20=0',
  'BaudRate_50=0',
  'BaudRate_125=1',
  'BaudRate_250=1',
  'BaudRate_500=1',
  'BaudRate_800=0',
  'BaudRate_1000=0',
  'SimpleBootUpMaster=0',
  'SimpleBootUpSlave=1',
  'Granularity=8',
  'DynamicChannelsSupported=0',
  'GroupMessaging=0',
  'NrOfRXPDO=0',
  'NrOfTXPDO=1',
  'LSS_Supported=0',
  '',
  '[MandatoryObjects]',
  'SupportedObjects=3',
  '1=0x1000',
  '2=0x1001',
  '3=0x1018',
  '',
  '[OptionalObjects]',
  'SupportedObjects=3',
  '1=0x1800',
  '2=0x1A00',
  '3=0x6401',
  '',
  '[1000]',
  'ParameterName=Device type',
  'DataType=0x0007',
  'AccessType=ro',
  'DefaultValue=0x191',
  'PDOMapping=0',
  '',
  '[1001]',
  'ParameterName=Error register',
  'DataType=0x0005',
  'AccessType=ro',
  'PDOMapping=0',
  '',
  '[1018]',
  'ParameterName=Identity',
  'ObjectType=0x9',
  'SubNumber=2',
  '',
  '[1018sub0]',
  'ParameterName=Highest sub-index',
  'DataType=0x0005',
  'AccessType=ro',
  'DefaultValue=1',
  '',
  '[1018sub1]',
  'ParameterName=Vendor-ID',
  'DataType=0x0007',
  'AccessType=ro',
  'DefaultValue=0x100',
  '',
  '[1800]',
  'ParameterName=TPDO 1 communication parameter',
  'ObjectType=0x9',
  'SubNumber=3',
  '',
  '[1800sub0]',
  'ParameterName=Highest sub-index',
  'DataType=0x0005',
  'AccessType=ro',
  'DefaultValue=5',
  '',
  '[1800sub1]',
  'ParameterName=COB-ID',
  'DataType=0x0007',
  'AccessType=rw',
  'DefaultValue=$NODEID+0x180',
  '',
  '[1800sub5]',
  'ParameterName=Event timer',
  'DataType=0x0006',
  'AccessType=rw',
  'DefaultValue=0',
  '',
  '[1A00]',
  'ParameterName=TPDO 1 mapping parameter',
  'ObjectType=0x9',
  'SubNumber=2',
  '',
  '[1A00sub0]',
  'ParameterName=Number of mapped objects',
  'DataType=0x0005',
  'AccessType=rw',
  'DefaultValue=1',
  '',
  '[1A00sub1]',
  'ParameterName=Mapped object 1',
  'DataType=0x0007',
  'AccessType=rw',
  'DefaultValue=0x64010110',
  '',
  '[6401]',
  'ParameterName=Analog inputs',
  'ObjectType=0x8',
  'SubNumber=2',
  '',
  '[6401sub0]',
  'ParameterName=Highest sub-index',
  'DataType=0x0005',
  'AccessType=ro',
  'DefaultValue=1',
  '',
  '[6401sub1]',
  'ParameterName=Analog input 1',
  'DataType=0x0003',
  'AccessType=ro',
  'PDOMapping=1',
  'LowLimit=-100',
  'HighLimit=100',
  'DefaultValue=0',
  '',
].join('\n')

function check(text: string): ReturnType<typeof checkEds> {
  return checkEds(readEdsDocument(text))
}

function rules(text: string): string[] {
  return check(text).findings.map((f) => `${f.severity} ${f.rule} ${f.section ?? ''}`)
}

function edit(text: string, section: string, key: string, value: string | null): string {
  const lines = text.split('\n')
  const start = lines.indexOf(`[${section}]`)
  let i = start + 1
  while (i < lines.length && lines[i] !== '' && !lines[i].startsWith('[')) {
    if (lines[i].toLowerCase().startsWith(`${key.toLowerCase()}=`)) {
      if (value === null) lines.splice(i, 1)
      else lines[i] = `${key}=${value}`
      return lines.join('\n')
    }
    i++
  }
  if (value !== null) lines.splice(i, 0, `${key}=${value}`)
  return lines.join('\n')
}

describe('decodeDeviceFile', () => {
  it('reads UTF-8 with or without a byte order mark', () => {
    const bytes = new TextEncoder().encode('[DeviceInfo]\nProductName=50 °C\n')
    expect(decodeDeviceFile(bytes)).toEqual({ text: '[DeviceInfo]\nProductName=50 °C\n', encoding: 'utf-8' })
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])
    expect(decodeDeviceFile(bom)).toEqual({ text: '[DeviceInfo]\nProductName=50 °C\n', encoding: 'utf-8-bom' })
  })

  it('reads a file that is not UTF-8 as Windows-1252', () => {
    const bytes = new Uint8Array([0x54, 0x3d, 0x35, 0x30, 0xb0, 0x43, 0x20, 0x80, 0x94])
    expect(decodeDeviceFile(bytes)).toEqual({ text: 'T=50°C €”', encoding: 'windows-1252' })
  })

  it('hashes the text and tells DCF from EDS by name', async () => {
    expect(await deviceFileHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(deviceFileFormat('node_2.DCF')).toBe('dcf')
    expect(deviceFileFormat('io.eds')).toBe('eds')
  })
})

describe('EDS values', () => {
  it('reads decimal, hexadecimal, octal and the $NODEID formula', () => {
    expect(parseEdsIntegerText('10')?.value).toBe(10n)
    expect(parseEdsIntegerText('0x0A')?.value).toBe(10n)
    expect(parseEdsIntegerText('012')).toEqual({ value: 10n, nodeId: false, octal: true, suffixFormula: false })
    expect(parseEdsIntegerText('$NODEID + 0x180')).toEqual({
      value: 0x180n,
      nodeId: true,
      octal: false,
      suffixFormula: false,
    })
    expect(parseEdsIntegerText('0x180+$NODEID')?.suffixFormula).toBe(true)
    expect(parseEdsIntegerText('-5')?.value).toBe(-5n)
    expect(parseEdsIntegerText('0x')).toBeNull()
    expect(parseEdsIntegerText('')).toBeNull()
  })

  it('reads REALs as decimal or as their bit pattern', () => {
    expect(parseEdsReal('12.5', 32)).toBe(12.5)
    expect(parseEdsReal('0x3F800000', 32)).toBe(1)
    expect(parseEdsReal('0x3FF0000000000000', 64)).toBe(1)
    expect(parseEdsReal('abc', 32)).toBeNull()
  })
})

describe('checkEds', () => {
  it('finds nothing in a clean file', () => {
    expect(rules(CLEAN_EDS)).toEqual([])
  })

  it('gives the findings recorded for the ported fixtures', () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Record<
      string,
      { encoding: string; ok: boolean; findings: string[] }
    >
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.eds'))
    expect(files.sort()).toEqual(Object.keys(expected).sort())
    for (const file of files) {
      const decoded = decodeDeviceFile(new Uint8Array(readFileSync(join(FIXTURES, file))))
      const result = checkEds(readEdsDocument(decoded.text), { encoding: decoded.encoding })
      const got = result.findings.map((x) => `${x.severity} ${x.rule} ${x.section ?? ''}${x.key ? ` ${x.key}` : ''}`)
      expect({ file, encoding: decoded.encoding, ok: result.ok, findings: got }).toEqual({ file, ...expected[file] })
    }
  })

  it('refuses a broken communication object, naming section, line and the expected type', () => {
    const result = check(edit(CLEAN_EDS, '1A00sub0', 'DataType', '0x0007'))
    expect(result.ok).toBe(false)
    const error = result.findings.find((f) => f.severity === 'error')
    expect(error).toMatchObject({ rule: 'comm-data-type', section: '1A00sub0', key: 'DataType', index: 0x1a00 })
    expect(error?.message).toMatch(/UNSIGNED8/)
    expect(error && findingPlace(error)).toMatch(/^\[1A00sub0\] DataType line \d+$/)
    expect(ruleClause('comm-data-type')).toBe('CiA 301')
  })

  it('only warns about a trailing comment and a default above its HighLimit', () => {
    let text = edit(CLEAN_EDS, '6401sub1', 'DefaultValue', '150')
    text = text.replace('AccessType=rw\nDefaultValue=0\n', 'AccessType=rw ; writable\nDefaultValue=0\n')
    const result = check(text)
    expect(result.ok).toBe(true)
    expect(result.findings.map((f) => f.rule).sort()).toEqual(['trailing-comment', 'value-limits'])
  })

  it('refuses a file without [DeviceInfo]', () => {
    const result = check('[FileInfo]\nFileName=x.eds\n')
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ rule: 'device-info-missing', severity: 'error' })])
  })

  it('blocks only errors in the communication area that are not about limits', () => {
    expect(check(edit(CLEAN_EDS, '6401sub1', 'AccessType', 'rx')).ok).toBe(true)
    expect(check(edit(CLEAN_EDS, '1800sub1', 'AccessType', 'rx')).ok).toBe(false)
    expect(check(edit(CLEAN_EDS, '1800sub1', 'DataType', null)).ok).toBe(false)
    expect(check(edit(CLEAN_EDS, '1800sub5', 'DefaultValue', '70000')).ok).toBe(false)
    expect(check(edit(CLEAN_EDS, '1800sub5', 'HighLimit', '70000')).ok).toBe(true)
    expect(check(edit(CLEAN_EDS, '1800sub5', 'DefaultValue', 'abc')).ok).toBe(false)
    expect(check(edit(CLEAN_EDS, '1800', 'SubNumber', '4')).ok).toBe(false)
  })

  it('checks [FileInfo] dates, times and versions', () => {
    let text = edit(CLEAN_EDS, 'FileInfo', 'CreationDate', '2026-05-15')
    text = edit(text, 'FileInfo', 'CreationTime', '21:45')
    text = edit(text, 'FileInfo', 'EDSVersion', '4')
    text = edit(text, 'FileInfo', 'FileVersion', '300')
    expect(rules(text)).toEqual([
      'warning file-info FileInfo',
      'warning file-info FileInfo',
      'warning time-format FileInfo',
      'warning date-format FileInfo',
    ])
  })

  it('checks the object lists', () => {
    let text = edit(CLEAN_EDS, 'OptionalObjects', 'SupportedObjects', '4')
    expect(rules(text)).toEqual(['warning object-list OptionalObjects'])
    text = edit(CLEAN_EDS, 'OptionalObjects', '3', '0x2000')
    expect(rules(text)).toEqual([
      'warning object-section OptionalObjects',
      'warning object-list-place OptionalObjects',
      'warning object-unlisted 6401',
    ])
    text = edit(CLEAN_EDS, 'MandatoryObjects', 'SupportedObjects', '2')
    expect(rules(edit(text, 'MandatoryObjects', '3', null))).toEqual([
      'warning mandatory-objects MandatoryObjects',
      'warning object-unlisted 1018',
    ])
  })

  it('checks ObjFlags, PDOMapping, names and unknown entries', () => {
    let text = edit(CLEAN_EDS, '6401sub1', 'ObjFlags', '0x5')
    text = edit(text, '6401sub1', 'PDOMapping', '2')
    text = edit(text, '6401sub1', 'Unit', 'mV')
    text = edit(text, '1001', 'ParameterName', null)
    expect(rules(text).sort()).toEqual([
      'warning obj-flags 6401sub1',
      'warning parameter-name 1001',
      'warning pdo-mapping 6401sub1',
      'warning unknown-key 6401sub1',
    ])
  })

  it('checks CompactSubObj and its lists', () => {
    const compact = [
      '[2000]',
      'ParameterName=Outputs',
      'ObjectType=0x8',
      'DataType=0x0005',
      'AccessType=rw',
      'DefaultValue=0',
      'CompactSubObj=2',
      '',
      '[2000Name]',
      'NrOfEntries=2',
      '1=First',
      '',
      '[2000Value]',
      'NrOfEntries=1',
      '3=300',
      '',
      '[ManufacturerObjects]',
      'SupportedObjects=1',
      '1=0x2000',
      '',
    ].join('\n')
    expect(rules(`${CLEAN_EDS}\n${compact}`)).toEqual([
      'warning compact-list 2000Name',
      'warning compact-list 2000Value',
    ])
  })

  it('checks the lines themselves', () => {
    const text = `${CLEAN_EDS}\n  ; indented\nstray\n[Vendor]\nX=${'y'.repeat(260)}\n`
    expect(rules(text)).toEqual([
      'warning leftmost-column 6401sub1',
      'warning not-key-value 6401sub1',
      'warning unknown-section Vendor',
      'warning line-length Vendor',
    ])
  })

  it('checks [DeviceComissioning] of a DCF', () => {
    const dcf = `${CLEAN_EDS}\n[DeviceComissioning]\nNodeID=200\nNodeName=pump ä\nBaudrate=1000\nNetNumber=1\nCANopenManager=2\n`
    expect(rules(dcf)).toEqual([
      'warning commissioning DeviceComissioning',
      'warning not-ascii DeviceComissioning',
      'warning commissioning DeviceComissioning',
      'warning commissioning-baudrate DeviceComissioning',
      'warning commissioning DeviceComissioning',
    ])
  })

  it('warns about [DeviceCommissioning] spelled the common way and checks it as the CiA 306 one', () => {
    const dcf = `${CLEAN_EDS}\n[DeviceCommissioning]\nNodeID=200\n`
    expect(rules(dcf)).toEqual([
      'warning commissioning DeviceCommissioning',
      'warning commissioning DeviceCommissioning',
    ])
  })

  it('warns about PDO mapping entries the file cannot back', () => {
    const missing = edit(CLEAN_EDS, '1A00sub1', 'DefaultValue', '0x60400010')
    expect(rules(missing)).toEqual(['warning mapping-entry 1A00sub1'])
    expect(check(missing).findings[0].message).toBe('maps 0x6040 sub 0, which the file does not describe')
    const length = edit(CLEAN_EDS, '1A00sub1', 'DefaultValue', '0x64010108')
    expect(check(length).findings.map((f) => f.message)).toEqual([
      'maps 8 bits of 0x6401 sub 1, which is INTEGER16 (16 bits)',
    ])
  })

  it('warns about a minus sign before 0x', () => {
    expect(rules(edit(CLEAN_EDS, '6401sub1', 'LowLimit', '-0x64'))).toEqual(['warning negative-hex 6401sub1'])
  })

  it('warns about a DCF without [DeviceComissioning]', () => {
    expect(checkEds(readEdsDocument(CLEAN_EDS), { format: 'dcf' }).findings.map((f) => f.rule)).toEqual([
      'commissioning',
    ])
  })

  it('warns that objects of extension modules are not read', () => {
    const modular = `${CLEAN_EDS}\n[SupportedModules]\nNrOfEntries=1\n1=1\n`
    expect(rules(modular)).toContain('warning modular-device SupportedModules')
    expect(check(modular).ok).toBe(true)
  })

  it('warns about a ParameterValue that changes a read-only object', () => {
    expect(rules(edit(CLEAN_EDS, '1000', 'ParameterValue', '0x192'))).toEqual(['warning value-on-read-only 1000'])
    expect(rules(edit(CLEAN_EDS, '1000', 'ParameterValue', '0x191'))).toEqual([])
  })

  const obj = (index: string, lines: string): string => `\n[${index}]\nParameterName=Object ${index}\n${lines}\n`
  it.each([
    ['dummy-usage', `${CLEAN_EDS}\n[DummyUsage]\nDummy0002=1\nFoo=1\nDummy0003=5\n`],
    ['compact-pdo', edit(CLEAN_EDS, 'DeviceInfo', 'CompactPDO', '300')],
    ['object-list', edit(CLEAN_EDS, 'OptionalObjects', 'SupportedObjects', null)],
    ['object-list', edit(CLEAN_EDS, 'OptionalObjects', '9', '0x1800')],
    ['obj-flags', edit(CLEAN_EDS, '6401sub1', 'ObjFlags', 'abc')],
    ['obj-flags', edit(CLEAN_EDS, '6401sub1', 'ObjFlags', '4')],
    ['parameter-name', edit(CLEAN_EDS, '1800sub5', 'ParameterName', null)],
    ['value-syntax', CLEAN_EDS + obj('2300', 'DataType=0x0008\nAccessType=rw\nDefaultValue=abc')],
    ['value-limits', CLEAN_EDS + obj('2300', 'DataType=0x0008\nAccessType=rw\nDefaultValue=5.0\nHighLimit=2.0')],
    ['value-limits', CLEAN_EDS + obj('2300', 'DataType=0x0008\nAccessType=rw\nDefaultValue=1.0\nLowLimit=2.0')],
    ['limit-syntax', CLEAN_EDS + obj('2300', 'DataType=0x0008\nAccessType=rw\nLowLimit=x')],
    ['limit-syntax', CLEAN_EDS + obj('2300', 'DataType=0x0009\nAccessType=rw\nLowLimit=1')],
    ['limit-syntax', CLEAN_EDS + obj('2300', 'DataType=0x0006\nAccessType=rw\nLowLimit=x')],
    ['access-type', CLEAN_EDS + obj('2300', 'DataType=0x0006')],
    ['sub-object', `${CLEAN_EDS}\n[2302sub1]\nParameterName=x\nDataType=0x0005\nAccessType=rw\n`],
    ['object-links', `${CLEAN_EDS}\n[6401ObjectLinks]\nObjectLinks=2\n1=0x1800\n`],
    ['compact-list', `${CLEAN_EDS}\n[2303Value]\nNrOfEntries=1\n1=1\n`],
    ['object-type', CLEAN_EDS + obj('2304', 'ObjectType=0x3')],
    ['object-type', CLEAN_EDS + obj('2305', 'ObjectType=0x7\nSubNumber=2\nDataType=0x0005\nAccessType=rw')],
    ['sub-object', `${CLEAN_EDS}\n[6401subFF]\nParameterName=x\nDataType=0x0005\nAccessType=rw\n`],
    ['sub-number', CLEAN_EDS + obj('2307', 'ObjectType=0x8')],
    ['comments', `${CLEAN_EDS}\n[Comments]\nLines=2\nLine1=x\n`],
    ['text-length', edit(CLEAN_EDS, 'DeviceInfo', 'ProductName', 'x'.repeat(250))],
    ['unknown-key', edit(CLEAN_EDS, 'FileInfo', 'Colour', 'blue')],
    ['duplicate-section', `${CLEAN_EDS}\n[6401sub1]\nPDOMapping=1\n`],
    ['unclosed-section', `${CLEAN_EDS}\n[Broken\n`],
  ])('finds %s', (rule, text) => {
    expect(check(text).findings.map((f) => f.rule)).toContain(rule)
  })

  it('accepts a DEFTYPE object with only its name', () => {
    expect(rules(CLEAN_EDS + obj('0020', 'ObjectType=0x2'))).not.toContainEqual(expect.stringMatching(/object-type/))
  })

  it('gives every rule a clause', () => {
    for (const [id, rule] of Object.entries(CIA306_RULES))
      expect(`${id} ${rule.clause}`).toMatch(/ (\d+(\.\d+)*|CiA 301)$/)
  })

  it('knows the CiA 301 types of the communication objects', () => {
    expect(commDataType(0x1017, 0)).toBe(0x0006)
    expect(commDataType(0x1801, 5)).toBe(0x0006)
    expect(commDataType(0x1601, 3)).toBe(0x0007)
    expect(commDataType(0x1016, 0)).toBe(0x0005)
    expect(commDataType(0x6000, 0)).toBeUndefined()
  })
})
