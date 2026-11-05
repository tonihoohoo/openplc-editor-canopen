import { parseCanopenStatus } from '../../../ports/canopen-status'
import type { CanopenConfig, CanopenNode } from '../../../ports/canopen-types'
import { checkCanopenNetwork, checkText, fixAllCanopenProblems } from '../check-fix'
import { writeEds, writeXdd } from '../device-writer'
import { eventText, lssProblemShort, lssResultText } from '../diagnostics'
import { parseEds } from '../eds-parser'
import { parseXdd } from '../xdd-parser'
import { generateCanopenConfig } from '../generate-canopen-config'
import { validateCanopenProject } from '../validate-canopen-config'
import { canopenDevice, configWith, GENERIC_IO_EDS, genericNode } from './fixtures/helpers'
import { sampleStatus } from './fixtures/status'

const LSS_EDS = GENERIC_IO_EDS.replace('LSS_Supported=0', 'LSS_Supported=1')

/** Node `id` of the generic module, its device file with LSS support, given its ID over LSS. */
function lssNode(id: number, serialNumber: number | null, revision = 0, store = false): CanopenNode {
  const node = genericNode(id)
  return {
    ...node,
    eds: { ...node.eds, lssSupported: true },
    lss: { enabled: true, serialNumber, revision, store },
  }
}

type Out = { networks: Array<{ nodes: Array<{ node_id: number; lss?: Record<string, unknown> }> }> }

const generated = (config: CanopenConfig): Out =>
  JSON.parse(generateCanopenConfig([canopenDevice('CANopen_1', config)]) ?? 'null') as Out

describe('LSS support in the device file', () => {
  it('is read from LSS_Supported and written back', () => {
    expect(parseEds(GENERIC_IO_EDS, 'a.eds').lssSupported).toBeUndefined()
    const eds = parseEds(LSS_EDS, 'a.eds')
    expect(eds.lssSupported).toBe(true)
    const now = new Date(Date.UTC(2026, 10, 5))
    expect(writeEds(eds, { fileName: 'b.eds', now })).toContain('LSS_Supported=1')
    const xdd = writeXdd(eds, { fileName: 'b.xdd', now })
    expect(xdd).toContain('layerSettingServiceSlave="true"')
    expect(parseXdd(xdd, 'b.xdd').eds.lssSupported).toBe(true)
  })
})

describe('the lss object in conf/canopen.json', () => {
  it('holds the device file identity, the serial number, revision and store', () => {
    const out = generated(configWith(genericNode(2), lssNode(3, 0x1234, 0, false)))
    expect(out.networks[0].nodes[0].lss).toBeUndefined()
    expect(out.networks[0].nodes[1].lss).toEqual({
      vendor_id: 1,
      product_code: 2,
      revision: 0,
      serial_number: 4660,
      store: false,
    })
  })

  it('is left out when the node is back to set on the device, keeping the serial number', () => {
    const node = lssNode(3, 0x1234, 7, true)
    const off = { ...node, lss: { enabled: false, serialNumber: 0x1234, revision: 7, store: true } }
    expect(off.lss.serialNumber).toBe(0x1234)
    expect(generated(configWith(off)).networks[0].nodes[0].lss).toBeUndefined()
  })
})

describe('LSS checks before build', () => {
  const errors = (config: CanopenConfig): string[] =>
    checkCanopenNetwork(config, null)
      .filter((c) => c.level === 'error')
      .map(checkText)

  it('needs a serial number that is not 0', () => {
    expect(errors(configWith(lssNode(3, null)))).toContain(
      'node 3 (io3): gets its node ID over LSS but has no serial number',
    )
    expect(errors(configWith(lssNode(3, 0)))).toContain(
      'node 3 (io3): gets its node ID over LSS but has no serial number',
    )
    expect(errors(configWith(lssNode(3, 0x1234)))).toEqual([])
    const project = validateCanopenProject([canopenDevice('CANopen_1', configWith(lssNode(3, null)))])
    expect(project.some((p) => p.includes('node 3 (io3)') && p.includes('serial number'))).toBe(true)
  })

  it('needs LSS support in the device file, and turns LSS off as its fix', () => {
    const node = { ...lssNode(3, 0x1234), eds: genericNode(3).eds }
    const config = configWith(node)
    const problem = checkCanopenNetwork(config, null).find((c) => c.text.includes('does not list LSS support'))
    expect(problem?.nodeId).toBe(node.id)
    expect(problem?.fix?.label).toBe('Set the node ID on the device')
    const fixed = fixAllCanopenProblems(config, null)
    expect(fixed.nodes[0].lss).toEqual({ enabled: false, serialNumber: 0x1234, revision: 0, store: false })
  })

  it('refuses two nodes with one LSS address, naming both', () => {
    const list = errors(configWith(lssNode(3, 0x1234), lssNode(4, 0x1234)))
    expect(list).toEqual([
      'node 4 (io4): has the same LSS address as node 3 (io3) (vendor ID, product code, revision and serial number 0x00001234)',
    ])
    expect(errors(configWith(lssNode(3, 0x1234), lssNode(4, 0x1234, 5)))).toEqual([])
  })
})

describe('LSS in the status', () => {
  const status = (lss: unknown, events: unknown[] = []) => {
    const body = sampleStatus()
    const net = body.networks[0] as unknown as { nodes: Array<Record<string, unknown>>; events: unknown[] }
    net.nodes[1].lss = lss
    net.events = events
    return parseCanopenStatus(body)
  }

  it('reads the result and events', () => {
    const parsed = status({ result: 'given', previous_id: 255, stored: false, time: 1 }, [
      { time: 1, node: 3, kind: 'lss', lss: { result: 'given', previous_id: 255, stored: false, time: 1 } },
    ])
    expect(parsed?.networks[0].nodes[1].lss?.result).toBe('given')
    expect(parsed?.networks[0].nodes[0].lss).toBeUndefined()
    const event = parsed?.networks[0].events[0]
    expect(event && eventText(event)).toBe('Node ID 3 given (device had none); not stored.')
  })

  it('says what happened in words', () => {
    expect(lssResultText({ result: 'given', previous_id: 7, stored: true }, 3)).toBe(
      'Node ID 3 given (device had 7); stored.',
    )
    expect(lssResultText({ result: 'already', previous_id: 3, stored: false }, 3)).toBe(
      'The device already had node ID 3.',
    )
    expect(
      lssResultText({ result: 'not_found' }, 3, { vendorId: 0xab, productCode: 0x1001, serialNumber: 0x1234 }),
    ).toBe(
      'No device with vendor 0x000000AB, product 0x00001001, serial 0x00001234 answered. Check the serial number and the cabling.',
    )
    expect(lssResultText({ result: 'refused' }, 3)).toBe('The device refused node ID 3.')
    expect(lssResultText({ result: 'store_refused', stored: false }, 3)).toContain('refused to store it')
    expect(lssProblemShort({ result: 'not_found' })).toBe('LSS: no device answered')
    expect(lssProblemShort({ result: 'refused' })).toBe('LSS: node ID refused')
    expect(lssProblemShort({ result: 'given' })).toBeNull()
    expect(lssProblemShort(undefined)).toBeNull()
  })
})
