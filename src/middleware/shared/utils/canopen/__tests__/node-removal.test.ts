import type { CanopenNode } from '../../../ports/canopen-types'
import type { PLCPou, PLCVariable } from '../../../ports/types'
import { canopenNodeRemoval, canopenNodeRemovalText } from '../node-removal'
import { genericNode } from './fixtures/helpers'

const variable = (name: string, location: string): PLCVariable => ({
  name,
  location,
  type: { definition: 'base-type', value: 'byte' },
  documentation: '',
})

const pou = (name: string, variables: PLCVariable[]): PLCPou => ({
  name,
  pouType: 'program',
  interface: { variables },
  body: { language: 'st', value: '' },
})

const withAlias = (node: CanopenNode, alias: string): CanopenNode => ({
  ...node,
  tpdos: node.tpdos.map((p, i) =>
    i === 0 ? { ...p, entries: p.entries.map((e, j) => (j === 0 ? { ...e, alias } : e)) } : p,
  ),
})

const unmapped = (node: CanopenNode): CanopenNode => ({
  ...node,
  tpdos: node.tpdos.map((p) => ({ ...p, exchanged: false })),
  rpdos: node.rpdos.map((p) => ({ ...p, exchanged: false })),
})

describe('what goes with a removed CANopen node', () => {
  const node = genericNode(2)
  const address = node.tpdos[0].entries[0].iecLocation

  it('counts the mapped values and startup SDOs of the node', () => {
    const removal = canopenNodeRemoval(node, [], [])
    expect(removal.mappedValues).toBe(3)
    expect(removal.startupSdos).toBe(0)
    expect(removal.locatedVariables).toEqual([])
  })

  it('finds global and POU variables at an alias or a literal address of the node', () => {
    const aliased = withAlias(node, 'level_in')
    const removal = canopenNodeRemoval(
      aliased,
      [variable('level', 'level_in'), variable('elsewhere', '%IB99')],
      [pou('main', [variable('raw', address.toLowerCase()), variable('free', '')])],
    )
    expect(removal.locatedVariables).toEqual(['level', 'main.raw'])
  })

  it('counts the state channel as one of the node addresses', () => {
    const removal = canopenNodeRemoval(node, [variable('state', node.state.iecLocation)], [])
    expect(removal.locatedVariables).toEqual(['state'])
  })

  it('leaves PDOs the master does not exchange out of the mapped values', () => {
    expect(canopenNodeRemoval(unmapped(node), [], []).mappedValues).toBe(0)
  })
})

describe('the sentence in the removal confirmation', () => {
  const text = (mappedValues: number, startupSdos: number, variables: number) =>
    canopenNodeRemovalText({
      mappedValues,
      startupSdos,
      locatedVariables: Array.from({ length: variables }, (_, i) => `v${i}`),
    })

  it('names every part that is not empty', () => {
    expect(text(3, 2, 3)).toBe('Its PDO mapping, 2 startup SDOs and the location of 3 PLC variables go with it.')
    expect(text(3, 1, 1)).toBe('Its PDO mapping, 1 startup SDO and the location of 1 PLC variable go with it.')
    expect(text(3, 0, 2)).toBe('Its PDO mapping and the location of 2 PLC variables go with it.')
  })

  it('agrees with a single part', () => {
    expect(text(3, 0, 0)).toBe('Its PDO mapping goes with it.')
    expect(text(0, 1, 0)).toBe('Its 1 startup SDO goes with it.')
    expect(text(0, 2, 0)).toBe('Its 2 startup SDOs go with it.')
    expect(text(0, 0, 2)).toBe('The location of 2 PLC variables goes with it.')
  })

  it('is null when there is nothing to name', () => {
    expect(text(0, 0, 0)).toBeNull()
  })
})
