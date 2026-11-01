import { checkXdd, deviceFindingPlace, isCia311Finding } from '../xdd-check'
import { parseXdd } from '../xdd-parser'

const DEVICE = `<ISO15745Profile><ProfileBody xsi:type="ProfileBody_Device_CANopen">
<DeviceIdentity><vendorName>Example</vendorName></DeviceIdentity>
<ApplicationProcess><parameterList>
<parameter uniqueID="P1"><BITSTRING/><defaultValue value="zz"/></parameter>
<parameter uniqueID="P1"><UINT/></parameter>
<parameter uniqueID="P2"><REAL/><actualValue value="1.5"/></parameter>
<parameter uniqueID="P3"><dataTypeIDRef uniqueIDRef="T_MISSING"/><DINT/></parameter>
<parameter><UINT/></parameter>
</parameterList></ApplicationProcess></ProfileBody></ISO15745Profile>`
const OBJECTS = `
<CANopenObject index="xyz" objectType="7" dataType="0007"/>
<CANopenObject index="1000" objectType="7" dataType="0005" accessType="ro" defaultValue="0"/>
<CANopenObject index="1001" objectType="2" dataType="0005" accessType="ro"/>
<CANopenObject index="1001" objectType="7" dataType="0005" accessType="ro"/>
<CANopenObject index="1017" objectType="7" dataType="06" accessType="rww" PDOmapping="always" color="red"/>
<CANopenObject index="1018" objectType="9" subNumber="1" extra="1"/>
<CANopenObject index="1014" objectType="7" uniqueIDRef="P_GONE"/>
<CANopenObject index="1016" objectType="8" subNumber="5">
  <CANopenSubObject subIndex="00" dataType="0005" defaultValue="1"/>
  <CANopenSubObject subIndex="01" dataType="0007" defaultValue="0"/>
  <CANopenSubObject subIndex="02" dataType="0007" defaultValue="0"/>
  <CANopenSubObject subIndex="02" dataType="0007"/>
  <CANopenSubObject subIndex="1FF" dataType="0007"/>
</CANopenObject>
<CANopenObject index="1003" objectType="8"><CANopenSubObject subIndex="00" dataType="0005" defaultValue="0"/><CANopenSubObject subIndex="03" dataType="0007"/></CANopenObject>
<CANopenObject index="1A00" objectType="9"><CANopenSubObject subIndex="00" dataType="0005" defaultValue="3"/><CANopenSubObject subIndex="01" dataType="0007" defaultValue="0x20000108"/><CANopenSubObject subIndex="02" dataType="0007" defaultValue="0x20010010"/><CANopenSubObject subIndex="03" dataType="0007" defaultValue="0x00050008"/><CANopenSubObject subIndex="04" dataType="0007" defaultValue="$NODEID+1"/></CANopenObject>
<CANopenObject index="2000" objectType="7" dataType="0005" uniqueIDRef="P1" lowLimit="5" highLimit="x"/>
<CANopenObject index="2001" objectType="7" dataType="0007" uniqueIDRef="P1" defaultValue="300" highLimit="10"/>
<CANopenObject index="2002" objectType="7" dataType="0002" defaultValue="300"/>
<CANopenObject index="2003" objectType="7" dataType="0008" uniqueIDRef="P2" defaultValue="pi"/>
<CANopenObject index="2004" objectType="7" dataType="000A" defaultValue="XYZ"/>
<CANopenObject index="2005" objectType="7" dataType="0005" lowLimit="999"/>
<CANopenObject index="2006" objectType="7"/>
<CANopenObject index="2007" objectType="7" uniqueIDRef="P2"/>
<CANopenObject index="2008" objectType="4"/>
<CANopenObject index="2009" objectType="5"/>
<CANopenObject index="200A" objectType="7" dataType="0003" defaultValue="-5" lowLimit="0"/>
<CANopenObject index="200B" objectType="7" dataType="0005" defaultValue=""/>
<CANopenObject index="200C" objectType="7" dataType="0000"/>
<CANopenObject index="200D" objectType="7" dataType="0009" defaultValue="text" uniqueIDRef="P3"/>`
const NM = `<deviceCommissioning nodeID="0" actualBaudRate="300 Kbps"/>`
const MESSY = `<?xml version="1.0"?>
<ISO15745ProfileContainer xmlns="http://www.canopen.org/xml/2.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${DEVICE}
<ISO15745Profile><ProfileBody xsi:type="ProfileBody_CommunicationNetwork_CANopen"><ApplicationLayers><CANopenObjectList>${OBJECTS}
</CANopenObjectList></ApplicationLayers><NetworkManagement>${NM}</NetworkManagement></ProfileBody></ISO15745Profile></ISO15745ProfileContainer>`

describe('CiA 311 check of a messy file', () => {
  const result = checkXdd(MESSY, parseXdd(MESSY, 'messy.xdd').eds)
  const findings = result.findings.filter(isCia311Finding)
  const found = (rule: string, element?: string) =>
    findings.filter((f) => f.rule === rule && (element === undefined || f.element === element))

  it('blocks only on the communication objects', () => {
    expect(result.ok).toBe(false)
    expect(findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.element ?? ''}`)).toEqual([
      'comm-data-type 0x1000',
      'duplicate-object 0x1001',
      'data-type 0x1017',
      'access-type 0x1017',
      'data-type 0x1014',
      'sub-zero 0x1016',
      'duplicate-object 0x1016',
    ])
  })

  it('finds the file-level problems', () => {
    expect(found('namespace')[0].message).toContain('xml/2.0')
    expect(found('mandatory-objects')[0].message).toContain('0x1018')
    expect(found('duplicate-id')[0].line).toBe(5)
    expect(found('unique-id-ref').map((f) => f.message)).toEqual([
      'uniqueIDRef "T_MISSING" in the device profile names no element',
      expect.stringContaining('0x1014 refers to parameter "P_GONE"'),
    ])
    expect(found('commissioning')).toHaveLength(2)
  })

  it('finds the object problems with their places', () => {
    expect(found('object-type').map((f) => f.message)).toEqual([
      'index "xyz" is not a hexadecimal index',
      'a RECORD without sub-objects',
      'subIndex "1FF" is not a hexadecimal sub-index',
      'objectType "4" is not 2, 7, 8 or 9',
    ])
    expect(found('sub-zero')[0].message).toBe('sub-index 0 is 1, but sub-index 2 is described')
    expect(found('unknown-attribute').map((f) => f.element)).toEqual(['0x1017', '0x1018'])
    expect(found('pdo-mapping', '0x1017')).toHaveLength(1)
    expect(found('sub-number', '0x1018')).toHaveLength(1)
    expect(found('type-mismatch').map((f) => f.element)).toEqual(['0x2000', '0x2001', '0x200D'])
    expect(found('limit-syntax').map((f) => f.element)).toEqual(['0x2000', '0x2005'])
    expect(found('value-limits').map((f) => f.message)).toEqual([
      'defaultValue 300 is above highLimit 10',
      'defaultValue -5 is below lowLimit 0',
    ])
    expect(found('value-range', '0x2002')).toHaveLength(1)
    expect(found('value-syntax').map((f) => f.element)).toEqual(['0x2003', '0x2004'])
    expect(found('data-type').map((f) => f.element)).toEqual(['0x1017', '0x1014', '0x2006', '0x200C'])
    expect(found('mapping-entry').map((f) => f.element)).toEqual(['0x1A00 sub 1', '0x1A00 sub 2'])
    expect(deviceFindingPlace(found('namespace')[0])).toBe('file')
    expect(deviceFindingPlace(found('sub-zero')[0])).toBe('0x1016 line 19')
  })

  it('refuses a file without a network profile', () => {
    const r = checkXdd('<ISO15745ProfileContainer><ISO15745Profile/></ISO15745ProfileContainer>')
    expect(r.ok).toBe(false)
    expect(r.findings.map((f) => f.rule)).toEqual(['profile-container'])
  })
})
