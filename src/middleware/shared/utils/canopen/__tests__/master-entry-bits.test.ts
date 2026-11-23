import type { CanopenConfig, CanopenEntry, CanopenNode } from '../../../ports/canopen-types'
import type { PLCVariable } from '../../../ports/types'
import { buildAddressPool } from '../../iec-address'
import { canopenPoolEntries } from '../../iec-address/address-pool'
import { buildDbc } from '../dbc-export'
import { findObject } from '../eds-parser'
import {
  aliasesDroppedBySwitch,
  canSplitEntry,
  entryBitNames,
  isSplitEntry,
  withBitNamesFrom,
  withEntryBits,
} from '../entry-bits'
import { generateCanopenConfig } from '../generate-canopen-config'
import { buildHtmlDocument, htmlSections, plcVariableUses } from '../html-export'
import { moveEntryToPdo, nodeEntries, placeholderAddress, updatePdo, withEntryAlias, withPdoExchanged } from '../model'
import { canopenNodeRemoval, variablesLocatedAt } from '../node-removal'
import { addressNewCanopenEntries, nextFreeBytes } from '../stable-addresses'
import { validateCanopenProject } from '../validate-canopen-config'
import { canopenDevice, configWith, genericIoEds, genericNode } from './fixtures/helpers'

const CAPS = { pinMapping: false, vppIo: false, modbusTcpRemote: false, ethercat: true }

/** Node 2 with its first input (0x6000:1 at %IB1) switched to bits, the bits placed from `pool`. */
function splitInput(node: CanopenNode = genericNode(2)): { before: CanopenConfig; after: CanopenConfig } {
  const before = configWith(node)
  const entry = node.tpdos[0].entries[0]
  const split = updatePdo(node, 'input', 1, (p) => ({
    ...p,
    entries: p.entries.map((e) => (e === entry ? withEntryBits(node.eds, e, true, '%IX', '%IB') : e)),
  }))
  const pool = buildAddressPool({ remoteDevices: [canopenDevice('net', before)] }, CAPS)
  return { before, after: addressNewCanopenEntries(before, configWith(split), pool) }
}

const variable = (name: string, location: string): PLCVariable => ({
  name,
  type: { definition: 'base-type', value: 'bool' },
  location,
  documentation: '',
})

const firstInput = (config: CanopenConfig): CanopenEntry => config.nodes[0].tpdos[0].entries[0]

describe('withEntryBits', () => {
  it('splits an UNSIGNED8 into 8 named bits and drops its own address and alias', () => {
    const node = withEntryAlias(genericNode(2), genericNode(2).tpdos[0].entries[0].channelId, 'inputs')
    const entry = node.tpdos[0].entries[0]
    const split = withEntryBits(node.eds, entry, true, '%IX', '%IB')
    expect(isSplitEntry(split)).toBe(true)
    expect(split.iecLocation).toBe('')
    expect(split.alias).toBeUndefined()
    expect(split.bits?.map((b) => b.name)).toEqual(Array.from({ length: 8 }, (_, i) => `Bit ${i}`))
    expect(split.bits?.[3].channelId).toBe(`${entry.channelId}.3`)
    expect(aliasesDroppedBySwitch(entry)).toEqual(['inputs'])

    const whole = withEntryBits(
      node.eds,
      { ...split, bits: split.bits?.map((b) => ({ ...b, alias: 'x' })) },
      false,
      '%IX',
      '%IB',
    )
    expect(whole.bits).toBeUndefined()
    expect(whole.iecLocation).toBe('%IB0')
  })

  it('names bits from the device file, a wider field with its offset', () => {
    const eds = genericIoEds()
    const object = findObject(eds, 0x6000, 1)
    if (!object) throw new Error('fixture has no 0x6000:1')
    object.info = {
      bits: [
        { value: '0', label: 'Emergency stop' },
        { value: '1', label: 'Enable' },
        { value: '4', label: 'Mode', width: 2 },
      ],
    }
    expect(entryBitNames(eds, { index: 0x6000, subIndex: 1, dataType: 'UNSIGNED8' })).toEqual([
      'Emergency stop',
      'Enable',
      'Bit 2',
      'Bit 3',
      'Mode 0',
      'Mode 1',
      'Bit 6',
      'Bit 7',
    ])
    const entry = withEntryBits(genericIoEds(), genericNode(2).tpdos[0].entries[0], true, '%IX', '%IB')
    expect(withBitNamesFrom(eds, entry).bits?.[1].name).toBe('Enable')
  })

  it('is offered for UNSIGNED8/16/32 entries of an exchanged PDO only', () => {
    const node = genericNode(2)
    const [byte, int16] = node.tpdos[0].entries
    expect(canSplitEntry(node.eds, node.tpdos[0], byte)).toBe(true)
    expect(canSplitEntry(node.eds, node.tpdos[0], int16)).toBe(false)
    expect(canSplitEntry(node.eds, { ...node.tpdos[0], exchanged: false }, byte)).toBe(false)
  })
})

describe('addresses of bits', () => {
  it('frees the byte and gives the bits the first whole free %IX byte, moving nothing else', () => {
    const { before, after } = splitInput()
    const entry = firstInput(after)
    expect(entry.iecLocation).toBe('')
    expect(entry.bits?.map((b) => b.iecLocation)).toEqual(Array.from({ length: 8 }, (_, i) => `%IX0.${i}`))
    const others = (c: CanopenConfig) =>
      nodeEntries(c.nodes[0])
        .filter((e) => !e.iecLocation.startsWith('%IX'))
        .map((e) => e.iecLocation)
    expect(others(after)).toEqual(others(before).filter((a) => a !== '%IB1'))
  })

  it('keeps placed bits and gives the entry one address again when switched off', () => {
    const { after } = splitInput()
    const pool = buildAddressPool({ remoteDevices: [canopenDevice('net', after)] }, CAPS)
    expect(addressNewCanopenEntries(after, after, pool)).toEqual(after)
    const node = after.nodes[0]
    const off = updatePdo(node, 'input', 1, (p) => ({
      ...p,
      entries: p.entries.map((e, i) => (i === 0 ? withEntryBits(node.eds, e, false, '%IX', '%IB') : e)),
    }))
    const back = firstInput(addressNewCanopenEntries(after, configWith(off), pool))
    expect(back.bits).toBeUndefined()
    expect(back.iecLocation).toMatch(/^%IB\d+$/)
  })

  it('takes consecutive free bytes for 16 and 32 bits', () => {
    const pool = buildAddressPool({}, CAPS)
    expect(nextFreeBytes(pool, '%QX', 2, new Set(['%QX1.0']))).toBe(2)
    expect(nextFreeBytes(pool, '%QX', 4, new Set(['%QX4.7']))).toBe(0)
    expect(nextFreeBytes(pool, '%QX', 4, new Set(['%QX2.7']))).toBe(3)
  })

  it('claims one pool channel per bit', () => {
    const { after } = splitInput()
    const channels = canopenPoolEntries(after.nodes[0]).map((e) => e.channelId)
    const id = firstInput(after).channelId
    expect(channels).toContain(`${id}.7`)
    expect(channels).not.toContain(id)
  })
})

describe('bits in the model', () => {
  it('sets a bit alias by its channel', () => {
    const { after } = splitInput()
    const id = firstInput(after).channelId
    const node = withEntryAlias(after.nodes[0], `${id}.1`, 'enable_switch')
    expect(node.tpdos[0].entries[0].bits?.[1].alias).toBe('enable_switch')
    expect(nodeEntries(node).some((e) => e.alias === 'enable_switch')).toBe(true)
  })

  it('drops the bits when the PDO is no longer exchanged, and keeps them across a move', () => {
    const { after } = splitInput()
    const pdo = withPdoExchanged(after.nodes[0].tpdos[0], 'input', false, placeholderAddress)
    expect(pdo.entries[0].bits).toBeUndefined()
    expect(pdo.entries[0].iecLocation).toBe('')
    const kept = withPdoExchanged(after.nodes[0].tpdos[0], 'input', true, placeholderAddress)
    expect(kept.entries[0]).toEqual(firstInput(after))
    const node = moveEntryToPdo(after.nodes[0], 'input', 1, 1, firstInput(after).channelId, placeholderAddress)
    expect(node).toBe(after.nodes[0])
  })

  it('counts variables at bit aliases as located on the node', () => {
    const { after } = splitInput()
    const id = firstInput(after).channelId
    const node = withEntryAlias(after.nodes[0], `${id}.2`, 'valve_3')
    const removal = canopenNodeRemoval(node, [variable('v', 'valve_3')], [])
    expect(removal.locatedVariables).toEqual(['v'])
    expect(variablesLocatedAt(['valve_3'], [], [])).toEqual([])
  })
})

describe('bits in the runtime configuration and checks', () => {
  it('writes the bit locations instead of a location, at format 14', () => {
    const { after } = splitInput()
    const json = JSON.parse(generateCanopenConfig([canopenDevice('net', after)]) ?? '') as {
      version: number
      networks: Array<{ nodes: Array<{ tpdos: Array<{ entries: Array<Record<string, unknown>> }> }> }>
    }
    expect(json.version).toBe(14)
    const entry = json.networks[0].nodes[0].tpdos[0].entries[0]
    expect(entry).toEqual({
      index: 0x6000,
      subindex: 1,
      type: 'UNSIGNED8',
      bits: Array.from({ length: 8 }, (_, i) => `%IX0.${i}`),
    })
  })

  it('accepts placed bits and refuses a wrong area or a doubled input bit', () => {
    const { after } = splitInput()
    expect(validateCanopenProject([canopenDevice('net', after)])).toEqual([])
    const bad = structuredClone(after)
    const bits = firstInput(bad).bits ?? []
    bits[0].iecLocation = '%QX9.0'
    bits[2].iecLocation = bits[1].iecLocation
    const errors = validateCanopenProject([canopenDevice('net', bad)])
    expect(errors.some((e) => e.includes('needs a %IX address, has "%QX9.0"'))).toBe(true)
    expect(errors.some((e) => e.includes(`${bits[1].iecLocation} is also written by`))).toBe(true)
  })
})

describe('bits in the exports', () => {
  it('makes one 1-bit DBC signal per bit, named by its alias', () => {
    const { after } = splitInput()
    const id = firstInput(after).channelId
    const config = configWith(withEntryAlias(after.nodes[0], `${id}.0`, 'estop_ok'))
    const dbc = buildDbc(config, { networkName: 'n' }).text
    const line = dbc.split('\r\n').find((l) => l.startsWith(' SG_ estop_ok '))
    expect(line).toMatch(/: 0\|1@1\+/)
    expect(dbc).toContain('BA_ "IecLocation" SG_ 386 estop_ok "%IX0.0";')
    expect(dbc.split('\r\n').filter((l) => / SG_ \w+_Bit_\d /.test(l))).toHaveLength(7)
  })

  it('lists each bit address in the HTML I/O list with its variables', () => {
    const { after } = splitInput()
    const id = firstInput(after).channelId
    const config = configWith(withEntryAlias(after.nodes[0], `${id}.5`, 'door_closed'))
    const html = buildHtmlDocument({
      projectName: 'p',
      networkName: 'n',
      config,
      uses: plcVariableUses([{ pou: 'main', variables: [{ name: 'door', location: 'door_closed' }] }]),
      sections: htmlSections(undefined),
      editorVersion: '1.0.0',
      now: new Date('2026-11-23T10:00:00Z'),
    })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const row = Array.from(doc.querySelectorAll('#io ~ table tr')).find((tr) => tr.textContent?.includes('%IX0.5'))
    expect(row?.textContent).toContain('door_closed')
    expect(row?.textContent).toContain('BOOL')
    expect(row?.textContent).toContain('main.door')
  })
})
