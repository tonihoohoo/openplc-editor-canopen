import type { CanopenSlaveConfig, CanopenSlaveObject } from '../../../ports/canopen-types'
import { prepareDeviceFile } from '../device-import'
import { buildSlaveExport, checkCanopenSlave, defaultCanopenSlaveConfig, slavePdoLayout } from '../slave'
import { importIntoSlave, type SlaveImportFile } from '../slave-import'

const obj = (over: Partial<CanopenSlaveObject> & Pick<CanopenSlaveObject, 'id'>): CanopenSlaveObject => ({
  index: 0x2000,
  subIndex: 1,
  name: over.id,
  dataType: 'INTEGER16',
  direction: 'from_master',
  exchange: 'pdo',
  iecLocation: '%IW0',
  defaultValue: '0',
  ...over,
})

const slave = (): CanopenSlaveConfig => ({
  ...defaultCanopenSlaveConfig('tank-io'),
  vendorName: 'Example',
  softwareVersion: '1.2',
  hardwareVersion: 'rev B',
  vendorId: 0x1234,
  productCode: 7,
  revision: 0x00020001,
  heartbeatMs: 500,
  masterWatch: { nodeId: 1, timeMs: 300 },
  onMasterLost: 'stopped',
  onPlcStopState: 'pre_operational',
  productText: 'Tank controller',
  orderNumber: 'TC-100',
  characteristics: [{ value: 'Supply', label: '24 V DC' }],
  lss: { enabled: true, waitForMaster: false, serial: 42, bitrateChange: true },
  objects: [
    obj({ id: 'set', name: 'Setpoint', defaultValue: '100', min: '0', max: '1000', unit: '°C', multiplier: 0.1 }),
    obj({
      id: 'mode',
      name: 'Mode',
      subIndex: 2,
      dataType: 'UNSIGNED8',
      iecLocation: '%IB2',
      values: [
        { value: '0', label: 'Off' },
        { value: '1', label: 'On' },
      ],
      description: 'Operating mode.',
      group: 'Operation',
    }),
    obj({ id: 'cfg', name: 'Config', subIndex: 3, exchange: 'sdo', iecLocation: '%IW3' }),
    obj({ id: 'free', name: 'Free', subIndex: 4, iecLocation: '%IW4', mappedByMaster: true }),
    obj({
      id: 'temp',
      name: 'Temperature',
      index: 0x2100,
      direction: 'to_master',
      iecLocation: '%QW0',
      defaultValue: '20',
    }),
    obj({
      id: 'alarms',
      name: 'Alarms',
      index: 0x2100,
      subIndex: 2,
      dataType: 'UNSIGNED8',
      direction: 'to_master',
      iecLocation: '',
      bits: Array.from({ length: 8 }, (_, i) => ({ name: `Alarm ${i}`, iecLocation: `%QX2.${i}` })),
    }),
    obj({
      id: 'serialText',
      name: 'Label',
      index: 0x2100,
      subIndex: 3,
      dataType: 'VISIBLE_STRING',
      direction: 'to_master',
      exchange: 'constant',
      iecLocation: '',
      defaultValue: 'tank 1',
    }),
    obj({
      id: 'fast',
      name: 'Fast',
      index: 0x2100,
      subIndex: 4,
      dataType: 'INTEGER32',
      direction: 'to_master',
      iecLocation: '%QD1',
    }),
  ],
  pdos: {
    rpdos: [
      { number: 1, objects: ['set', 'mode'], cobId: null, transmissionType: 255, inhibitTime: 0, eventTimerMs: 250 },
    ],
    tpdos: [
      {
        number: 1,
        objects: ['temp', 'alarms'],
        cobId: null,
        transmissionType: 254,
        inhibitTime: 10,
        eventTimerMs: 1000,
      },
      { number: 5, objects: ['fast'], cobId: 0x6a1, transmissionType: 1, inhibitTime: 0, eventTimerMs: 0 },
    ],
  },
})

let counter = 0
const newId = (): string => `id${++counter}`

async function fileOf(name: string, text: string): Promise<SlaveImportFile> {
  const prepared = await prepareDeviceFile(name, new TextEncoder().encode(text))
  if (!prepared.eds) throw new Error(`not readable: ${JSON.stringify(prepared.check.findings.slice(0, 3))}`)
  return { eds: prepared.eds, dcf: prepared.dcf }
}

const essence = (c: CanopenSlaveConfig) => {
  const layout = slavePdoLayout(c)
  const ref = (id: string) => {
    const o = c.objects.find((x) => x.id === id)
    return o ? `${o.index.toString(16)}:${o.subIndex}` : id
  }
  return {
    objects: c.objects.map(({ id: _id, iecLocation: _loc, alias: _alias, bits, ...rest }) => ({
      ...rest,
      bits: bits?.map((b) => b.name),
    })),
    rpdos: layout.rpdos.map((p) => ({ ...p, objects: p.objects.map((o) => ref(o.id)) })),
    tpdos: layout.tpdos.map((p) => ({ ...p, objects: p.objects.map((o) => ref(o.id)) })),
  }
}

describe('importIntoSlave', () => {
  it('gives back the slave from its own XDD', async () => {
    const original = slave()
    const exported = buildSlaveExport('tank-io', original, 'xdd', new Date('2026-11-06T12:00:00Z'))
    expect(exported.errors).toEqual([])
    const file = await fileOf(exported.fileName, exported.text)
    const result = importIntoSlave(defaultCanopenSlaveConfig('other'), file, 'replace', { newId })
    const c = result.config
    expect(c).toMatchObject({
      vendorName: 'Example',
      deviceName: 'tank-io',
      softwareVersion: '1.2',
      hardwareVersion: 'rev B',
      vendorId: 0x1234,
      productCode: 7,
      revision: 0x00020001,
      heartbeatMs: 500,
      masterWatch: { nodeId: 1, timeMs: 300 },
      onMasterLost: 'stopped',
      onPlcStopState: 'pre_operational',
      productText: 'Tank controller',
      orderNumber: 'TC-100',
      lss: { enabled: true, waitForMaster: false, serial: 42, bitrateChange: true },
    })
    expect(c.characteristics).toEqual(expect.arrayContaining([{ value: 'Supply', label: '24 V DC' }]))
    expect(essence(c)).toEqual(essence(original))
    expect(c.objects.every((o) => o.iecLocation === '' && o.alias === undefined)).toBe(true)
    expect(result.notImported).toEqual([])
    expect(result.summary).toBe('8 objects, 1 RPDO and 2 TPDOs in the default layout')
  })

  it('gives back objects and layout from its own EDS, without the XDD details', async () => {
    const original = slave()
    const exported = buildSlaveExport('tank-io', original, 'eds', new Date('2026-11-06T12:00:00Z'))
    const file = await fileOf(exported.fileName, exported.text)
    const c = importIntoSlave(defaultCanopenSlaveConfig('other'), file, 'replace', { newId }).config
    const plain = essence(original)
    const strip = ({
      unit: _u,
      multiplier: _m,
      values: _v,
      description: _d,
      group: _g,
      bits: _b,
      ...rest
    }: (typeof plain.objects)[number]) => rest
    expect(essence(c).objects.map(strip)).toEqual(plain.objects.map(strip))
    expect(essence(c).tpdos).toEqual(plain.tpdos)
    expect(c.objects.find((o) => o.name === 'Alarms')?.bits).toBeUndefined()
  })

  it('keeps what no file holds', async () => {
    const exported = buildSlaveExport('tank-io', slave(), 'xdd', new Date('2026-11-06T12:00:00Z'))
    const file = await fileOf(exported.fileName, exported.text)
    const current = {
      ...defaultCanopenSlaveConfig(),
      interface: 'can1',
      priority: 70,
      onPlcStop: 'zero' as const,
      startAlone: true,
    }
    expect(importIntoSlave(current, file, 'replace', { newId }).config).toMatchObject({
      interface: 'can1',
      priority: 70,
      onPlcStop: 'zero',
      startAlone: true,
    })
  })

  it('lists profile objects and unsupported types of a device file', async () => {
    const eds = edsWith(
      [
        objectSection('2000', 'Speed', '0x0003', 'rw', '10', 1),
        objectSection('2001', 'Flag', '0x0001', 'rw', '0', 0),
        objectSection('2002', 'Blob', '0x000F', 'rw', '', 0),
        objectSection('2003', 'Status', '0x0006', 'ro', '0', 1),
        ...[0x6000, 0x6100, 0x6200, 0x6300, 0x6401, 0x6402, 0x6410, 0x6411].map((i) =>
          objectSection(i.toString(16), `Profile ${i.toString(16)}`, '0x0005', 'ro', '0', 1),
        ),
      ],
      ['1A00=0x20030110'],
    )
    const result = importIntoSlave(defaultCanopenSlaveConfig(), await fileOf('device.eds', eds), 'replace', { newId })
    expect(result.config.objects.map((o) => [o.name, o.direction, o.exchange])).toEqual([
      ['Speed', 'from_master', 'pdo'],
      ['Status', 'to_master', 'pdo'],
    ])
    expect(result.config.objects[0].mappedByMaster).toBe(true)
    expect(slavePdoLayout(result.config).tpdos[0].objects.map((o) => o.name)).toEqual(['Status'])
    const outside = result.notImported.filter((l) => l.group === 'outside')
    expect(outside).toHaveLength(8)
    expect(outside[0]).toEqual({ group: 'outside', what: '0x6000:00 Profile 6000', detail: 'device profile object' })
    expect(result.notImported.filter((l) => l.group === 'type').map((l) => l.detail)).toEqual([
      'BOOLEAN; an UNSIGNED8 of 8 bits holds BOOLs',
      'DOMAIN',
    ])
    expect(result.summary).toBe('2 objects, 0 RPDOs and 1 TPDO in the default layout')
  })

  it('takes node ID, bit rate and values from a DCF', async () => {
    const dcf = edsWith(
      [objectSection('2000', 'Speed', '0x0006', 'rw', '10', 0, '250')],
      [],
      ['[DeviceComissioning]', 'NodeID=12', 'Baudrate=250'],
    )
    const c = importIntoSlave(defaultCanopenSlaveConfig(), await fileOf('device.dcf', dcf), 'replace', { newId }).config
    expect(c.nodeId).toBe(12)
    expect(c.bitrate).toBe(250000)
    expect(c.objects[0]).toMatchObject({ name: 'Speed', exchange: 'sdo', defaultValue: '250' })
  })

  it('adds only free objects in add mode and leaves the settings', async () => {
    const eds = edsWith(
      [objectSection('2000', 'Taken', '0x0003', 'rw', '0', 1), objectSection('2200', 'New', '0x0003', 'ro', '5', 1)],
      [],
    )
    const current: CanopenSlaveConfig = {
      ...defaultCanopenSlaveConfig('mine'),
      nodeId: 9,
      objects: [obj({ id: 'mine', name: 'Mine' })],
    }
    const result = importIntoSlave(current, await fileOf('device.eds', eds), 'add', { newId })
    expect(result.candidates.map((c) => [c.ref, c.blocked])).toEqual([
      ['0x2000:01', 'used by "Mine"'],
      ['0x2200:01', null],
    ])
    expect(result.config.objects.map((o) => o.name)).toEqual(['Mine', 'New'])
    expect(result.config.nodeId).toBe(9)
    expect(result.config.deviceName).toBe('mine')
    const none = importIntoSlave(current, await fileOf('device.eds', eds), 'add', { newId, picked: new Set() })
    expect(none.config.objects.map((o) => o.name)).toEqual(['Mine'])
  })

  it('makes a config with no problems apart from addresses', async () => {
    const exported = buildSlaveExport('tank-io', slave(), 'xdd', new Date('2026-11-06T12:00:00Z'))
    const c = importIntoSlave(defaultCanopenSlaveConfig(), await fileOf(exported.fileName, exported.text), 'replace', {
      newId,
    }).config
    expect(checkCanopenSlave('s', c, []).filter((p) => !p.text.includes('no address'))).toEqual([])
  })

  it('lists PDO entries it cannot take', async () => {
    const eds = edsWith(
      [objectSection('2000', 'A', '0x0007', 'ro', '0', 1), objectSection('2001', 'B', '0x0007', 'ro', '0', 1)],
      ['1A00=0x20000120', '1A00=0x20010120', '1A00=0x60000108'],
      [],
      [
        '[1A10]',
        'ParameterName=TPDO 17 mapping',
        'ObjectType=0x7',
        'DataType=0x0005',
        'AccessType=rw',
        'DefaultValue=1',
        'PDOMapping=0',
      ],
    )
    const result = importIntoSlave(defaultCanopenSlaveConfig(), await fileOf('device.eds', eds), 'replace', { newId })
    expect(result.notImported.filter((l) => l.group === 'pdo').map((l) => `${l.what}: ${l.detail}`)).toEqual([
      'TPDO 1 entry 3: 0x6000:01: its object is not imported',
      'TPDO 17: the slave has 16 TPDOs',
    ])
  })
})

/** A minimal EDS: identity, 0x1018, the given objects and TPDO 1 with the given mapping. */
function edsWith(objects: string[][], tpdo1: string[], extra: string[] = [], tail: string[] = []): string {
  const mapping = tpdo1.map((m) => m.split('=')[1])
  const names = objects.map((o) => o[0].slice(1, -1))
  const optional = ['1017', '1800', '1A00', ...(tail.length > 0 ? ['1A10'] : [])]
  return [
    '[FileInfo]',
    'FileName=device.eds',
    'FileVersion=1',
    'FileRevision=0',
    'EDSVersion=4.0',
    'Description=Test device',
    '[DeviceInfo]',
    'VendorName=Test',
    'VendorNumber=0x5',
    'ProductName=Test device',
    'ProductNumber=0x6',
    'RevisionNumber=0x7',
    'BaudRate_500=1',
    'SimpleBootUpSlave=1',
    'Granularity=8',
    'NrOfRXPDO=0',
    'NrOfTXPDO=1',
    'LSS_Supported=0',
    '[MandatoryObjects]',
    'SupportedObjects=3',
    '1=0x1000',
    '2=0x1001',
    '3=0x1018',
    '[OptionalObjects]',
    `SupportedObjects=${optional.length}`,
    ...optional.map((o, i) => `${i + 1}=0x${o}`),
    '[ManufacturerObjects]',
    `SupportedObjects=${names.length}`,
    ...names.map((n, i) => `${i + 1}=0x${n}`),
    ...section('1000', 'Device type', '0x0007', 'ro', '0'),
    ...section('1001', 'Error register', '0x0005', 'ro', '0'),
    ...section('1017', 'Producer heartbeat time', '0x0006', 'rw', '0'),
    '[1018]',
    'ParameterName=Identity object',
    'ObjectType=0x9',
    'SubNumber=2',
    ...sub('1018', 0, 'Highest sub-index supported', '0x0005', 'const', '1'),
    ...sub('1018', 1, 'Vendor-ID', '0x0007', 'ro', '0x5'),
    '[1800]',
    'ParameterName=TPDO 1 communication parameter',
    'ObjectType=0x9',
    'SubNumber=3',
    ...sub('1800', 0, 'Highest sub-index supported', '0x0005', 'const', '2'),
    ...sub('1800', 1, 'COB-ID', '0x0007', 'rw', '$NODEID+0x180'),
    ...sub('1800', 2, 'Transmission type', '0x0005', 'rw', '255'),
    '[1A00]',
    'ParameterName=TPDO 1 mapping parameter',
    'ObjectType=0x9',
    `SubNumber=${mapping.length + 1}`,
    ...sub('1A00', 0, 'Number of mapped objects', '0x0005', 'rw', String(mapping.length)),
    ...mapping.flatMap((m, i) => sub('1A00', i + 1, `Mapped object ${i + 1}`, '0x0007', 'rw', m)),
    ...objects.flat(),
    ...tail,
    ...extra,
  ].join('\n')
}

function section(index: string, name: string, type: string, access: string, value: string): string[] {
  return [
    `[${index}]`,
    `ParameterName=${name}`,
    'ObjectType=0x7',
    `DataType=${type}`,
    `AccessType=${access}`,
    `DefaultValue=${value}`,
    'PDOMapping=0',
  ]
}

function sub(index: string, s: number, name: string, type: string, access: string, value: string): string[] {
  return [
    `[${index}sub${s.toString(16)}]`,
    `ParameterName=${name}`,
    'ObjectType=0x7',
    `DataType=${type}`,
    `AccessType=${access}`,
    `DefaultValue=${value}`,
    'PDOMapping=0',
  ]
}

/** A record of one sub-index at `index`:01, or a simple variable for profile objects (`index` 0x6000+). */
function objectSection(
  index: string,
  name: string,
  type: string,
  access: string,
  value: string,
  pdo: number,
  parameterValue?: string,
): string[] {
  const head = `[${index.toUpperCase()}]`
  const tail = (lines: string[]) => [
    ...lines,
    ...(parameterValue !== undefined ? [`ParameterValue=${parameterValue}`] : []),
  ]
  if (parseInt(index, 16) >= 0x6000)
    return [
      head,
      `ParameterName=${name}`,
      'ObjectType=0x7',
      `DataType=${type}`,
      `AccessType=${access}`,
      `DefaultValue=${value}`,
      `PDOMapping=${pdo}`,
    ]
  return [
    head,
    `ParameterName=${name} record`,
    'ObjectType=0x9',
    'SubNumber=2',
    ...sub(index.toUpperCase(), 0, 'Highest sub-index supported', '0x0005', 'const', '1'),
    ...tail([
      `[${index.toUpperCase()}sub1]`,
      `ParameterName=${name}`,
      'ObjectType=0x7',
      `DataType=${type}`,
      `AccessType=${access}`,
      `DefaultValue=${value}`,
      `PDOMapping=${pdo}`,
    ]),
  ]
}
