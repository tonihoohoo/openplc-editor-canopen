import { readFileSync } from 'fs'
import { join } from 'path'

import type { CanopenConfig } from '../../../ports/canopen-types'
import {
  CANOPEN_LIBRARY_SYMBOLS,
  canopenNameProblems,
  canopenObjectSizes,
  canopenPlcNames,
  projectNamesForCanopen,
  serializeCanopenConstantsToST,
  withCanopenConstants,
} from '../plc-names'
import { canopenDevice, configWith, genericNode } from './fixtures/helpers'

const off = (config: CanopenConfig): CanopenConfig => ({ ...config, network: { ...config.network, enabled: false } })

describe('CANopen names as program constants', () => {
  const line1 = canopenDevice('line_1', configWith(genericNode(2), { ...genericNode(5), id: 'n5', name: 'valve' }))
  const line2 = canopenDevice('line_2', configWith({ ...genericNode(3), id: 'n3', name: 'drive' }))
  const offLine = canopenDevice('spare', off(configWith({ ...genericNode(7), id: 'n7', name: 'spare_io' })))

  it('numbers the networks that are on from 1 and gives each node its ID', () => {
    expect(canopenPlcNames([line1, offLine, line2])).toEqual([
      { name: 'line_1', value: 1, kind: 'network', network: 'line_1' },
      { name: 'line_2', value: 2, kind: 'network', network: 'line_2' },
      { name: 'io2', value: 2, kind: 'node', network: 'line_1' },
      { name: 'valve', value: 5, kind: 'node', network: 'line_1' },
      { name: 'drive', value: 3, kind: 'node', network: 'line_2' },
    ])
  })

  it('declares them as a VAR_GLOBAL CONSTANT block, with the size table only for the library', () => {
    const st = serializeCanopenConstantsToST([line1], false)
    expect(st).toBe(
      'VAR_GLOBAL CONSTANT\n  line_1 : USINT := 1;\n  io2 : USINT := 2;\n  valve : USINT := 5;\nEND_VAR\n',
    )
    expect(serializeCanopenConstantsToST([], false)).toBe('')
    expect(serializeCanopenConstantsToST([offLine], false)).toBe('')
    const withTable = serializeCanopenConstantsToST([line1], true)
    expect(withTable).toContain('CANOPEN_OBJECT_SIZE_COUNT : UINT := ')
    expect(withTable).toMatch(/CANOPEN_OBJECT_SIZES : ARRAY\[0\.\.\d+\] OF ULINT := \[/)
  })

  it('declares an empty size table with one entry when the library is on and no network is', () => {
    expect(serializeCanopenConstantsToST(undefined, true)).toBe(
      'VAR_GLOBAL CONSTANT\n  CANOPEN_OBJECT_SIZE_COUNT : UINT := 0;\n' +
        '  CANOPEN_OBJECT_SIZES : ARRAY[0..0] OF ULINT := [\n    16#000000000000];\nEND_VAR\n',
    )
  })

  it('lists the EDS objects of 1 to 4 bytes, sorted, with their sizes', () => {
    const sizes = canopenObjectSizes([line1])
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes)
    const find = (node: number, index: number, sub: number): number | undefined => {
      const key = (1 * 2 ** 8 + node) * 2 ** 32 + index * 2 ** 16 + sub * 2 ** 8
      const entry = sizes.find((e) => Math.floor(e / 256) === key / 256)
      return entry === undefined ? undefined : entry % 256
    }
    expect(find(2, 0x1017, 0)).toBe(2) // UNSIGNED16
    expect(find(2, 0x1000, 0)).toBe(4) // UNSIGNED32
    expect(find(2, 0x6000, 1)).toBe(1) // UNSIGNED8
    expect(find(5, 0x1017, 0)).toBe(2)
    expect(find(2, 0x1008, 0)).toBeUndefined() // a string
  })

  it('appends the constants to the program, leaving a project without them unchanged', () => {
    const program = 'PROGRAM main\nEND_PROGRAM\n'
    expect(withCanopenConstants(program, { remoteDevices: [], libraries: [] })).toBe(program)
    const out = withCanopenConstants(program, { remoteDevices: [line1], libraries: [{ name: 'canopen' }] })
    expect(out.startsWith(program)).toBe(true)
    expect(out).toContain('io2 : USINT := 2;')
    expect(out).toContain('CANOPEN_OBJECT_SIZES')
  })

  describe('name checks', () => {
    it('accepts distinct identifiers', () => {
      expect(canopenNameProblems([line1, line2], [{ name: 'motor', kind: 'global variable' }])).toEqual([])
    })

    it('refuses a name that is not an identifier', () => {
      const bad = canopenDevice('line_1', configWith({ ...genericNode(2), name: '2nd io' }))
      expect(canopenNameProblems([bad], [])).toEqual([
        'CANopen "line_1" node "2nd io": the name must be letters, digits and underscores, not starting with a digit',
      ])
    })

    it('refuses the same name in two networks, ignoring case', () => {
      const other = canopenDevice('line_2', configWith({ ...genericNode(3), name: 'IO2' }))
      expect(canopenNameProblems([line1, other], [])).toEqual([
        'CANopen "line_2" node "IO2": the name is also used by CANopen "line_1" node "io2"; a program reaches both by name',
      ])
    })

    it('refuses a name the project or the library uses', () => {
      const stopped = canopenDevice('line_1', configWith({ ...genericNode(2), name: 'stopped' }))
      expect(canopenNameProblems([stopped], [{ name: 'LINE_1', kind: 'POU' }])).toEqual([
        'CANopen network "line_1": the name is also the POU "LINE_1"; a program reaches the node or network by name',
        'CANopen "line_1" node "stopped": the name is also "STOPPED" of the canopen library; a program reaches the node or network by name',
      ])
    })

    it('refuses an enumeration value of the project', () => {
      const red = canopenDevice('line_1', configWith({ ...genericNode(2), name: 'Red' }))
      const names = projectNamesForCanopen(
        [{ name: 'motor' }],
        ['main'],
        [
          { name: 'COLOUR', derivation: 'enumerated', values: [{ description: 'red' }, { description: 'green' }] },
          { name: 'SPEED', derivation: 'structure' },
        ],
      )
      expect(names.map((n) => `${n.kind}:${n.name}`)).toEqual([
        'global variable:motor',
        'POU:main',
        'data type:COLOUR',
        'enumeration value:red',
        'enumeration value:green',
        'data type:SPEED',
      ])
      expect(canopenNameProblems([red], names)).toEqual([
        'CANopen "line_1" node "Red": the name is also the enumeration value "red"; a program reaches the node or network by name',
      ])
    })

    it('skips networks that are off', () => {
      const bad = canopenDevice('spare', off(configWith({ ...genericNode(2), name: 'NMT' })))
      expect(canopenNameProblems([bad], [])).toEqual([])
    })

    it('knows every name the shipped library declares', () => {
      const archive = JSON.parse(
        readFileSync(
          join(__dirname, '..', '..', '..', '..', '..', '..', 'resources', 'libraries', 'canopen.stlib'),
          'utf8',
        ),
      ) as { manifest: Record<'functions' | 'functionBlocks' | 'types' | 'globals', Array<{ name: string }>> }
      const declared = (['functions', 'functionBlocks', 'types', 'globals'] as const).flatMap((k) =>
        archive.manifest[k].map((e) => e.name.toUpperCase()),
      )
      expect(declared.filter((n) => !CANOPEN_LIBRARY_SYMBOLS.includes(n))).toEqual([])
    })
  })
})
