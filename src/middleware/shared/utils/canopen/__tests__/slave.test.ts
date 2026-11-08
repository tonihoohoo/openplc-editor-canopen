import type { CanopenSlaveConfig, CanopenSlaveObject } from '../../../ports/canopen-types'
import type { PLCRemoteDevice, PLCServer } from '../../../ports/types'
import { buildAddressPool } from '../../iec-address'
import { startupSdoCandidates } from '../editing'
import { parseEds } from '../eds-parser'
import { generateCanopenConfig } from '../generate-canopen-config'
import { createCanopenNode, defaultCanopenConfig } from '../model'
import {
  buildSlaveExport,
  checkCanopenSlave,
  defaultCanopenSlaveConfig,
  nextSlaveObjectName,
  nextSlaveObjectPlace,
  parseSlaveValue,
  slaveDevicesOut,
  slavePdoLayout,
  suggestedSlaveRevision,
  slaveLayoutText,
  slaveLss,
  validateCanopenSlaves,
} from '../slave'
import { addressNewSlaveObjects } from '../stable-addresses'
import { parseXdd } from '../xdd-parser'

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

const io = (): CanopenSlaveConfig => ({
  ...defaultCanopenSlaveConfig('line-io'),
  objects: [
    obj({ id: 'set', name: 'Setpoint', iecLocation: '%IW0' }),
    obj({ id: 'mode', name: 'Mode', subIndex: 2, dataType: 'UNSIGNED8', iecLocation: '%IB2' }),
    obj({ id: 'flags', name: 'Flags', subIndex: 3, dataType: 'UNSIGNED8', iecLocation: '%IB3' }),
    obj({
      id: 'limit',
      name: 'Limit',
      subIndex: 4,
      dataType: 'UNSIGNED16',
      exchange: 'sdo',
      iecLocation: '%IW4',
      defaultValue: '1000',
      min: '100',
      max: '30000',
    }),
    obj({ id: 'act', name: 'Actual', index: 0x2100, direction: 'to_master', iecLocation: '%QW0' }),
    obj({
      id: 'cnt',
      name: 'Counter',
      index: 0x2100,
      subIndex: 2,
      dataType: 'UNSIGNED32',
      direction: 'to_master',
      iecLocation: '%QD0',
    }),
    obj({
      id: 'fw',
      name: 'Firmware',
      index: 0x2100,
      subIndex: 3,
      dataType: 'VISIBLE_STRING',
      direction: 'to_master',
      exchange: 'constant',
      iecLocation: '',
      defaultValue: '1.4.0',
    }),
  ],
})

const server = (config: CanopenSlaveConfig, name = 'io'): PLCServer => ({
  name,
  protocol: 'canopen-slave',
  canopenSlaveConfig: config,
})

describe('CANopen slave model', () => {
  it('starts with working defaults', () => {
    const c = defaultCanopenSlaveConfig('my-project')
    expect(c).toMatchObject({
      interface: 'can0',
      bitrate: 500000,
      nodeId: 5,
      deviceName: 'my-project',
      vendorId: 0,
      productCode: 1,
      revision: 0x00010000,
      heartbeatMs: 1000,
      masterWatch: { timeMs: 0 },
      onPlcStop: 'hold',
      startAlone: false,
      storeSettings: false,
      objects: [],
    })
    expect(c.pdos).toEqual({ rpdos: [], tpdos: [] })
    expect(checkCanopenSlave('io', c, [])).toEqual([])
  })

  it('places new objects in 0x2000 (from the master) and 0x2100 (to the master)', () => {
    const c = defaultCanopenSlaveConfig()
    expect(nextSlaveObjectPlace(c, 'from_master')).toEqual({ index: 0x2000, subIndex: 1 })
    expect(nextSlaveObjectPlace(c, 'to_master')).toEqual({ index: 0x2100, subIndex: 1 })
    expect(nextSlaveObjectPlace(io(), 'from_master')).toEqual({ index: 0x2000, subIndex: 5 })
    expect(nextSlaveObjectName(io(), 'Setpoint')).toBe('Setpoint_2')
    expect(nextSlaveObjectName(io(), 'Speed')).toBe('Speed')
  })

  it('packs the PDO rows in table order with pre-defined COB-IDs', () => {
    const layout = slavePdoLayout(io())
    expect(layout.rpdos.map((p) => [p.number, p.effectiveCobId, p.bytes, p.objects.map((o) => o.id)])).toEqual([
      [1, 0x205, 4, ['set', 'mode', 'flags']],
    ])
    expect(layout.tpdos.map((p) => [p.number, p.effectiveCobId, p.bytes])).toEqual([[1, 0x185, 6]])
    expect(slavePdoLayout({ ...io(), nodeId: 7 }).rpdos[0].effectiveCobId).toBe(0x207)
  })

  it('names the rows that do not fit in sixteen PDOs', () => {
    const c = defaultCanopenSlaveConfig()
    c.objects = Array.from({ length: 17 }, (_, i) =>
      obj({
        id: `o${i}`,
        index: 0x2100,
        subIndex: i + 1,
        dataType: 'UNSIGNED64',
        direction: 'to_master',
        iecLocation: `%QL${i}`,
      }),
    )
    expect(slavePdoLayout(c).overflow.map((o) => o.id)).toEqual(['o16'])
    expect(validateCanopenSlaves([server(c)], [])).toEqual([
      'CANopen slave "io": 0x2100:11 "o16": does not fit in 16 TPDOs of 8 bytes',
    ])
  })

  it('parses values for their type', () => {
    expect(parseSlaveValue('-128', 'INTEGER8')).toBe(-128)
    expect(parseSlaveValue('128', 'INTEGER8')).toBeNull()
    expect(parseSlaveValue('0x10', 'UNSIGNED16')).toBe(16)
    expect(parseSlaveValue('1.5', 'REAL32')).toBe(1.5)
    expect(parseSlaveValue('1.5', 'INTEGER32')).toBeNull()
  })

  it('refuses a shared interface, a zero heartbeat, a default out of range and a STRING that is not a constant', () => {
    const master: PLCRemoteDevice = { name: 'line', protocol: 'canopen', canopenConfig: defaultCanopenConfig() }
    const c = io()
    c.heartbeatMs = 0
    c.objects[3] = { ...c.objects[3], defaultValue: '50' }
    c.objects[6] = { ...c.objects[6], exchange: 'sdo' }
    const errors = validateCanopenSlaves([server(c), server(defaultCanopenSlaveConfig(), 'other')], [master])
    expect(errors).toEqual([
      'CANopen slave "io": interface can0 is used by the CANopen master "line"; a master and a slave cannot share an interface',
      'CANopen slave "io": interface can0 is also used by the CANopen slave "other"',
      'CANopen slave "io": the heartbeat time must be 1 - 65535 ms; the slave always sends a heartbeat',
      'CANopen slave "io": 0x2000:04 "Limit": the default 50 is outside the range 100 - 30000',
      'CANopen slave "io": 0x2100:03 "Firmware": a STRING object must be a constant',
      'CANopen slave "other": interface can0 is used by the CANopen master "line"; a master and a slave cannot share an interface',
      'CANopen slave "other": interface can0 is also used by the CANopen slave "io"',
    ])
  })

  it('refuses an address outside the runtime image and an interface that is not a plain name', () => {
    const c = io()
    c.objects[0] = { ...c.objects[0], iecLocation: '%IW70000' }
    c.interface = 'x/../../../a'
    const text = checkCanopenSlave('io', c, []).map((p) => p.text)
    expect(text.some((t) => /address %IW70000 lies outside the runtime's I\/O image/.test(t))).toBe(true)
    expect(text.some((t) => /may hold only letters, digits/.test(t))).toBe(true)
    c.objects[0] = { ...c.objects[0], iecLocation: '%IW65535' }
    expect(checkCanopenSlave('io', c, []).some((p) => p.text.includes('outside'))).toBe(false)
  })

  it('leaves a slave that is off out of the build', () => {
    expect(generateCanopenConfig([], null, [server({ ...io(), enabled: false })])).toBeNull()
  })

  it('writes the slave under devices with format version 13', () => {
    const text = generateCanopenConfig([], null, [server(io())])
    expect(text).not.toBeNull()
    const json = JSON.parse(text ?? '{}') as { version: number; networks: unknown[]; devices: unknown[] }
    expect(json.version).toBe(13)
    expect(json.networks).toEqual([])
    expect(json.devices).toEqual(slaveDevicesOut([server(io())]))
    expect(json.devices[0]).toMatchObject({
      name: 'io',
      interface: 'can0',
      node_id: 5,
      heartbeat_ms: 1000,
      master_watch: null,
      on_plc_stop: 'hold',
      on_plc_stop_state: 'none',
      store_settings: false,
      objects: expect.arrayContaining([
        {
          index: 0x2000,
          subindex: 4,
          name: 'Limit',
          type: 'UNSIGNED16',
          direction: 'from_master',
          exchange: 'sdo',
          location: '%IW4',
          default: 1000,
          min: 100,
          max: 30000,
        },
        {
          index: 0x2100,
          subindex: 3,
          name: 'Firmware',
          type: 'VISIBLE_STRING',
          direction: 'to_master',
          exchange: 'constant',
          value: '1.4.0',
        },
      ]),
      rpdos: [
        {
          number: 1,
          cob_id: 0x205,
          transmission: 255,
          entries: [
            { index: 0x2000, subindex: 1 },
            { index: 0x2000, subindex: 2 },
            { index: 0x2000, subindex: 3 },
          ],
        },
      ],
      tpdos: [
        {
          number: 1,
          cob_id: 0x185,
          transmission: 255,
          inhibit_100us: 0,
          event_timer_ms: 0,
          entries: [
            { index: 0x2100, subindex: 1 },
            { index: 0x2100, subindex: 2 },
          ],
        },
      ],
    })
  })

  it('writes no LSS for a slave without LSS settings or with LSS off', () => {
    expect(slaveDevicesOut([server(io())])[0]).toMatchObject({ lss: null })
    const off = { ...io(), lss: { enabled: false, waitForMaster: true, serial: 9, bitrateChange: false } }
    expect(slaveDevicesOut([server(off)])[0]).toMatchObject({ lss: null })
    expect(slaveLss(io())).toEqual({ enabled: false, waitForMaster: false, serial: null, bitrateChange: true })
  })

  it('writes the LSS settings, leaving out an automatic serial number', () => {
    const waiting = { ...io(), lss: { enabled: true, waitForMaster: true, serial: null, bitrateChange: true } }
    expect(slaveDevicesOut([server(waiting)])[0]).toMatchObject({
      node_id: 5,
      lss: { enabled: true, wait_for_master: true, bitrate_change: true },
    })
    expect(slaveDevicesOut([server(waiting)])[0]).not.toHaveProperty('lss.serial')
    const fixed = { ...io(), lss: { enabled: true, waitForMaster: false, serial: 23, bitrateChange: false } }
    expect(slaveDevicesOut([server(fixed)])[0]).toMatchObject({
      lss: { enabled: true, wait_for_master: false, serial: 23, bitrate_change: false },
    })
  })

  it('refuses a fixed LSS serial number of 0 only while LSS is on', () => {
    const zero = { ...io(), lss: { enabled: true, waitForMaster: false, serial: 0, bitrateChange: true } }
    expect(checkCanopenSlave('io', zero, []).filter((p) => p.where === 'lss')).toHaveLength(1)
    const off = { ...zero, lss: { ...zero.lss, enabled: false } }
    expect(checkCanopenSlave('io', off, []).filter((p) => p.where === 'lss')).toEqual([])
    const waiting = { ...io(), lss: { enabled: true, waitForMaster: true, serial: null, bitrateChange: true } }
    expect(checkCanopenSlave('io', waiting, []).filter((p) => p.where === 'lss' || p.where === 'nodeId')).toEqual([])
  })

  it('suggests the next revision after the objects changed since the last export', () => {
    const c = io()
    c.lastExport = { revision: c.revision, layout: slaveLayoutText(c) }
    expect(suggestedSlaveRevision(c)).toBe(0x00010000)
    c.objects = [...c.objects, obj({ id: 'new', subIndex: 9, iecLocation: '%IW9' })]
    expect(suggestedSlaveRevision(c)).toBe(0x00010001)
  })

  it('gives new objects the lowest free address and keeps the others', () => {
    const pool = buildAddressPool(
      { servers: [server(io())] },
      { pinMapping: false, vppIo: false, modbusTcpRemote: false, ethercat: true },
    )
    const prev = io()
    const next = { ...prev, objects: [...prev.objects, obj({ id: 'n', subIndex: 9, iecLocation: '%IW' })] }
    const placed = addressNewSlaveObjects(prev, next, pool)
    expect(placed.objects.map((o) => o.iecLocation)).toEqual([
      '%IW0',
      '%IB2',
      '%IB3',
      '%IW4',
      '%QW0',
      '%QD0',
      '',
      '%IW1',
    ])
  })
})

describe('CANopen slave device file', () => {
  const now = new Date(2026, 10, 5, 9, 30)

  it('exports an EDS that passes the check and imports as a node with the slave layout', () => {
    const file = buildSlaveExport('io', io(), 'eds', now)
    expect(file.fileName).toBe('line-io.eds')
    expect(file.errors).toEqual([])
    expect(file.warnings).toEqual([])
    const eds = parseEds(file.text, file.fileName)
    expect(eds.vendorId).toBe(0)
    expect(eds.productCode).toBe(1)
    let n = 0
    const node = createCanopenNode(eds, {
      id: 'n',
      name: 'io',
      nodeId: 5,
      newId: () => `e${n++}`,
      allocate: (prefix) => `${prefix}${n++}`,
    })
    expect(
      node.tpdos.map((p) => [p.cobId, p.entries.map((e) => `${e.index.toString(16)}:${e.subIndex}:${e.name}`)]),
    ).toEqual([[0x185, ['2100:1:Actual', '2100:2:Counter']]])
    expect(node.rpdos.map((p) => [p.cobId, p.entries.map((e) => e.name)])).toEqual([
      [0x205, ['Setpoint', 'Mode', 'Flags']],
    ])
    expect(startupSdoCandidates(node).some((c) => c.object.index === 0x2000 && c.object.subIndex === 4)).toBe(true)
    const limit = eds.objects.find((o) => o.index === 0x2000 && o.subIndex === 4)
    expect(limit).toMatchObject({
      access: 'rw',
      pdoMapping: false,
      lowLimit: '100',
      highLimit: '30000',
      defaultValue: '1000',
    })
    expect(eds.objects.find((o) => o.index === 0x2100 && o.subIndex === 3)).toMatchObject({
      access: 'const',
      dataType: '0x0009',
      defaultValue: '1.4.0',
    })
    expect(eds.objects.find((o) => o.index === 0x1029 && o.subIndex === 2)).toMatchObject({
      access: 'rw',
      defaultValue: '1',
    })
    const stopped = parseEds(buildSlaveExport('io', { ...io(), onPlcStopState: 'stopped' }, 'eds', now).text, 'x.eds')
    expect(stopped.objects.find((o) => o.index === 0x1029 && o.subIndex === 2)?.defaultValue).toBe('2')
    expect(stopped.objects.find((o) => o.index === 0x1029 && o.subIndex === 0)?.defaultValue).toBe('2')
  })

  it('lists 0x1010 and 0x1011 only when the slave keeps the settings a master saves', () => {
    const subs = (storeSettings: boolean, index: number) =>
      parseEds(buildSlaveExport('io', { ...io(), storeSettings }, 'eds', now).text, 'x.eds')
        .objects.filter((o) => o.index === index)
        .map((o) => [o.subIndex, o.access, o.defaultValue])
    for (const format of ['eds', 'xdd'] as const) {
      const file = buildSlaveExport('io', { ...io(), storeSettings: true }, format, now)
      expect(file.errors).toEqual([])
      expect(file.warnings).toEqual([])
    }
    expect(subs(false, 0x1010)).toEqual([])
    expect(subs(false, 0x1011)).toEqual([])
    for (const index of [0x1010, 0x1011])
      expect(subs(true, index)).toEqual([
        [0, 'const', '3'],
        [1, 'rw', '1'],
        [2, 'rw', '1'],
        [3, 'rw', '1'],
      ])
    const json = JSON.parse(generateCanopenConfig([], null, [server({ ...io(), storeSettings: true })]) ?? '{}') as {
      devices: { store_settings: boolean }[]
    }
    expect(json.devices[0].store_settings).toBe(true)
  })

  it('marks LSS support and the fixed serial number in the EDS and XDD when LSS is on', () => {
    const lss = { ...io(), lss: { enabled: true, waitForMaster: true, serial: 0x17, bitrateChange: true } }
    const eds = buildSlaveExport('io', lss, 'eds', now)
    expect(eds.errors).toEqual([])
    expect(eds.warnings).toEqual([])
    expect(eds.text).toContain('LSS_Supported=1')
    expect(parseEds(eds.text, eds.fileName).objects.find((o) => o.index === 0x1018 && o.subIndex === 4)).toMatchObject({
      defaultValue: '0x00000017',
    })
    const xdd = buildSlaveExport('io', lss, 'xdd', now)
    expect(xdd.errors).toEqual([])
    expect(xdd.text).toContain('layerSettingServiceSlave="true"')
    expect(buildSlaveExport('io', io(), 'eds', now).text).toContain('LSS_Supported=0')
    expect(buildSlaveExport('io', io(), 'xdd', now).text).not.toContain('layerSettingServiceSlave')
  })

  it('exports an XDD that passes the check and reads back as the same objects', () => {
    const file = buildSlaveExport('io', io(), 'xdd', now)
    expect(file.errors).toEqual([])
    const xdd = parseXdd(file.text, file.fileName).eds
    const eds = parseEds(buildSlaveExport('io', io(), 'eds', now).text, 'x.eds')
    const key = (o: { index: number; subIndex: number; name: string; access: string; pdoMapping: boolean }) =>
      `${o.index}:${o.subIndex}:${o.name}:${o.access}:${o.pdoMapping}`
    expect(xdd.objects.filter((o) => o.index >= 0x2000).map(key)).toEqual(
      eds.objects.filter((o) => o.index >= 0x2000).map(key),
    )
  })
})
