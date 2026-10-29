import type { CanopenEdsInfo, CanopenObject } from '../../../ports/canopen-types'
import {
  isSynchronousType,
  matchesObjectQuery,
  moveItem,
  objectLabel,
  objectParameterState,
  pdoParameterState,
  startupSdoCandidates,
  transmissionChoices,
  transmissionMode,
  transmissionTypeFor,
} from '../editing'
import { findObject, parseEds } from '../eds-parser'
import { createCanopenNode, placeholderAddress } from '../model'
import { GENERIC_IO_EDS, genericIoEds, genericNode } from './fixtures/helpers'

/** The generic I/O EDS with lines replaced in one section. */
function edsWith(section: string, replace: Record<string, string>): CanopenEdsInfo {
  const start = GENERIC_IO_EDS.indexOf(`[${section}]`)
  const end = GENERIC_IO_EDS.indexOf('\n[', start + 1)
  let body = GENERIC_IO_EDS.slice(start, end)
  for (const [from, to] of Object.entries(replace)) body = body.replace(from, to)
  return parseEds(GENERIC_IO_EDS.slice(0, start) + body + GENERIC_IO_EDS.slice(end), 'test.eds')
}

const modes = (eds: CanopenEdsInfo, direction: 'input' | 'output' = 'input') =>
  transmissionChoices(eds, direction, 1, 2).choices.map((c) => [c.mode, c.disabledReason === null, c.edsDefault])

describe('transmission types', () => {
  it('maps types to modes, without RTR or reserved types', () => {
    expect([0, 1, 240, 241, 251, 252, 253, 254, 255].map(transmissionMode)).toEqual([
      'sync_acyclic',
      'sync_cyclic',
      'sync_cyclic',
      null,
      null,
      null,
      null,
      'event_manufacturer',
      'event_profile',
    ])
    expect(transmissionTypeFor('sync_cyclic', 4)).toBe(4)
    expect(transmissionTypeFor('event_manufacturer', 4)).toBe(254)
    expect([0, 240, 254].map(isSynchronousType)).toEqual([true, true, false])
  })

  it('offers the four modes in both directions and marks the EDS default', () => {
    const expected = [
      ['sync_acyclic', true, false],
      ['sync_cyclic', true, false],
      ['event_manufacturer', true, false],
      ['event_profile', true, true],
    ]
    expect(modes(genericIoEds())).toEqual(expected)
    expect(modes(genericIoEds(), 'output')).toEqual(expected)
    expect(transmissionChoices(genericIoEds(), 'input', 1, 2).readOnlyReason).toBeNull()
  })

  it('applies the EDS limits', () => {
    const eds = edsWith('1800sub2', { 'DefaultValue=255': 'DefaultValue=1\nLowLimit=1\nHighLimit=10' })
    const choices = transmissionChoices(eds, 'input', 1, 2)
    expect(modes(eds)).toEqual([
      ['sync_acyclic', false, false],
      ['sync_cyclic', true, true],
      ['event_manufacturer', false, false],
      ['event_profile', false, false],
    ])
    expect([choices.cyclicMin, choices.cyclicMax]).toEqual([1, 10])
  })

  it('replaces an RTR default with 255', () => {
    const eds = edsWith('1800sub2', { 'DefaultValue=255': 'DefaultValue=253' })
    expect(transmissionChoices(eds, 'input', 1, 2).replacedEdsDefault).toBe(253)
    expect(modes(eds)[3]).toEqual(['event_profile', true, true])
    const node = createCanopenNode(eds, {
      id: 'n',
      name: 'n',
      nodeId: 2,
      newId: () => 'x',
      allocate: placeholderAddress,
    })
    expect(node.tpdos[0].transmissionType).toBe(255)
  })

  it('makes a read-only or missing transmission type read-only', () => {
    const locked = edsWith('1800sub2', { 'AccessType=rw': 'AccessType=ro' })
    expect(transmissionChoices(locked, 'input', 1, 2).readOnlyReason).toBe('Read-only in the EDS, not written')
    expect(transmissionChoices(genericIoEds(), 'input', 2, 2).readOnlyReason).toMatch(/no transmission type/)
  })
})

describe('parameter states', () => {
  it('names the object and says when it is not written', () => {
    const eds = edsWith('1800sub5', { 'AccessType=rw': 'AccessType=ro' })
    expect(pdoParameterState(eds, 'input', 1, 3)).toEqual({ ref: '0x1800:03', notWrittenReason: null })
    expect(pdoParameterState(eds, 'input', 1, 5)).toEqual({
      ref: '0x1800:05',
      notWrittenReason: 'read-only in the EDS, not written',
    })
    expect(pdoParameterState(eds, 'output', 1, 5).notWrittenReason).toBe('not in the EDS, not written')
    expect(objectParameterState(eds, 0x1017, 0).ref).toBe('0x1017:00')
  })
})

describe('object search and labels', () => {
  const object = (index: number, subIndex: number): CanopenObject => {
    const o = findObject(genericIoEds(), index, subIndex)
    if (!o) throw new Error('missing object')
    return o
  }

  it('labels sub-indices with their parent name', () => {
    expect(objectLabel(object(0x6401, 1))).toBe('Analogue inputs / Input 1')
    expect(objectLabel(object(0x2100, 0))).toBe('Parameter')
    expect(objectLabel(object(0x2200, 1))).toBe('Counters / First counter')
  })

  it('matches by index in any form and by words of the names', () => {
    const input = object(0x6401, 1)
    for (const q of ['', '6401', '0x6401', '6401:1', '0x6401:01', '64', 'analogue', 'INPUT 1', 'analogue input'])
      expect([q, matchesObjectQuery(input, q)]).toEqual([q, true])
    for (const q of ['6000', '6401:2', 'digital', 'analogue output'])
      expect([q, matchesObjectQuery(input, q)]).toEqual([q, false])
  })
})

describe('startupSdoCandidates', () => {
  it('hides objects the editor writes, counters, RPDO-mapped and listed objects', () => {
    const node = genericNode(2)
    node.sdos = [{ id: 's', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '0' }]
    const shown = startupSdoCandidates(node).map((c) => [
      `${c.object.index.toString(16)}:${c.object.subIndex}`,
      c.hiddenReason,
    ])
    expect(shown).toEqual([
      ['1017:0', 'The editor writes it from the supervision settings'],
      ['1400:1', 'The editor writes it from the PDO settings'],
      ['1400:2', 'The editor writes it from the PDO settings'],
      ['1600:0', 'The editor writes it from the PDO settings'],
      ['1600:1', 'The editor writes it from the PDO settings'],
      ['1800:1', 'The editor writes it from the PDO settings'],
      ['1800:2', 'The editor writes it from the PDO settings'],
      ['1800:3', 'The editor writes it from the PDO settings'],
      ['1800:5', 'The editor writes it from the PDO settings'],
      ['1a00:0', 'The editor writes it from the PDO settings'],
      ['1a00:1', 'The editor writes it from the PDO settings'],
      ['1a00:2', 'The editor writes it from the PDO settings'],
      ['2100:0', 'Already in the list'],
      ['6200:1', 'Mapped in an RPDO, which overwrites it every cycle'],
    ])
  })

  it('offers an RPDO object again once its PDO is disabled, and never 0x1010 or 0x1011', () => {
    const node = genericNode(2)
    node.rpdos[0].enabled = false
    node.eds = {
      ...node.eds,
      objects: [
        ...node.eds.objects,
        { index: 0x1010, subIndex: 1, name: 'Save all', dataType: 'UNSIGNED32', access: 'rw', pdoMapping: false },
        { index: 0x3000, subIndex: 0, name: 'Count', dataType: 'UNSIGNED8', access: 'rw', pdoMapping: false },
        { index: 0x3000, subIndex: 1, name: 'Mode', dataType: 'UNSIGNED8', access: 'rw', pdoMapping: false },
      ],
    }
    const candidates = startupSdoCandidates(node)
    expect(candidates.find((c) => c.object.index === 0x6200)?.hiddenReason).toBeNull()
    expect(candidates.some((c) => c.object.index === 0x1010)).toBe(false)
    expect(candidates.find((c) => c.object.index === 0x3000 && c.object.subIndex === 0)?.hiddenReason).toBe(
      'Number of entries, rarely a setting',
    )
    expect(candidates.find((c) => c.object.index === 0x3000 && c.object.subIndex === 1)?.hiddenReason).toBeNull()
  })
})

describe('moveItem', () => {
  it('moves an item and ignores moves out of range', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b'], 0, 2)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b'])
  })
})
