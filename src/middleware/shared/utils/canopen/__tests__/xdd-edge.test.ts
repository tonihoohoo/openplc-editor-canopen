import { accessFits } from '../data-types'
import { writeXdd } from '../device-writer'
import { bitrateOf, parseXdd, xdcToDcfContent } from '../xdd-parser'

const DEVICE = `<ISO15745Profile><ProfileHeader/><ProfileBody xsi:type="ProfileBody_Device_CANopen" fileVersion="7" fileCreationDate="2026-01-02" supportedLanguages="en fi">
<DeviceIdentity><vendorName>Example</vendorName><vendorID>ABC</vendorID><productName>Odd module</productName><productID>0x12</productID><productText>Plain text</productText></DeviceIdentity>
<DeviceFunction><capabilities><characteristicsList>
<characteristic><characteristicName><label lang="en">Weight</label></characteristicName><characteristicContent><label lang="en">1 kg</label></characteristicContent><characteristicContent><label lang="en"> </label></characteristicContent></characteristic>
<characteristic><characteristicName><label lang="en"></label></characteristicName><characteristicContent><label lang="en">x</label></characteristicContent></characteristic>
</characteristicsList></capabilities></DeviceFunction>
<ApplicationProcess>
<dataTypeList>
<enum><enumValue><label lang="en">lost</label></enumValue></enum>
<enum uniqueID="E1"><enumValue name="Off"/><enumValue value="5"><label lang="fi">Viisi</label><label lang="en">Five</label></enumValue></enum>
<struct><varDeclaration name="a"><BOOL/></varDeclaration></struct>
<struct uniqueID="S1"><varDeclaration name="Ready"><BOOL/></varDeclaration><varDeclaration name="Pad"><BYTE/></varDeclaration><varDeclaration name="Mode" size="3"><BITSTRING/></varDeclaration><varDeclaration><BOOL/></varDeclaration><varDeclaration name="Big"><UDINT/></varDeclaration></struct>
</dataTypeList>
<parameterGroupList><parameterGroup uniqueID="G_TOP"><parameterRef uniqueIDRef="P_ENUM"/><parameterGroup><label lang="en">Inner</label><parameterRef uniqueIDRef="P_BITS"/><parameterRef/></parameterGroup></parameterGroup></parameterGroupList>
<parameterList>
<parameter access="read"><label lang="en">No id</label><UINT/></parameter>
<parameter uniqueID="P_ENUM" access="readWrite" multiplier="0.5" offset="10"><label lang="en"/><USINT/><dataTypeIDRef uniqueIDRef="E1"/><defaultValue value="5"/></parameter>
<parameter uniqueID="P_BITS" access="readWriteOutput"><dataTypeIDRef uniqueIDRef="S1"/><UDINT/><actualValue value="3"/></parameter>
<parameter uniqueID="P_RANGE"><description lang="en">Shared text</description><unit multiplier="1"><label lang="en">mm</label></unit><allowedValues><value value="1"/><range><minValue value="0"/></range></allowedValues><INT/></parameter>
<parameter uniqueID="P_BLANK"><label lang="en">   </label><UINT/></parameter>
</parameterList>
</ApplicationProcess></ProfileBody></ISO15745Profile>`

const NETWORK = (
  objects: string,
  nm = '',
) => `<ISO15745Profile><ProfileHeader/><ProfileBody xsi:type="ProfileBody_CommunicationNetwork_CANopen" fileModificationDate="2026-03-04">
<ApplicationLayers><CANopenObjectList>${objects}</CANopenObjectList></ApplicationLayers>
<TransportLayers><PhysicalLayer><baudRate><supportedBaudRate value="250 Kbps"/><supportedBaudRate value="1 Mbps"/><supportedBaudRate value="odd"/></baudRate></PhysicalLayer></TransportLayers>
<NetworkManagement>${nm}</NetworkManagement></ProfileBody></ISO15745Profile>`

const OBJECTS = `
<CANopenObject name="no index" dataType="0007"/>
<CANopenObject index="1400" objectType="9" name="RPDO"><CANopenSubObject subIndex="00" dataType="0005" name="n" defaultValue="2"/><CANopenSubObject subIndex="01" dataType="0007" name="id"/></CANopenObject>
<CANopenObject index="1800" objectType="9" name="TPDO"><CANopenSubObject subIndex="00" dataType="0005" name="n"/></CANopenObject>
<CANopenObject index="2000" name="Mode" uniqueIDRef="P_ENUM"/>
<CANopenObject index="2001" uniqueIDRef="P_BITS" accessType="bogus" PDOmapping="TPDO"/>
<CANopenObject index="2002" name="no type"/>
<CANopenObject index="2003" objectType="5" name="def type"/>
<CANopenObject index="2004" objectType="8" name="Array" uniqueIDRef="P_RANGE"><CANopenSubObject subIndex="00" dataType="0005" name="count" defaultValue=""/><CANopenSubObject subIndex="01" dataType="0003" name="first" lowLimit="-5"/><CANopenSubObject subIndex="zz" dataType="0003" name="bad"/><CANopenSubObject subIndex="02" name="untyped"/></CANopenObject>
<CANopenObject index="2005" objectType="7" name="Blank" uniqueIDRef="P_BLANK" denotation=""/>
<CANopenObject index="2006" name="Range" uniqueIDRef="P_RANGE"/>
<CANopenObject index="1018" objectType="9" name="Identity"><CANopenSubObject subIndex="00" dataType="0005" name="n"/></CANopenObject>`

const xdd = (objects = OBJECTS, nm = '') =>
  `<?xml version="1.0"?><ISO15745ProfileContainer xmlns="http://www.canopen.org/xml/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${DEVICE}${NETWORK(objects, nm)}</ISO15745ProfileContainer>`

describe('XDD reader edge cases', () => {
  const { eds, xdc } = parseXdd(xdd(), 'odd.xdd')
  const find = (index: number, sub = 0) => eds.objects.find((o) => o.index === index && o.subIndex === sub)

  it('reads the identity from the device body when the object list lacks it', () => {
    expect(eds.vendorId).toBe(0xabc)
    expect(eds.productCode).toBe(0x12)
    expect(eds.revision).toBe(0)
    expect(eds.deviceType).toBe(0)
    expect(eds.rxPdoCount).toBe(1)
    expect(eds.txPdoCount).toBe(1)
    expect(eds.unsupportedBitrates).toEqual([10000, 20000, 50000, 125000, 500000, 800000])
    expect(eds.details).toEqual({
      productText: 'Plain text',
      fileVersion: '7',
      fileCreationDate: '2026-01-02',
      fileModificationDate: '2026-03-04',
      languages: ['en', 'fi'],
      characteristics: [{ value: 'Weight', label: '1 kg' }],
    })
  })

  it('takes types, access and texts from the parameters', () => {
    expect(find(0x2000)).toMatchObject({ dataType: 'UNSIGNED8', access: 'rw', defaultValue: '5' })
    expect(find(0x2000)?.info).toEqual({
      multiplier: 0.5,
      offset: 10,
      group: 'G_TOP',
      values: [
        { value: '0', label: 'Off' },
        { value: '5', label: 'Five' },
      ],
    })
    expect(find(0x2001)).toMatchObject({ dataType: 'UNSIGNED32', access: 'rwr', pdoMapping: true, name: '' })
    expect(find(0x2001)?.info?.bits).toEqual([
      { value: '0', label: 'Ready' },
      { value: '9', label: 'Mode', width: 3 },
    ])
    expect(find(0x2001)?.info?.group).toBe('G_TOP')
    expect(find(0x2005)?.info).toBeUndefined()
  })

  it('skips what it cannot place and passes the parent text to sub-objects', () => {
    expect(find(0x2002)).toBeUndefined()
    expect(find(0x2003)).toBeUndefined()
    expect(find(0x2004, 2)).toBeUndefined()
    expect(find(0x2004)?.defaultValue).toBeUndefined()
    expect(find(0x2004)?.info?.description).toBeUndefined()
    expect(find(0x2004, 1)).toMatchObject({ lowLimit: '-5', parentName: 'Array' })
    expect(find(0x2004, 1)?.info).toEqual({ description: 'Shared text', unit: 'mm' })
    expect(find(0x2006)).toMatchObject({ dataType: 'INTEGER16', lowLimit: '0' })
    expect(find(0x2006)?.info).toEqual({ description: 'Shared text', unit: 'mm', min: '0' })
    expect(xdc.actualValues.get('0x2001:00')).toBe('3')
    expect(xdc.denotations.size).toBe(0)
  })

  it('reads the commissioning and turns it into DCF settings', () => {
    const none = xdcToDcfContent(xdc)
    expect(none.commissioning).toBeUndefined()
    const read = parseXdd(
      xdd(OBJECTS, '<deviceCommissioning nodeID="200" nodeName="" actualBaudRate="125" networkName="line"/>'),
      'x.xdc',
    ).xdc
    expect(read).toMatchObject({ bitrate: 125000, networkName: 'line' })
    expect(read.nodeId).toBeUndefined()
    expect(xdcToDcfContent(read).commissioning).toEqual({
      nodeId: undefined,
      nodeName: undefined,
      baudrateKbit: 125,
      networkName: 'line',
    })
  })

  it('reads bit rates in every spelling', () => {
    expect(bitrateOf('250')).toBe(250000)
    expect(bitrateOf('1 Mbps')).toBe(1000000)
    expect(bitrateOf('50 Kbps')).toBe(50000)
    expect(bitrateOf('9600 bps')).toBe(9600)
    expect(bitrateOf('fast')).toBeUndefined()
  })

  it('refuses files it cannot read', () => {
    expect(() => parseXdd('<a/>', 'x.xdd')).toThrow('not a CANopen XDD')
    expect(() => parseXdd('<!-- ISO15745ProfileContainer --><a/>', 'x.xdd')).toThrow('no ISO15745ProfileContainer')
    expect(() => parseXdd('<ISO15745ProfileContainer><b></ISO15745ProfileContainer>', 'x.xdd')).toThrow(
      'the XML is broken at line 1',
    )
    expect(() => parseXdd(`<ISO15745ProfileContainer>${DEVICE}</ISO15745ProfileContainer>`, 'x.xdd')).toThrow(
      'no CANopen communication network profile',
    )
  })
})

describe('PDO direction of a read-write XDD object', () => {
  const objects = `
<CANopenObject index="2100" name="To master" dataType="0006" accessType="rw" PDOmapping="TPDO"/>
<CANopenObject index="2101" name="From master" dataType="0006" accessType="rw" PDOmapping="RPDO"/>
<CANopenObject index="2102" name="Either" dataType="0006" accessType="rw" PDOmapping="optional"/>
<CANopenObject index="2103" name="Status" dataType="0006" accessType="ro" PDOmapping="TPDO"/>`
  const { eds } = parseXdd(xdd(objects), 'dir.xdd')
  const access = (e: typeof eds, index: number) => e.objects.find((o) => o.index === index)?.access

  it('offers a TPDO-only object for inputs and an RPDO-only object for outputs only', () => {
    expect(access(eds, 0x2100)).toBe('rwr')
    expect(access(eds, 0x2101)).toBe('rww')
    expect(access(eds, 0x2102)).toBe('rw')
    expect(access(eds, 0x2103)).toBe('ro')
    expect(accessFits('rwr', 'input')).toBe(true)
    expect(accessFits('rwr', 'output')).toBe(false)
    expect(accessFits('rww', 'output')).toBe(true)
    expect(accessFits('rww', 'input')).toBe(false)
  })

  it('keeps the direction through an XDD export', () => {
    const text = writeXdd(eds, { fileName: 'dir.xdd', now: new Date(2026, 0, 2) })
    expect(text).toMatch(/index="2100"[^>]*PDOmapping="TPDO"/)
    expect(text).toMatch(/index="2101"[^>]*PDOmapping="RPDO"/)
    const back = parseXdd(text, 'dir.xdd').eds
    for (const index of [0x2100, 0x2101, 0x2102, 0x2103]) expect(access(back, index)).toBe(access(eds, index))
  })
})
