import type { CanopenSlaveConfig, CanopenSlaveObject } from '../../../ports/canopen-types'
import {
  checkCanopenSlave,
  defaultCanopenSlaveConfig,
  newSlaveGroupIndex,
  nextSlaveObjectPlace,
  parseSlaveObjectNumber,
  slaveFreeSubIndexText,
  slaveGroupChoices,
  slaveIndexDirection,
  slaveObjectNumberProblem,
  slaveObjectNumberWarnings,
  slaveTypeLimits,
} from '../slave'

let n = 0
const obj = (over: Partial<CanopenSlaveObject>): CanopenSlaveObject => {
  n += 1
  return {
    id: `o${n}`,
    index: 0x2000,
    subIndex: 1,
    name: `Object${n}`,
    dataType: 'INTEGER16',
    direction: 'from_master',
    exchange: 'sdo',
    iecLocation: `%IW${n}`,
    defaultValue: '0',
    ...over,
  }
}

const slave = (objects: CanopenSlaveObject[]): CanopenSlaveConfig => ({ ...defaultCanopenSlaveConfig('io'), objects })

describe('slave object numbers', () => {
  it('gives an index the direction of its objects, or of its default group when empty', () => {
    const a = obj({ index: 0x2100, subIndex: 1, direction: 'to_master', iecLocation: '%QW0' })
    const c = slave([
      a,
      obj({ index: 0x2300, subIndex: 1 }),
      obj({ index: 0x2300, subIndex: 2, direction: 'to_master' }),
    ])
    expect(slaveIndexDirection(c, 0x2000)).toBe('from_master')
    expect(slaveIndexDirection(c, 0x2100)).toBe('to_master')
    expect(slaveIndexDirection(c, 0x2100, a.id)).toBe('to_master')
    expect(slaveIndexDirection(c, 0x2300)).toBe('both')
    expect(slaveIndexDirection(c, 0x2400)).toBeNull()
  })

  it('does not overflow a full group into the other direction', () => {
    const full = Array.from({ length: 254 }, (_, i) => obj({ subIndex: i + 1 }))
    const c = slave([...full, obj({ index: 0x2100, subIndex: 1, direction: 'to_master' })])
    expect(nextSlaveObjectPlace(c, 'from_master')).toEqual({ index: 0x2200, subIndex: 1 })
    expect(nextSlaveObjectPlace(c, 'to_master')).toEqual({ index: 0x2100, subIndex: 2 })
  })

  it('fills the groups of a direction in order before opening a new one', () => {
    const c = slave([obj({ index: 0x2000, subIndex: 1 }), obj({ index: 0x2200, subIndex: 1 })])
    expect(nextSlaveObjectPlace(c, 'from_master')).toEqual({ index: 0x2000, subIndex: 2 })
    expect(newSlaveGroupIndex(c)).toBe(0x2300)
  })

  it('offers the groups of an object, its own first, the other direction not selectable, and a new group', () => {
    const rows = [obj({ subIndex: 1 }), obj({ subIndex: 2 }), obj({ subIndex: 3 })]
    const c = slave([...rows, obj({ index: 0x2100, subIndex: 1, direction: 'to_master' })])
    const choices = slaveGroupChoices(c, rows[2].id)
    expect(choices.map((x) => [x.index, x.place])).toEqual([
      [0x2000, { index: 0x2000, subIndex: 3 }],
      [0x2100, null],
      [0x2200, { index: 0x2200, subIndex: 1 }],
    ])
    expect(choices[0].current).toBe(true)
    expect(choices[2].isNew).toBe(true)
  })

  it('refuses numbers outside the manufacturer area with the reason for their area', () => {
    expect(slaveObjectNumberProblem(0x6200, 1)).toContain('device profiles')
    expect(slaveObjectNumberProblem(0x1018, 1)).toContain('the slave fills these in itself')
    expect(slaveObjectNumberProblem(0x0007, 1)).toContain('data types')
    expect(slaveObjectNumberProblem(0xa000, 1)).toContain('network variables')
    expect(slaveObjectNumberProblem(0xc000, 1)).toContain('reserved')
    expect(slaveObjectNumberProblem(0x2000, 0)).toContain('use 01 - FE')
    expect(slaveObjectNumberProblem(0x5fff, 0xfe)).toBeNull()
    for (const index of [0x6200, 0x1018, 0x0007, 0xa000, 0xc000])
      expect(slaveObjectNumberProblem(index, 1)).toContain('0x2000:01 - 0x5FFF:FE')
  })

  it('parses a typed number, refusing a bad format, a refused area and a used place', () => {
    const a = obj({ subIndex: 1 })
    const b = obj({ subIndex: 2 })
    const c = slave([a, b])
    expect(parseSlaveObjectNumber(c, a.id, '0x2200:01')).toEqual({ place: { index: 0x2200, subIndex: 1 } })
    expect(parseSlaveObjectNumber(c, a.id, '2000:3')).toEqual({ place: { index: 0x2000, subIndex: 3 } })
    expect(parseSlaveObjectNumber(c, a.id, 'x')).toEqual({ refusal: 'Write the object as 0x2000:01.' })
    expect(parseSlaveObjectNumber(c, a.id, '0x6200:01')).toEqual({
      refusal: expect.stringContaining('device profiles') as unknown,
    })
    expect(parseSlaveObjectNumber(c, a.id, '0x2000:02')).toEqual({ refusal: `"${b.name}" uses it.` })
  })

  it('warns, without stopping the build, about an object in the other direction group', () => {
    const wrong = obj({ index: 0x2100, subIndex: 2, iecLocation: '%IW9' })
    const c = slave([
      obj({ subIndex: 1, iecLocation: '%IW0' }),
      obj({ index: 0x2100, subIndex: 1, direction: 'to_master', iecLocation: '%QW0' }),
      wrong,
    ])
    expect(slaveObjectNumberWarnings(c)).toEqual([
      {
        where: wrong.id,
        text: expect.stringContaining('0x2100 is the group of objects to the master') as unknown,
        moveTo: { index: 0x2000, subIndex: 2 },
      },
    ])
    expect(checkCanopenSlave('io', c, []).filter((p) => p.where === wrong.id)).toEqual([])
  })

  it('warns about an object alone in the empty default group of the other direction', () => {
    const wrong = obj({ index: 0x2100, subIndex: 1 })
    expect(slaveObjectNumberWarnings(slave([wrong])).map((w) => w.moveTo)).toEqual([{ index: 0x2000, subIndex: 1 }])
  })

  it('names the area in the build check of a number out of range', () => {
    const bad = obj({ index: 0x6000, subIndex: 1 })
    expect(checkCanopenSlave('io', slave([bad]), []).find((p) => p.where === bad.id)?.text).toContain(
      'belongs to device profiles',
    )
  })

  it('lists free sub-indexes below the highest one', () => {
    const c = slave([1, 2, 4, 8].map((s) => obj({ index: 0x2100, subIndex: s, direction: 'to_master' })))
    expect(slaveFreeSubIndexText(c, 0x2100)).toBe('03, 05-07')
    expect(slaveFreeSubIndexText(slave([obj({})]), 0x2000)).toBe('')
  })

  it('gives the limits of whole-number types', () => {
    expect(slaveTypeLimits('INTEGER16')).toEqual(['-32768', '32767'])
    expect(slaveTypeLimits('UNSIGNED8')).toEqual(['0', '255'])
    expect(slaveTypeLimits('REAL32')).toBeNull()
  })
})
