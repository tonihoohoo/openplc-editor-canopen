import type { CanopenPdo } from '../../../ports/canopen-types'
import { findObject } from '../eds-parser'
import {
  cannotMap,
  canWatchMaster,
  createCanopenNode,
  defaultCanopenConfig,
  hasErrorBehaviour,
  lowestFreeNodeId,
  mappableObjects,
  moveCobId,
  nodeEntries,
  nodeNameFromEds,
  pdoBits,
  placeholderAddress,
  predefinedCobId,
  uniqueNodeName,
  updateNode,
  updatePdo,
  withEntryAlias,
  withNodeId,
  withPdoEnabled,
} from '../model'
import { configWith, genericIoEds, genericNode } from './fixtures/helpers'

describe('createCanopenNode', () => {
  it('builds the PDOs from the EDS defaults, with addresses', () => {
    const node = genericNode(2)
    expect(node.tpdos).toHaveLength(1)
    expect(node.tpdos[0]).toMatchObject({
      number: 1,
      cobId: 0x182,
      enabled: true,
      fixedMapping: false,
      transmissionType: 255,
      eventTimerMs: 20,
      inhibitTime: 0,
    })
    expect(node.tpdos[0].entries.map((e) => [e.index, e.subIndex, e.dataType, e.iecLocation])).toEqual([
      [0x6000, 1, 'UNSIGNED8', '%IB1'],
      [0x6401, 1, 'INTEGER16', '%IW0'],
    ])
    expect(node.rpdos[0]).toMatchObject({ number: 1, cobId: 0x202, enabled: true })
    expect(node.rpdos[0].entries.map((e) => e.iecLocation)).toEqual(['%QB0'])
    expect(node.state).toMatchObject({ channelId: 'state', iecLocation: '%IB0', dataType: 'UNSIGNED8' })
  })

  it('checks vendor and product but not the revision, and supervises with heartbeat', () => {
    const node = genericNode(2)
    expect([node.checkVendorId, node.checkProductCode, node.checkRevision]).toEqual([true, true, false])
    expect(node.supervision).toBe('heartbeat')
  })

  it('does without heartbeat when the device has no 0x1017', () => {
    const eds = genericIoEds()
    eds.objects = eds.objects.filter((o) => o.index !== 0x1017)
    const node = createCanopenNode(eds, {
      id: 'n',
      name: 'n',
      nodeId: 3,
      newId: () => 'x',
      allocate: placeholderAddress,
    })
    expect(node.supervision).toBe('none')
  })

  it('watches the master when the EDS lets the node consume a heartbeat', () => {
    expect(genericNode(2).watchMaster).toEqual({ enabled: true, consumerMs: 300, onError: 'pre_operational' })
    const eds = genericIoEds()
    expect(canWatchMaster(eds) && hasErrorBehaviour(eds)).toBe(true)
    eds.objects = eds.objects.filter((o) => o.index !== 0x1016 && o.index !== 0x1029)
    expect(canWatchMaster(eds) || hasErrorBehaviour(eds)).toBe(false)
    const node = createCanopenNode(eds, {
      id: 'n',
      name: 'n',
      nodeId: 3,
      newId: () => 'x',
      allocate: placeholderAddress,
    })
    expect(node.watchMaster.enabled).toBe(false)
  })

  it('gives a new network a master heartbeat and the default bus priority', () => {
    expect(defaultCanopenConfig().network).toMatchObject({ heartbeatProducerMs: 100, priority: 90 })
  })

  it('marks a PDO with a read-only mapping as fixed and one with COB-ID 0 as disabled', () => {
    const eds = genericIoEds()
    eds.objects = eds.objects.map((o) =>
      o.index === 0x1a00
        ? { ...o, access: 'ro' }
        : o.index === 0x1400 && o.subIndex === 1
          ? { ...o, defaultValue: '0' }
          : o,
    )
    const node = createCanopenNode(eds, {
      id: 'n',
      name: 'n',
      nodeId: 4,
      newId: () => 'x',
      allocate: placeholderAddress,
    })
    expect(node.tpdos[0].fixedMapping).toBe(true)
    expect(node.rpdos[0]).toMatchObject({ enabled: false, cobId: 0x204 })
    expect(node.rpdos[0].entries[0].iecLocation).toBe('')
  })

  it('lists the state and every PDO entry as entries', () => {
    expect(nodeEntries(genericNode(2)).map((e) => e.iecLocation)).toEqual(['%IB0', '%IB1', '%IW0', '%QB0'])
  })
})

describe('node IDs and names', () => {
  it('finds the lowest free node ID, skipping the master', () => {
    const config = defaultCanopenConfig()
    expect(lowestFreeNodeId(config)).toBe(1)
    config.network.masterNodeId = 1
    expect(lowestFreeNodeId(configWith(genericNode(2)))).toBe(1)
    expect(lowestFreeNodeId({ ...config, nodes: [genericNode(2)] })).toBe(3)
    const full = { ...config, nodes: Array.from({ length: 127 }, (_, i) => ({ ...genericNode(2), nodeId: i + 1 })) }
    expect(lowestFreeNodeId(full)).toBeNull()
  })

  it('moves predefined COB-IDs with the node ID and keeps others', () => {
    expect(predefinedCobId('input', 2, 5)).toBe(0x285)
    expect(predefinedCobId('output', 5, 5)).toBe(0)
    expect(moveCobId(0x182, 2, 7, 'input')).toBe(0x187)
    expect(moveCobId(0x300, 2, 7, 'input')).toBe(0x300)
    const moved = withNodeId(genericNode(2), 9)
    expect([moved.nodeId, moved.tpdos[0].cobId, moved.rpdos[0].cobId]).toEqual([9, 0x189, 0x209])
  })

  it('makes node names unique and identifier-like', () => {
    expect(uniqueNodeName(configWith(genericNode(2)), 'io2')).toBe('io2_2')
    expect(uniqueNodeName(configWith(genericNode(2)), 'io3')).toBe('io3')
    expect(nodeNameFromEds(genericIoEds())).toBe('Generic_I_O_module')
    expect(nodeNameFromEds({ ...genericIoEds(), productName: '24 V module' })).toBe('node_24_V_module')
    expect(nodeNameFromEds({ ...genericIoEds(), productName: '---' })).toBe('node')
  })
})

describe('editing', () => {
  it('replaces one node and one PDO', () => {
    const config = configWith(genericNode(2), genericNode(3))
    const next = updateNode(config, 'node-3', (n) => updatePdo(n, 'output', 1, (p) => ({ ...p, cobId: 0x300 })))
    expect(next.nodes[0]).toBe(config.nodes[0])
    expect(next.nodes[1].rpdos[0].cobId).toBe(0x300)
    const tx = updatePdo(genericNode(2), 'input', 1, (p) => ({ ...p, eventTimerMs: 50 }))
    expect(tx.tpdos[0].eventTimerMs).toBe(50)
  })

  it('gives a PDO addresses when enabled and takes them, with their aliases, when disabled', () => {
    const pdo = genericNode(2).tpdos[0]
    const off = withPdoEnabled(
      { ...pdo, entries: pdo.entries.map((e) => ({ ...e, alias: 'a' })) },
      'input',
      false,
      placeholderAddress,
    )
    expect(off.entries.map((e) => [e.iecLocation, e.alias])).toEqual([
      ['', undefined],
      ['', undefined],
    ])
    const on = withPdoEnabled(off, 'input', true, placeholderAddress)
    expect(on.entries.map((e) => e.iecLocation)).toEqual(['%IB0', '%IW0'])
    expect(placeholderAddress('%QX', true)).toBe('%QX0.0')
  })

  it('sets and clears the alias of the state and of PDO entries', () => {
    const node = genericNode(2)
    const channel = node.rpdos[0].entries[0].channelId
    const named = withEntryAlias(withEntryAlias(node, 'state', 'io2_state'), channel, 'lamp')
    expect(named.state.alias).toBe('io2_state')
    expect(named.rpdos[0].entries[0].alias).toBe('lamp')
    expect(withEntryAlias(named, channel, '').rpdos[0].entries[0].alias).toBeUndefined()
  })

  it('says why an object does not fit a PDO', () => {
    const eds = genericIoEds()
    const pdo: CanopenPdo = genericNode(2).tpdos[0]
    const input = findObject(eds, 0x6000, 1)
    const unsupported = { ...findObject(eds, 0x6000, 1), dataType: '0x0009' }
    if (!input) throw new Error('fixture lacks 0x6000:1')
    expect(cannotMap(pdo, input)).toBeNull()
    expect(cannotMap({ ...pdo, fixedMapping: true }, input)).toMatch(/fixes the mapping/)
    expect(cannotMap(pdo, { ...input, ...unsupported })).toMatch(/data type/)
    const full = { ...pdo, entries: [...pdo.entries, ...pdo.entries, ...pdo.entries] }
    expect(pdoBits(full)).toBe(72)
    expect(cannotMap(full, input)).toMatch(/at most 8 bytes/)
  })

  it('offers readable objects (outputs too, read back) for inputs and writable ones for outputs', () => {
    const eds = genericIoEds()
    const ref = (o: { index: number; subIndex: number }) => `${o.index.toString(16)}:${o.subIndex}`
    expect(mappableObjects(eds, 'input').map(ref)).toEqual(['2200:1', '2200:2', '6000:1', '6200:1', '6401:1'])
    expect(mappableObjects(eds, 'output').map(ref)).toEqual(['6200:1'])
  })
})
