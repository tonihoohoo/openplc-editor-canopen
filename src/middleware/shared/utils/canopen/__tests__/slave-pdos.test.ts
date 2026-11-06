import type { CanopenSlaveConfig, CanopenSlaveObject } from '../../../ports/canopen-types'
import type { PLCServer } from '../../../ports/types'
import { withFreePdoCobIds } from '../check-fix'
import { parseEds } from '../eds-parser'
import { createCanopenNode, defaultCanopenConfig } from '../model'
import {
  addSlavePdo,
  buildSlaveExport,
  cannotMoveSlaveObject,
  checkCanopenSlave,
  defaultCanopenSlaveConfig,
  leaveSlaveObjectToMaster,
  moveSlaveObject,
  placeSlaveObject,
  removeSlavePdo,
  shiftSlaveObject,
  slaveDevicesOut,
  slaveMasterMappedObjects,
  slavePdoLayout,
  slavePdoWarnings,
  suggestedSlavePdoCobId,
  updateSlavePdo,
  withSlavePdoLayout,
} from '../slave'
import { expectedSlavePdos } from '../slave-online'
import { parseXdd } from '../xdd-parser'

const to = (
  id: string,
  subIndex: number,
  dataType: CanopenSlaveObject['dataType'] = 'INTEGER16',
): CanopenSlaveObject => ({
  id,
  index: 0x2100,
  subIndex,
  name: id,
  dataType,
  direction: 'to_master',
  exchange: 'pdo',
  iecLocation: '',
  defaultValue: '0',
})

const from = (id: string, subIndex: number): CanopenSlaveObject => ({
  ...to(id, subIndex),
  index: 0x2000,
  direction: 'from_master',
})

const base = (): CanopenSlaveConfig => ({
  ...defaultCanopenSlaveConfig('io'),
  objects: [
    from('set', 1),
    to('pos', 1, 'INTEGER32'),
    to('speed', 2),
    to('temp', 3, 'REAL32'),
    to('count', 4, 'UNSIGNED64'),
  ],
})

const server = (config: CanopenSlaveConfig): PLCServer => ({
  name: 'io',
  protocol: 'canopen-slave',
  canopenSlaveConfig: config,
})

const ids = (config: CanopenSlaveConfig) =>
  slavePdoLayout(config).tpdos.map((p) => [p.number, p.objects.map((o) => o.id)])

describe('CANopen slave PDO layout', () => {
  it('fills the PDOs in table order and keeps the stored layout on later edits', () => {
    const c = withSlavePdoLayout(base())
    expect(ids(c)).toEqual([
      [1, ['pos', 'speed']],
      [2, ['temp']],
      [3, ['count']],
    ])
    const moved = moveSlaveObject(c, 'temp', 1)
    expect(ids(moved)).toEqual([
      [1, ['pos', 'speed']],
      [2, ['temp']],
      [3, ['count']],
    ])
    expect(cannotMoveSlaveObject(c, 'temp', 1)).toBe('2 bytes free, needs 4')
    expect(cannotMoveSlaveObject(c, 'speed', 3)).toBe('full')
    const shifted = shiftSlaveObject(moveSlaveObject(c, 'speed', 2), 'speed', -1)
    expect(ids(shifted)).toEqual([
      [1, ['pos']],
      [2, ['speed', 'temp']],
      [3, ['count']],
    ])
    // A new object goes to the first PDO with room, and the others stay where they are.
    const grown = withSlavePdoLayout({ ...shifted, objects: [...shifted.objects, to('flag', 5, 'UNSIGNED8')] })
    expect(ids(grown)[0]).toEqual([1, ['pos', 'flag']])
  })

  it('moves an object to a new PDO and leaves the objects of a removed PDO to the master', () => {
    const c = moveSlaveObject(withSlavePdoLayout(base()), 'speed', 7)
    expect(ids(c)).toEqual([
      [1, ['pos']],
      [2, ['temp']],
      [3, ['count']],
      [7, ['speed']],
    ])
    expect(slavePdoLayout(c).tpdos[3]).toMatchObject({ cobId: null, effectiveCobId: 0 })
    const removed = removeSlavePdo(c, 'to_master', 7)
    expect(ids(removed)).toEqual([
      [1, ['pos']],
      [2, ['temp']],
      [3, ['count']],
    ])
    expect(removed.objects.find((o) => o.id === 'speed')).toMatchObject({ exchange: 'pdo', mappedByMaster: true })
    expect(slaveMasterMappedObjects(removed, 'to_master').map((o) => o.id)).toEqual(['speed'])
  })

  it('keeps an object mappable in no default PDO, and moves it back into one', () => {
    const c = leaveSlaveObjectToMaster(withSlavePdoLayout(base()), 'temp')
    expect(ids(c)).toEqual([
      [1, ['pos', 'speed']],
      [2, []],
      [3, ['count']],
    ])
    expect(slaveMasterMappedObjects(c, 'to_master').map((o) => o.id)).toEqual(['temp'])
    const out = slaveDevicesOut([server(c)])[0]
    expect(out).toMatchObject({
      objects: expect.arrayContaining([expect.objectContaining({ name: 'temp', exchange: 'pdo' })]),
    })
    expect(JSON.stringify(out)).not.toMatch(/"entries":\[[^\]]*"subindex":3/)
    const eds = parseEds(buildSlaveExport('io', c, 'eds', new Date(2026, 10, 5)).text, 'io.eds')
    expect(eds.objects.find((o) => o.index === 0x2100 && o.subIndex === 3)?.pdoMapping).toBe(true)
    expect(cannotMoveSlaveObject(c, 'temp', 1)).toBe('2 bytes free, needs 4')
    const back = moveSlaveObject(c, 'temp', 2)
    expect(ids(back)[1]).toEqual([2, ['temp']])
    expect(back.objects.find((o) => o.id === 'temp')?.mappedByMaster).toBeUndefined()
    const placed = placeSlaveObject(back, 'speed', 0)
    expect(ids(placed)[0]).toEqual([1, ['speed', 'pos']])
  })

  it('migrates the TPDO settings of an older project', () => {
    const { pdos: _none, ...old } = base()
    const legacy: CanopenSlaveConfig = {
      ...old,
      tpdos: [
        { transmissionType: 1, inhibitTime: 0, eventTimerMs: 0 },
        { transmissionType: 255, inhibitTime: 10, eventTimerMs: 500 },
      ],
    }
    const stored = withSlavePdoLayout(legacy)
    expect(stored.tpdos).toBeUndefined()
    expect(stored.pdos?.tpdos.map((p) => [p.number, p.transmissionType, p.inhibitTime, p.eventTimerMs])).toEqual([
      [1, 1, 0, 0],
      [2, 255, 10, 500],
      [3, 255, 0, 0],
    ])
  })

  it('writes sixteen PDOs each way, leaving out the COB-ID the master gives', () => {
    let c = withSlavePdoLayout(base())
    c = moveSlaveObject(c, 'count', 5)
    c = updateSlavePdo(c, 'from_master', 1, { eventTimerMs: 500 })
    c = addSlavePdo(c, 'to_master').config
    const out = slaveDevicesOut([server(c)])[0]
    expect(out).toMatchObject({
      rpdos: [{ number: 1, cob_id: 0x205, event_timer_ms: 500 }],
      tpdos: [
        { number: 1, cob_id: 0x185 },
        { number: 2, cob_id: 0x285 },
        { number: 5, entries: [{ index: 0x2100, subindex: 4 }] },
      ],
    })
    expect(out).not.toHaveProperty('tpdos.2.cob_id')
    expect(JSON.stringify(out)).not.toContain('"number":3')
    const fixed = updateSlavePdo(c, 'to_master', 5, { cobId: suggestedSlavePdoCobId(c) })
    expect(slaveDevicesOut([server(fixed)])[0]).toMatchObject({ tpdos: [{}, {}, { number: 5, cob_id: 0x681 }] })
  })

  it('refuses a fixed COB-ID that is reserved or used twice, and warns about Start alone', () => {
    const c = moveSlaveObject(withSlavePdoLayout(base()), 'count', 5)
    expect(slavePdoWarnings(c)).toEqual([])
    expect(slavePdoWarnings({ ...c, startAlone: true })).toEqual([
      {
        where: 'tpdos5',
        text: 'TPDO 5 is not exchanged until a master gives it a COB-ID; Start alone does not wait for one.',
      },
    ])
    const twice = updateSlavePdo(c, 'to_master', 5, { cobId: 0x285 })
    expect(checkCanopenSlave('io', twice, [])).toContainEqual({
      where: 'tpdos5',
      text: "TPDO 5: COB-ID 0x285 is already TPDO 2's",
    })
    const reserved = updateSlavePdo(c, 'to_master', 5, { cobId: 0x705 })
    expect(checkCanopenSlave('io', reserved, [])).toContainEqual({
      where: 'tpdos5',
      text: 'TPDO 5: COB-ID 0x705 is reserved for heartbeat',
    })
  })

  it('names a row that fits in no PDO', () => {
    const c = defaultCanopenSlaveConfig()
    c.objects = Array.from({ length: 17 }, (_, i) => to(`o${i}`, i + 1, 'UNSIGNED64'))
    expect(slavePdoLayout(c).overflow.map((o) => o.id)).toEqual(['o16'])
  })

  it('expects TPDO 5 invalid online until the master sets its COB-ID', () => {
    const c = moveSlaveObject(withSlavePdoLayout(base()), 'count', 5)
    const expected = expectedSlavePdos(c)
    expect(expected).toHaveLength(32)
    expect(expected.find((p) => p.dir === 'tx' && p.pdo === 5)).toMatchObject({ valid: false, cob_id: 0 })
    expect(expected.find((p) => p.dir === 'tx' && p.pdo === 1)).toMatchObject({ valid: true, cob_id: 0x185 })
  })
})

describe('CANopen slave device file with sixteen PDOs', () => {
  const now = new Date(2026, 10, 5, 9, 30)
  const layout = () => moveSlaveObject(withSlavePdoLayout(base()), 'count', 5)

  it('exports an EDS and XDD that pass the checks with 16 RPDOs and 16 TPDOs', () => {
    const eds = buildSlaveExport('io', layout(), 'eds', now)
    expect(eds.errors).toEqual([])
    expect(eds.warnings).toEqual([])
    expect(eds.text).toContain('NrOfRXPDO=16')
    expect(eds.text).toContain('NrOfTXPDO=16')
    const parsed = parseEds(eds.text, eds.fileName)
    expect(parsed.objects.find((o) => o.index === 0x1804 && o.subIndex === 1)?.defaultValue).toBe('0x80000000')
    expect(parsed.objects.find((o) => o.index === 0x1a04 && o.subIndex === 1)?.defaultValue).toBe('0x21000440')
    expect(parsed.objects.find((o) => o.index === 0x180f && o.subIndex === 1)).toBeDefined()
    expect(parsed.objects.find((o) => o.index === 0x140f && o.subIndex === 1)).toBeDefined()
    const xdd = buildSlaveExport('io', layout(), 'xdd', now)
    expect(xdd.errors).toEqual([])
    expect(parseXdd(xdd.text, xdd.fileName).eds.objects.some((o) => o.index === 0x1a0f)).toBe(true)
  })

  it('imports TPDO 5 into a master node with the lowest free COB-ID', () => {
    const eds = parseEds(buildSlaveExport('io', layout(), 'eds', now).text, 'io.eds')
    let n = 0
    const node = createCanopenNode(eds, {
      id: 'n5',
      name: 'io',
      nodeId: 5,
      newId: () => `e${n++}`,
      allocate: (prefix) => `${prefix}${n++}`,
    })
    expect(node.tpdos.map((p) => [p.number, p.cobId])).toEqual([
      [1, 0x185],
      [2, 0x285],
      [5, 0],
    ])
    const placed = withFreePdoCobIds(defaultCanopenConfig(), node)
    expect(placed.tpdos.map((p) => [p.number, p.cobId])).toEqual([
      [1, 0x185],
      [2, 0x285],
      [5, 0x181],
    ])
    expect(placed.tpdos[2].entries.map((e) => e.name)).toEqual(['count'])
  })
})
