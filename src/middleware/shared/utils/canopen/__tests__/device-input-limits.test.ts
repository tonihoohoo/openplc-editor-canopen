import { MAX_DEVICE_FILE_BYTES, MAX_SUB_OBJECTS } from '../data-types'
import { prepareDeviceFile } from '../device-import'
import { writeEds } from '../device-writer'
import { checkEds } from '../eds-check'
import { readEdsDocument } from '../eds-document'
import { parseEds } from '../eds-parser'
import { canopenNameProblems } from '../plc-names'
import { buildSlaveExport, defaultCanopenSlaveConfig } from '../slave'
import { checkXdd } from '../xdd-check'
import { canopenDevice, configWith, genericIoEds, genericNode, GENERIC_IO_EDS } from './fixtures/helpers'

const wrap = (objects: string): string =>
  `<?xml version="1.0"?>
<ISO15745ProfileContainer xmlns="http://www.canopen.org/xml/2.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<ISO15745Profile><ProfileBody xsi:type="ProfileBody_CommunicationNetwork_CANopen"><ApplicationLayers><CANopenObjectList>${objects}
</CANopenObjectList></ApplicationLayers></ProfileBody></ISO15745Profile></ISO15745ProfileContainer>`

describe('device files that must not freeze the editor', () => {
  it('cuts CompactSubObj to 255 sub-objects and warns about it', () => {
    const text = `${GENERIC_IO_EDS}\n[2F00]\nParameterName=Big\nObjectType=0x8\nCompactSubObj=1000000000\nDataType=0x0005\nAccessType=ro\nPDOMapping=0\n`
    const started = Date.now()
    const eds = parseEds(text, 'big.eds')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(eds.objects.filter((o) => o.index === 0x2f00).length).toBeLessThanOrEqual(MAX_SUB_OBJECTS + 1)
    const check = checkEds(readEdsDocument(text), { encoding: 'utf-8', format: 'eds' })
    expect(
      check.findings.some((f) => f.rule === 'compact-sub-obj' && /CompactSubObj is 1000000000/.test(f.message)),
    ).toBe(true)
  })

  it('escapes the index and sub-index text in the XDD check', () => {
    const started = Date.now()
    const evil = wrap(
      `<CANopenObject index="(a+)+" objectType="7"/><CANopenObject index="${'a'.repeat(40)}!" objectType="7"/>` +
        `<CANopenObject index="(" objectType="8"><CANopenSubObject subIndex="[" dataType="0005"/></CANopenObject>`,
    )
    const result = checkXdd(evil)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.findings.some((f) => /not a hexadecimal index/.test(f.message))).toBe(true)
  })

  it('refuses a device file above the size limit', async () => {
    await expect(prepareDeviceFile('big.eds', new Uint8Array(MAX_DEVICE_FILE_BYTES + 1))).rejects.toThrow(
      /at most 8 MiB/,
    )
  })
})

describe('values written to EDS and DCF files', () => {
  it('keeps line breaks out of defaults and limits', () => {
    const eds = genericIoEds()
    const object = { ...(eds.objects.find((o) => o.index >= 0x2000) ?? eds.objects[0]) }
    object.defaultValue = '1\r\n[Injected]\r\nKey=2'
    const text = writeEds(
      { ...eds, objects: [...eds.objects.filter((o) => o !== eds.objects[0]), object] },
      { fileName: 'x.eds', now: new Date('2026-11-07T00:00:00Z') },
    )
    expect(text).toContain('Injected')
    expect(text).not.toMatch(/^\[Injected\]/m)
  })

  it('keeps a slave device name with a line break on one line in the export', () => {
    const slave = {
      ...defaultCanopenSlaveConfig('io'),
      deviceName: 'a\r\n[Injected]',
      softwareVersion: '1\n[Injected2]',
    }
    const exported = buildSlaveExport('io', slave, 'eds', new Date('2026-11-07T00:00:00Z'))
    expect(exported.text).toContain('Injected')
    expect(exported.text).not.toMatch(/^\[Injected/m)
  })
})

describe('node names', () => {
  it.each(['INT', 'bool', 'If', 'END_VAR'])('refuses %s as a node name', (name) => {
    const device = canopenDevice('line_1', configWith({ ...genericNode(2), name }))
    expect(canopenNameProblems([device], []).join('\n')).toMatch(/Structured Text word/)
  })
})
