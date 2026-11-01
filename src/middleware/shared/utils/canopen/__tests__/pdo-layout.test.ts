import { readFileSync } from 'fs'
import { join } from 'path'

import type { CanopenEdsInfo, CanopenNode } from '../../../ports/canopen-types'
import { checkCanopenNetwork, freePdoCobId, pdoLinkPartners } from '../check-fix'
import { replaceDeviceFile } from '../device-import'
import { checkEds } from '../eds-check'
import { readEdsDocument } from '../eds-document'
import { parseEds } from '../eds-parser'
import { generateCanopenConfig, nodeConfigurationSdos } from '../generate-canopen-config'
import {
  addablePdoNumbers,
  cannotMoveEntry,
  cobIdBase,
  createCanopenNode,
  defaultNetworkSettings,
  edsPdoNumbers,
  moveEntryToPdo,
  placeholderAddress,
  removePdo,
  unswitchablePdoNumbers,
  withNodeId,
  withPdoExchanged,
} from '../model'
import { addPdo, cannotAddPdo } from '../pdo-layout'
import { canopenDevice, configWith, genericIoEds, genericNode } from './fixtures/helpers'

/** The generic EDS with copies of TPDO 1 and RPDO 1 as PDO 2 to `count`, their COB-IDs given as `cob(number)`. */
function edsWithPdos(count: number, cob: (direction: 'input' | 'output', number: number) => string): CanopenEdsInfo {
  const eds = genericIoEds()
  const extra = eds.objects.flatMap((o) => {
    const base = [0x1400, 0x1600, 0x1800, 0x1a00].find((b) => o.index === b)
    if (base === undefined) return []
    return Array.from({ length: count - 1 }, (_, k) => {
      const number = k + 2
      const copy = { ...o, index: base + number - 1 }
      if ((base === 0x1400 || base === 0x1800) && o.subIndex === 1)
        copy.defaultValue = cob(base === 0x1800 ? 'input' : 'output', number)
      if ((base === 0x1600 || base === 0x1a00) && o.subIndex === 0) copy.defaultValue = '0'
      return copy
    })
  })
  return { ...eds, objects: [...eds.objects, ...extra], rxPdoCount: count, txPdoCount: count }
}

function nodeFrom(eds: CanopenEdsInfo, nodeId = 2): CanopenNode {
  let id = 0
  return createCanopenNode(eds, {
    id: `node-${nodeId}`,
    name: `io${nodeId}`,
    nodeId,
    newId: () => `n${nodeId}-${++id}`,
    allocate: placeholderAddress,
  })
}

const invalid = () => '0x80000000'

describe('PDOs in use', () => {
  it('lists only the PDOs the file makes valid and that map an entry', () => {
    const node = nodeFrom(edsWithPdos(32, invalid))
    expect(edsPdoNumbers(node.eds, 'input')).toHaveLength(32)
    expect(node.tpdos.map((p) => p.number)).toEqual([1])
    expect(addablePdoNumbers(node, 'input')).toEqual(Array.from({ length: 31 }, (_, k) => k + 2))
  })

  it('adds the lowest unused PDO with a free COB-ID beyond the predefined set', () => {
    const node = nodeFrom(edsWithPdos(8, invalid))
    let config = configWith(node)
    for (let k = 0; k < 4; k++) config = addPdo(config, node.id, 'input', () => `x${k}`, placeholderAddress).config
    const tpdos = config.nodes[0].tpdos
    expect(tpdos.map((p) => p.number)).toEqual([1, 2, 3, 4, 5])
    expect(tpdos.slice(0, 4).map((p) => [p.cobId, p.followsNodeId])).toEqual([
      [0x182, true],
      [0x282, true],
      [0x382, true],
      [0x482, true],
    ])
    // 0x181 is free: the network has no node 1.
    expect(tpdos[4]).toMatchObject({ cobId: 0x181, followsNodeId: false, entries: [] })
  })

  it('takes the next free COB-ID when the low ones are in use', () => {
    const config = configWith(genericNode(2), genericNode(1))
    expect(freePdoCobId(config)).toBe(0x183)
  })

  it('says when no PDO is left to add', () => {
    const config = configWith(genericNode(2))
    expect(cannotAddPdo(config, 'node-2', 'input')).toBe('The device has no more TPDOs.')
    const removed = { ...config, nodes: [removePdo(config.nodes[0], 'input', 1)] }
    expect(cannotAddPdo(removed, 'node-2', 'input')).toBeNull()
    const added = addPdo(removed, 'node-2', 'input', () => 'y', placeholderAddress)
    expect(added.number).toBe(1)
    expect(added.config.nodes[0].tpdos[0].entries.map((e) => [e.index, e.subIndex])).toEqual([
      [0x6000, 1],
      [0x6401, 1],
    ])
  })

  it('switches a removed PDO off at boot with bit 31 of its COB-ID', () => {
    const node = removePdo(genericNode(2), 'output', 1)
    const writes = nodeConfigurationSdos(node, defaultNetworkSettings()).filter((w) => w.index === 0x1400)
    expect(writes).toEqual([{ index: 0x1400, subindex: 1, data: '02020080' }])
  })

  it('names valid PDOs the master cannot switch off', () => {
    const eds = edsWithPdos(
      2,
      (direction, number) => `$NODEID+0x${(direction === 'input' ? 0x280 : 0x300).toString(16)}`,
    )
    eds.objects = eds.objects.map((o) => (o.index === 0x1801 && o.subIndex === 1 ? { ...o, access: 'ro' } : o))
    const node = nodeFrom(eds)
    expect(unswitchablePdoNumbers(node, 'input')).toEqual([2])
    expect(unswitchablePdoNumbers(node, 'output')).toEqual([])
    expect(unswitchablePdoNumbers({ ...node, configure: false }, 'input')).toEqual([])
  })
})

describe('COB-IDs that follow the node ID', () => {
  it('shows node ID plus a base and moves for any PDO number', () => {
    const node = genericNode(2)
    const seven = { ...node.tpdos[0], number: 7, cobId: 0x282, followsNodeId: true }
    expect(cobIdBase(seven, 2)).toBe(0x280)
    const moved = withNodeId({ ...node, tpdos: [seven] }, 5)
    expect(moved.tpdos[0].cobId).toBe(0x285)
    expect(cobIdBase({ ...seven, followsNodeId: false }, 2)).toBeNull()
  })
})

describe('moving entries between PDOs', () => {
  const twoPdos = (): CanopenNode => {
    const eds = edsWithPdos(
      2,
      (direction, number) => `$NODEID+0x${(direction === 'input' ? 0x280 : 0x300).toString(16)}`,
    )
    const node = nodeFrom(eds)
    return {
      ...node,
      tpdos: [
        { ...node.tpdos[0], entries: node.tpdos[0].entries.map((e) => ({ ...e, alias: `a${e.subIndex}${e.index}` })) },
        { ...node.tpdos[0], number: 2, cobId: 0x282, entries: [] },
      ],
    }
  }

  it('keeps the address and alias', () => {
    const node = twoPdos()
    const entry = node.tpdos[0].entries[0]
    const moved = moveEntryToPdo(node, 'input', 1, 2, entry.channelId, placeholderAddress)
    expect(moved.tpdos[0].entries.map((e) => e.channelId)).not.toContain(entry.channelId)
    expect(moved.tpdos[1].entries).toEqual([entry])
  })

  it('refuses a full or fixed target and leaves the node as it is', () => {
    const node = twoPdos()
    const entry = node.tpdos[0].entries[1]
    const full = { ...node.tpdos[1], entries: Array.from({ length: 7 }, () => node.tpdos[0].entries[0]) }
    expect(cannotMoveEntry(full, entry)).toMatch(/at most 8 bytes/)
    expect(cannotMoveEntry({ ...node.tpdos[1], fixedMapping: true }, entry)).toMatch(/fixes the mapping/)
    const blocked = { ...node, tpdos: [node.tpdos[0], full] }
    expect(moveEntryToPdo(blocked, 'input', 1, 2, entry.channelId, placeholderAddress)).toBe(blocked)
  })

  it('gives up the address when the target is not exchanged', () => {
    const node = twoPdos()
    const target = withPdoExchanged(node.tpdos[1], 'input', false, placeholderAddress)
    const entry = node.tpdos[0].entries[0]
    const moved = moveEntryToPdo(
      { ...node, tpdos: [node.tpdos[0], target] },
      'input',
      1,
      2,
      entry.channelId,
      placeholderAddress,
    )
    expect(moved.tpdos[1].entries[0]).toMatchObject({ channelId: entry.channelId, iecLocation: '', alias: undefined })
  })
})

describe('PDOs the master does not exchange', () => {
  const linked = () => {
    const sender = genericNode(2)
    const receiver = genericNode(3)
    const rpdo = withPdoExchanged(
      { ...receiver.rpdos[0], cobId: 0x182, followsNodeId: false },
      'output',
      false,
      placeholderAddress,
    )
    return configWith(sender, { ...receiver, rpdos: [rpdo] })
  }

  it('writes the PDO to the node but leaves it out of the master PDO lists', () => {
    const config = linked()
    const writes = nodeConfigurationSdos(config.nodes[1], config.network).filter((w) => w.index === 0x1600)
    expect(writes.length).toBeGreaterThan(0)
    const text = generateCanopenConfig([canopenDevice('CANopen 1', config)])
    const json = JSON.parse(text ?? '{}') as { networks: Array<{ nodes: Array<{ rpdos: unknown[] }> }> }
    expect(json.networks[0].nodes[1].rpdos).toEqual([])
  })

  it('accepts one TPDO and its receivers on one COB-ID and names the link', () => {
    const config = linked()
    expect(checkCanopenNetwork(config, null).filter((c) => /same COB-ID/.test(c.text))).toEqual([])
    expect(pdoLinkPartners(config, 'node-2', 'input', config.nodes[0].tpdos[0])).toEqual(['node 3 (io3) RPDO 1'])
    expect(pdoLinkPartners(config, 'node-3', 'output', config.nodes[1].rpdos[0])).toEqual(['node 2 (io2) TPDO 1'])
  })

  it('reports the clash once the master exchanges the RPDO again', () => {
    const config = linked()
    const back = withPdoExchanged(config.nodes[1].rpdos[0], 'output', true, placeholderAddress)
    const again = { ...config, nodes: [config.nodes[0], { ...config.nodes[1], rpdos: [back] }] }
    expect(back.entries.every((e) => e.iecLocation.startsWith('%Q'))).toBe(true)
    expect(checkCanopenNetwork(again, null).some((c) => /same COB-ID 0x182/.test(c.text))).toBe(true)
  })

  it('warns about a receiver whose COB-ID no one sends', () => {
    const node = genericNode(3)
    const rpdo = withPdoExchanged(
      { ...node.rpdos[0], cobId: 0x2a5, followsNodeId: false },
      'output',
      false,
      placeholderAddress,
    )
    const checks = checkCanopenNetwork(configWith({ ...node, rpdos: [rpdo] }), null)
    expect(checks).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        where: 'node 3 (io3) RPDO 1',
        text: 'no node sends its COB-ID 0x2A5',
      }),
    )
  })
})

describe('replacing the device file', () => {
  it('keeps the mapping by default and resets it on request', () => {
    const node = genericNode(2)
    const named = {
      ...node,
      tpdos: [{ ...node.tpdos[0], entries: node.tpdos[0].entries.slice(0, 1).map((e) => ({ ...e, alias: 'in1' })) }],
    }
    const kept = replaceDeviceFile(named, genericIoEds(), () => 'r', placeholderAddress)
    expect(kept.node.tpdos[0].entries).toEqual(named.tpdos[0].entries)
    expect(kept.dropped).toEqual([])
    const reset = replaceDeviceFile(named, genericIoEds(), () => 'r', placeholderAddress, 'reset')
    expect(reset.node.tpdos[0].entries.map((e) => [e.index, e.subIndex, e.alias])).toEqual([
      [0x6000, 1, undefined],
      [0x6401, 1, undefined],
    ])
    expect(reset.dropped).toContainEqual({ what: '0x6000:01', detail: 'entry of TPDO 1, alias in1' })
  })
})

describe('the PDO layout UI test fixture', () => {
  it('passes the file check and starts with TPDO 1 and RPDO 1 in use', () => {
    const file = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'e2e',
      'fixtures',
      'canopen-pdo-layout',
      'multi-pdo-module.eds',
    )
    const text = readFileSync(file, 'utf8')
    expect(checkEds(readEdsDocument(text)).ok).toBe(true)
    const node = nodeFrom(parseEds(text, 'multi-pdo-module.eds'))
    expect([node.tpdos.map((p) => p.number), node.rpdos.map((p) => p.number)]).toEqual([[1], [1]])
    expect(addablePdoNumbers(node, 'input')).toEqual([2, 3, 4, 5, 6])
  })
})
