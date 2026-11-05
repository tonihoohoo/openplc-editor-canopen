import { CanopenSlaveStatusSchema } from '../../../ports/canopen-status'
import type { CanopenSlaveBit, CanopenSlaveConfig, CanopenSlaveObject } from '../../../ports/canopen-types'
import type { PLCServer } from '../../../ports/types'
import { buildAddressPool } from '../../iec-address'
import { canopenSlavePoolDevices } from '../../iec-address/address-pool'
import { buildDbc } from '../dbc-export'
import { buildHtmlDocument, htmlSections } from '../html-export'
import { createCanopenNode, defaultCanopenConfig } from '../model'
import {
  buildSlaveExport,
  checkCanopenSlave,
  defaultCanopenSlaveConfig,
  isSlavePacked,
  newSlaveBits,
  slaveAddressText,
  slaveBitChannel,
  slaveBitsOn,
  slaveDevicesOut,
  slaveLayoutText,
  slavePdoLayout,
} from '../slave'
import { slavePackedValue } from '../slave-online'
import { addressNewSlaveObjects, nextFreeByte } from '../stable-addresses'
import { parseXdd } from '../xdd-parser'
import { sequentialAllocator } from './fixtures/helpers'
import { SLAVE_NOW, slaveStatus } from './fixtures/slave-status'

const bits = (prefix: string, byte: number, names?: string[]): CanopenSlaveBit[] =>
  Array.from({ length: 8 }, (_, i) => ({ name: names?.[i] ?? `Bit ${i}`, iecLocation: `${prefix}${byte}.${i}` }))

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

const VALVES = ['Valve 1', 'Valve 2', 'Valve 3', 'Valve 4', 'Bit 4', 'Bit 5', 'Bit 6', 'Bit 7']

const packed = (): CanopenSlaveConfig => ({
  ...defaultCanopenSlaveConfig('io_node'),
  objects: [
    obj({ id: 'set', name: 'Setpoint', iecLocation: '%IW0' }),
    obj({
      id: 'valves',
      subIndex: 2,
      name: 'Valves',
      dataType: 'UNSIGNED8',
      iecLocation: '',
      defaultValue: '129',
      bits: bits('%IX', 0, VALVES),
    }),
    obj({ id: 'echo', index: 0x2100, name: 'Echo', direction: 'to_master', iecLocation: '%QW0' }),
    obj({
      id: 'lamps',
      index: 0x2100,
      subIndex: 2,
      name: 'Lamps',
      dataType: 'UNSIGNED8',
      direction: 'to_master',
      iecLocation: '',
      bits: bits('%QX', 0),
    }),
  ],
})

const server = (config: CanopenSlaveConfig): PLCServer => ({
  name: 'io',
  protocol: 'canopen-slave',
  canopenSlaveConfig: config,
})

const texts = (config: CanopenSlaveConfig): string[] => checkCanopenSlave('io', config, []).map((p) => p.text)

const withObject = (config: CanopenSlaveConfig, id: string, update: Partial<CanopenSlaveObject>) => ({
  ...config,
  objects: config.objects.map((o) => (o.id === id ? { ...o, ...update } : o)),
})

describe('CANopen slave objects packed as 8 bits', () => {
  it('shows the bit addresses as one byte and names the bits that are on', () => {
    const valves = packed().objects[1]
    expect(isSlavePacked(valves)).toBe(true)
    expect(slaveAddressText(valves)).toBe('%IX0.0-0.7')
    expect(
      slaveAddressText({
        iecLocation: '',
        bits: [...bits('%IX', 0).slice(0, 7), { name: 'x', iecLocation: '%IX3.1' }],
      }),
    ).toBe('%IX0.0, %IX0.1, %IX0.2, %IX0.3, %IX0.4, %IX0.5, %IX0.6, %IX3.1')
    expect(slaveAddressText(packed().objects[0])).toBe('%IW0')
    expect(slaveBitsOn(valves, 5)).toEqual(['Valve 1', 'Valve 3'])
    expect(newSlaveBits().map((b) => b.name)).toEqual([
      'Bit 0',
      'Bit 1',
      'Bit 2',
      'Bit 3',
      'Bit 4',
      'Bit 5',
      'Bit 6',
      'Bit 7',
    ])
  })

  it('has no problems and takes one byte in a PDO', () => {
    expect(texts(packed())).toEqual([])
    const layout = slavePdoLayout(packed())
    expect(layout.rpdos[0].bytes).toBe(3)
    expect(layout.tpdos[0].bytes).toBe(3)
  })

  it('refuses a constant, a range, another type, missing bits and bad or shared bit addresses', () => {
    expect(texts(withObject(packed(), 'valves', { exchange: 'constant' }))).toContain(
      '0x2000:02 "Valves": an object of 8 bits cannot be a constant',
    )
    expect(texts(withObject(packed(), 'valves', { min: '1' }))).toContain(
      '0x2000:02 "Valves": an object of 8 bits has no range',
    )
    expect(texts(withObject(packed(), 'valves', { dataType: 'UNSIGNED16' }))).toContain(
      '0x2000:02 "Valves": only an UNSIGNED8 has 8 bits',
    )
    expect(texts(withObject(packed(), 'valves', { bits: bits('%IX', 0).slice(0, 7) }))).toContain(
      '0x2000:02 "Valves": it has 7 bits, not 8',
    )
    expect(texts(withObject(packed(), 'valves', { bits: bits('%QX', 4) }))).toContain(
      '0x2000:02 "Valves" bit 0: address %QX4.0 must be a %IX address',
    )
    const shared = bits('%IX', 0)
    shared[7] = { name: 'Bit 7', iecLocation: '%IX0.5' }
    expect(texts(withObject(packed(), 'valves', { bits: shared }))).toContain(
      '0x2000:02 "Valves" bit 7: address %IX0.5 is also used by "Valves bit 5"',
    )
    const named = bits('%IX', 0)
    named[1] = { name: 'bit 0', iecLocation: '%IX0.1' }
    expect(texts(withObject(packed(), 'valves', { bits: named }))).toContain(
      '0x2000:02 "Valves" bit 1: another bit is named "bit 0"',
    )
  })

  it('writes the bit locations and the default into conf/canopen.json, not a location', () => {
    const [device] = slaveDevicesOut([server(packed())]) as Array<{ objects: Array<Record<string, unknown>> }>
    expect(device.objects[1]).toEqual({
      index: 0x2000,
      subindex: 2,
      name: 'Valves',
      type: 'UNSIGNED8',
      direction: 'from_master',
      exchange: 'pdo',
      bits: ['%IX0.0', '%IX0.1', '%IX0.2', '%IX0.3', '%IX0.4', '%IX0.5', '%IX0.6', '%IX0.7'],
      default: 129,
    })
    expect(device.objects[0]).toHaveProperty('location', '%IW0')
  })

  it('claims one pool channel per bit, keyed by the row and the bit', () => {
    const [device] = canopenSlavePoolDevices([
      server(
        withObject(packed(), 'valves', {
          bits: bits('%IX', 0, ['a']).map((b, i) => (i === 2 ? { ...b, alias: 'valve_3' } : b)),
        }),
      ),
    ])
    const entries = device.canopenConfig?.nodes?.[0].tpdos?.[0].entries ?? []
    expect(entries.filter((e) => e.channelId.startsWith('valves')).map((e) => [e.channelId, e.iecLocation])).toEqual(
      Array.from({ length: 8 }, (_, i) => [slaveBitChannel('valves', i), `%IX0.${i}`]),
    )
    expect(entries.find((e) => e.alias === 'valve_3')?.iecLocation).toBe('%IX0.2')
  })

  it('frees the byte address and takes the first whole free bit byte when a row becomes 8 bits', () => {
    const prev: CanopenSlaveConfig = {
      ...defaultCanopenSlaveConfig('io_node'),
      objects: [
        obj({ id: 'mode', name: 'Mode', dataType: 'UNSIGNED8', iecLocation: '%IB0' }),
        obj({ id: 'other', subIndex: 2, name: 'Other', dataType: 'UNSIGNED8', iecLocation: '', bits: bits('%IX', 0) }),
      ],
    }
    const pool = buildAddressPool(
      { servers: [server(prev)], pinMapping: undefined },
      { pinMapping: false, vppIo: false, modbusTcpRemote: false, ethercat: true },
    )
    const next = withObject(prev, 'mode', { iecLocation: '', bits: newSlaveBits() })
    const placed = addressNewSlaveObjects(prev, next, pool)
    const mode = placed.objects[0]
    expect(mode.iecLocation).toBe('')
    expect(mode.bits?.map((b) => b.iecLocation)).toEqual(Array.from({ length: 8 }, (_, i) => `%IX1.${i}`))
    expect(placed.objects[1].bits?.[0].iecLocation).toBe('%IX0.0')

    const back = addressNewSlaveObjects(placed, withObject(placed, 'mode', { bits: undefined }), pool)
    expect(back.objects[0].iecLocation).toMatch(/^%IB\d+$/)
    expect(back.objects[0].bits).toBeUndefined()
  })

  it('keeps the bit addresses a project file gives and skips bytes with any bit taken', () => {
    const pool = buildAddressPool(
      {
        servers: [
          server({
            ...defaultCanopenSlaveConfig(),
            objects: [
              obj({
                id: 'x',
                dataType: 'UNSIGNED8',
                iecLocation: '',
                bits: [...bits('%IX', 0).slice(0, 7), { name: 'Bit 7', iecLocation: '%IX1.3' }],
              }),
            ],
          }),
        ],
      },
      { pinMapping: false, vppIo: false, modbusTcpRemote: false, ethercat: true },
    )
    expect(nextFreeByte(pool, '%IX', new Set())).toBe(2)
    expect(nextFreeByte(pool, '%IX', new Set(['%IX2.7']))).toBe(3)
    expect(nextFreeByte(pool, '%QX', new Set())).toBe(0)
    const given = packed()
    expect(addressNewSlaveObjects(undefined, given, pool).objects[1].bits).toEqual(given.objects[1].bits)
  })

  it('suggests a new revision when a bit is renamed', () => {
    const c = packed()
    const before = slaveLayoutText(c)
    expect(slaveLayoutText(withObject(c, 'valves', { bits: bits('%IX', 0) }))).not.toBe(before)
  })

  it('shows the reported byte as bits with the names of those on', () => {
    const valves = packed().objects[1]
    const status = CanopenSlaveStatusSchema.parse(
      slaveStatus(SLAVE_NOW, { values: [{ index: 0x2000, subindex: 2, data: '05' }] }),
    )
    expect(slavePackedValue(valves, status)).toEqual({
      on: [true, false, true, false, false, false, false, false],
      names: ['Valve 1', 'Valve 3'],
    })
    expect(slavePackedValue(packed().objects[0], status)).toBeNull()
    expect(slavePackedValue(valves, null)).toBeNull()
  })
})

describe('CANopen slave packed bits in the device files', () => {
  const now = new Date(2026, 10, 5, 9, 30)

  it('describes the object as UNSIGNED8 in the EDS', () => {
    const file = buildSlaveExport('io', packed(), 'eds', now)
    expect(file.errors).toEqual([])
    expect(file.text).toMatch(/\[2000sub2\]\r?\nParameterName=Valves\r?\nObjectType=0x7\r?\nDataType=0x0005/)
  })

  it('names the bits in the XDD, and a master that adds the XDD shows them in its DBC and HTML', () => {
    const file = buildSlaveExport('io', packed(), 'xdd', now)
    expect(file.errors).toEqual([])
    const eds = parseXdd(file.text, file.fileName).eds
    const valves = eds.objects.find((o) => o.index === 0x2000 && o.subIndex === 2)
    expect(valves?.dataType).toBe('UNSIGNED8')
    expect(valves?.info?.bits?.map((b) => b.label)).toEqual(VALVES)
    expect(eds.objects.find((o) => o.index === 0x2100 && o.subIndex === 2)?.info?.bits).toHaveLength(8)
    expect(eds.objects.find((o) => o.index === 0x2000 && o.subIndex === 1)?.info).toBeUndefined()

    let id = 0
    const node = createCanopenNode(eds, {
      id: 'n',
      name: 'io',
      nodeId: 5,
      newId: () => `e${id++}`,
      allocate: sequentialAllocator(),
    })
    const config = { ...defaultCanopenConfig(), nodes: [node] }
    const dbc = buildDbc(config, { networkName: 'canopen1' }).text
    expect(dbc).toContain('Valve_1')
    expect(dbc).toContain('Valve_3')
    const html = buildHtmlDocument({
      projectName: 'line',
      networkName: 'canopen1',
      config,
      uses: new Map(),
      sections: htmlSections(undefined),
      editorVersion: '1.0.0',
      now,
    })
    expect(html).toContain('Valve 3')
  })
})
