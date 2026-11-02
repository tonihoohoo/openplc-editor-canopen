import { checkCanopenNetwork } from '../check-fix'
import { parseEds } from '../eds-parser'
import { generateCanopenConfig } from '../generate-canopen-config'
import { createCanopenNode, gapPieces } from '../model'
import { canopenDevice, configWith, GENERIC_IO_EDS, sequentialAllocator } from './fixtures/helpers'

const COUNTER =
  '\n[2300]\nParameterName=Counter\nObjectType=0x7\nDataType=0x0016\nAccessType=ro\nDefaultValue=0\nPDOMapping=1\n'

/** TPDO 1 maps a 24-bit counter, then the 8-bit inputs; read-only when `fixed`. */
function counterNode(fixed: boolean) {
  let text = GENERIC_IO_EDS.replace('DefaultValue=0x60000108', 'DefaultValue=0x23000018').replace(
    'DefaultValue=0x64010110',
    'DefaultValue=0x60000108',
  )
  text = text.replace(/(\[ManufacturerObjects\]\nSupportedObjects=)(\d+)/, (_m, head: string, n: string) => {
    const count = Number(n) + 1
    return `${head}${count}\n${count}=0x2300`
  })
  if (fixed) text = text.replace(/(\[1A00sub[012]\][^[]*?AccessType=)rw/g, '$1ro')
  let id = 0
  return createCanopenNode(parseEds(text + COUNTER, 'counter.eds'), {
    id: 'node-2',
    name: 'io2',
    nodeId: 2,
    newId: () => `ch${++id}`,
    allocate: sequentialAllocator(),
  })
}

const tpdo1Out = (node: ReturnType<typeof counterNode>) => {
  const config = configWith(node)
  config.network.enabled = true
  const text = generateCanopenConfig([canopenDevice('net', config)])
  const json = JSON.parse(text ?? '{}') as {
    networks: Array<{ nodes: Array<{ tpdos: Array<{ entries: Array<{ index: number; type: string }> }> }> }>
  }
  return json.networks[0].nodes[0].tpdos[0].entries
}

describe('objects the master cannot read in a default mapping', () => {
  it('splits a length into gap pieces, largest first', () => {
    expect(gapPieces(24)).toEqual([6, 5])
    expect(gapPieces(3)).toEqual([1, 1, 1])
    expect(gapPieces(40)).toEqual([7, 5])
  })

  it('keeps a 24-bit object of a fixed mapping as gaps, so the input after it stays at bit 24', () => {
    const node = counterNode(true)
    const pdo = node.tpdos[0]
    expect(pdo.fixedMapping).toBe(true)
    expect(pdo.entries.map((e) => e.index)).toEqual([6, 5, 0x6000])
    expect(tpdo1Out(node).map((e) => [e.index, e.type])).toEqual([
      [6, 'UNSIGNED16'],
      [5, 'UNSIGNED8'],
      [0x6000, 'UNSIGNED8'],
    ])
    const warning = checkCanopenNetwork(configWith(node), null).find((p) => p.text.includes('0x2300'))
    expect(warning?.level).toBe('warning')
    expect(warning?.where).toBe('node 2 (io2) TPDO 1')
    expect(warning?.text).toMatch(/cannot read; its bits are kept as gaps/)
  })

  it('leaves it out of a writable mapping and says so', () => {
    const node = counterNode(false)
    expect(node.tpdos[0].entries.map((e) => e.index)).toEqual([0x6000])
    const warning = checkCanopenNetwork(configWith(node), null).find((p) => p.text.includes('0x2300'))
    expect(warning?.text).toMatch(/left out of the mapping the master writes/)
  })
})
