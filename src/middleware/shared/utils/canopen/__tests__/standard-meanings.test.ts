import type { CanopenObject } from '../../../ports/canopen-types'
import { objectInfo, standardInfo, standardValueMeaning } from '../standard-meanings'

const object = (index: number, subIndex: number, extra: Partial<CanopenObject> = {}): CanopenObject => ({
  index,
  subIndex,
  name: 'x',
  dataType: 'UNSIGNED32',
  access: 'rw',
  pdoMapping: false,
  ...extra,
})

describe('standard meanings', () => {
  it.each([
    [0x1000, 0, 'CiA 301'],
    [0x1003, 0, 'CiA 301'],
    [0x1003, 2, 'CiA 301'],
    [0x1010, 1, 'CiA 301'],
    [0x1011, 4, 'CiA 301'],
    [0x1016, 1, 'CiA 301'],
    [0x1018, 3, 'CiA 301'],
    [0x1028, 1, 'CiA 301'],
    [0x1029, 1, 'CiA 301'],
    [0x1200, 1, 'CiA 301'],
    [0x1280, 2, 'CiA 301'],
    [0x1280, 3, 'CiA 301'],
    [0x1400, 1, 'CiA 301'],
    [0x1400, 2, 'CiA 301'],
    [0x1400, 5, 'CiA 301'],
    [0x1800, 1, 'CiA 301'],
    [0x1800, 3, 'CiA 301'],
    [0x1800, 5, 'CiA 301'],
    [0x1800, 6, 'CiA 301'],
    [0x1600, 0, 'CiA 301'],
    [0x1a00, 2, 'CiA 301'],
    [0x6000, 2, 'CiA 401'],
    [0x6200, 1, 'CiA 401'],
    [0x6005, 0, 'CiA 401'],
    [0x6421, 1, 'CiA 401'],
    [0x6423, 0, 'CiA 401'],
  ])('knows index %d sub %d from %s', (index, sub, source) => {
    expect(standardInfo(index, sub)?.source).toBe(source)
  })

  it.each([
    [0x1018, 1],
    [0x1400, 3],
    [0x1400, 6],
    [0x1800, 4],
    [0x1200, 3],
    [0x6000, 0],
    [0x6005, 1],
    [0x6423, 1],
    [0x2000, 0],
    [0xa000, 0],
  ])('has nothing for index %d sub %d', (index, sub) => {
    expect(standardInfo(index, sub)).toBeUndefined()
  })

  it('names the bits of the outputs by sub-index', () => {
    expect(standardInfo(0x6200, 2)?.info.bits?.[7]).toEqual({ value: '7', label: 'Output 16' })
  })

  it('lets the file win and adds only what it lacks', () => {
    expect(objectInfo(undefined)).toBeUndefined()
    expect(objectInfo(object(0x2000, 0, { info: { label: 'Own' } }))).toEqual({ label: 'Own' })
    const own = { description: 'Own', bits: [{ value: '0', label: 'Mine' }] }
    expect(objectInfo(object(0x1001, 0, { info: own }))).toEqual(own)
    const shown = objectInfo(object(0x1017, 0, { info: { unit: 's' } }))
    expect(shown?.unit).toBe('s')
    expect(shown?.standard).toBe('CiA 301')
    expect(objectInfo(object(0x1001, 0))?.standard).toBe('CiA 301')
  })

  it('gives the meaning of synchronous and reserved transmission types', () => {
    expect(standardValueMeaning(object(0x1800, 2), 3)).toBe('Synchronous, every 3 SYNCs')
    expect(standardValueMeaning(object(0x1400, 2), 245)).toBe('Reserved')
    expect(standardValueMeaning(object(0x1400, 2), 254)).toBeUndefined()
    expect(standardValueMeaning(object(0x1400, 1), 3)).toBeUndefined()
    expect(standardValueMeaning(object(0x2000, 2), 3)).toBeUndefined()
    expect(standardValueMeaning(undefined, 3)).toBeUndefined()
    expect(
      standardValueMeaning(object(0x1800, 2, { info: { values: [{ value: '3', label: 'Own' }] } }), 3),
    ).toBeUndefined()
  })
})
