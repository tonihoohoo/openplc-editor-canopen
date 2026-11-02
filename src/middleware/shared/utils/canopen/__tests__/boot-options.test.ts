import type { CanopenNode, CanopenSdo } from '../../../ports/canopen-types'
import { checkCanopenNetwork } from '../check-fix'
import { toSdoDataType } from '../data-types'
import { parseEds } from '../eds-parser'
import { generateCanopenConfig, nodeBootWrites, rpdoSendPeriodMs } from '../generate-canopen-config'
import { createCanopenNode, defaultCanopenConfig, gapEntry, isGapEntry } from '../model'
import { encodeCanopenValue, toHex } from '../sdo-value'
import { jumpTargetProblem, validateCanopenProject } from '../validate-canopen-config'
import { canopenDevice, GENERIC_IO_EDS, genericNode, sequentialAllocator } from './fixtures/helpers'

/** The generic module with TPDO 1 mapping `second` between its two inputs. */
function nodeWithTpdoMapping(second: string): CanopenNode {
  const text = GENERIC_IO_EDS.replace(
    '[1A00sub0]\nParameterName=Number of mapped objects\nObjectType=0x7\nDataType=0x0005\nAccessType=rw\nDefaultValue=2',
    '[1A00sub0]\nParameterName=Number of mapped objects\nObjectType=0x7\nDataType=0x0005\nAccessType=rw\nDefaultValue=3',
  )
    .replace('DefaultValue=0x64010110\nPDOMapping=0', `DefaultValue=${second}\nPDOMapping=0`)
    .replace(
      '[2100]\n',
      '[1A00sub3]\nParameterName=Mapped object 3\nObjectType=0x7\nDataType=0x0007\nAccessType=rw\nDefaultValue=0x64010110\nPDOMapping=0\n\n[2100]\n',
    )
  let id = 0
  return createCanopenNode(parseEds(text, 'gap.eds'), {
    id: 'n2',
    name: 'io2',
    nodeId: 2,
    newId: () => `c${++id}`,
    allocate: sequentialAllocator(),
  })
}

function runtimeNode(node: CanopenNode): {
  tpdos: Array<{ entries: Array<Record<string, unknown>> }>
  rpdos: Array<{ send_period_ms?: number }>
  sdo: Array<Record<string, unknown>>
} {
  const config = { ...defaultCanopenConfig(), nodes: [node] }
  const text = generateCanopenConfig([canopenDevice('CANopen_1', config)], 10000) ?? '{}'
  return JSON.parse(text).networks[0].nodes[0]
}

describe('values of startup SDOs', () => {
  it('reads a hexadecimal REAL as its bit pattern', () => {
    const one = encodeCanopenValue('REAL32', '0x3F800000')
    expect(one.ok && toHex(one.bytes)).toBe('0000803F')
    const decimal = encodeCanopenValue('REAL32', '1')
    expect(decimal.ok && toHex(decimal.bytes)).toBe('0000803F')
    expect(encodeCanopenValue('REAL32', '0x1FFFFFFFF').ok).toBe(false)
  })

  it('writes text and bytes, from 1 to 1024 bytes', () => {
    const text = encodeCanopenValue('VISIBLE_STRING', 'Line 3')
    expect(text.ok && text.bytes).toEqual([0x4c, 0x69, 0x6e, 0x65, 0x20, 0x33])
    const bytes = encodeCanopenValue('OCTET_STRING', '01 a2 FF')
    expect(bytes.ok && bytes.bytes).toEqual([0x01, 0xa2, 0xff])
    expect(encodeCanopenValue('DOMAIN', 'abc')).toMatchObject({ ok: false })
    expect(encodeCanopenValue('VISIBLE_STRING', '')).toMatchObject({ ok: false })
    expect(encodeCanopenValue('VISIBLE_STRING', 'ä')).toMatchObject({ ok: false })
    expect(encodeCanopenValue('OCTET_STRING', '00'.repeat(1025))).toMatchObject({
      ok: false,
      message: expect.stringContaining('1024') as unknown,
    })
  })

  it('maps EDS type codes of strings and domains to startup SDO types', () => {
    expect(['0x0009', '0x000A', '0x000F', 'DOMAIN', 'UNSIGNED8', '0x0010'].map(toSdoDataType)).toEqual([
      'VISIBLE_STRING',
      'OCTET_STRING',
      'DOMAIN',
      'DOMAIN',
      'UNSIGNED8',
      undefined,
    ])
  })
})

describe('gaps in default mappings', () => {
  it('keeps a dummy entry as a gap, so the later entries keep their offsets', () => {
    const node = nodeWithTpdoMapping('0x00050008')
    const tpdo = node.tpdos[0]
    expect(tpdo.entries.map((e) => [e.index, e.dataType, e.iecLocation])).toEqual([
      [0x6000, 'UNSIGNED8', '%IB1'],
      [5, 'UNSIGNED8', ''],
      [0x6401, 'INTEGER16', '%IW0'],
    ])
    expect(isGapEntry(node.eds, tpdo.entries[1])).toBe(true)
    expect(runtimeNode(node).tpdos[0].entries).toEqual([
      { index: 0x6000, subindex: 1, type: 'UNSIGNED8', location: '%IB1' },
      { index: 5, subindex: 0, type: 'UNSIGNED8' },
      { index: 0x6401, subindex: 1, type: 'INTEGER16', location: '%IW0' },
    ])
    expect(checkCanopenNetwork({ ...defaultCanopenConfig(), nodes: [node] }, null)).toEqual([])
  })

  it('keeps an object the file does not describe as a gap of its size, with a warning', () => {
    const node = nodeWithTpdoMapping('0x5FFF0110')
    const entry = node.tpdos[0].entries[1]
    expect([entry.index, entry.subIndex, entry.dataType, entry.iecLocation]).toEqual([0x5fff, 1, 'UNSIGNED16', ''])
    const out = runtimeNode(node)
    expect(out.tpdos[0].entries[1]).toEqual({ index: 6, subindex: 0, type: 'UNSIGNED16' })
    // The node keeps its own mapping.
    expect(out.sdo).toContainEqual({ index: 0x1a00, subindex: 2, data: '1001FF5F' })
    expect(checkCanopenNetwork({ ...defaultCanopenConfig(), nodes: [node] }, null)).toEqual([
      expect.objectContaining({
        level: 'warning',
        where: 'node 2 (io2) TPDO 1',
        text: expect.stringContaining('0x5FFF:01, which the device file does not describe') as unknown,
      }),
    ])
  })
})

describe('refusal policies', () => {
  const sdo = (id: string, subIndex: number, extra: Partial<CanopenSdo> = {}): CanopenSdo => ({
    id,
    index: 0x2200,
    subIndex,
    dataType: 'UNSIGNED32',
    value: String(subIndex),
    ...extra,
  })

  it('translates continue and jump into the list of boot writes', () => {
    const node = genericNode(2)
    node.sdos = [
      sdo('a', 1, { onAbort: 'continue' }),
      sdo('b', 2, { onAbort: 'jump', jumpTo: 'd' }),
      sdo('c', 3),
      sdo('d', 4),
    ]
    const writes = nodeBootWrites(node, defaultCanopenConfig().network)
    const at = (id: string): number => writes.findIndex((w) => w.source.kind === 'startup' && w.source.sdoId === id)
    expect(writes[at('a')]).toMatchObject({ on_abort: 'continue' })
    expect(writes[at('b')]).toMatchObject({ on_abort: 'jump', jump_to: at('d') })
    expect(writes[at('c')].on_abort).toBeUndefined()
    const out = runtimeNode(node).sdo
    expect(out[at('b')]).toEqual({ index: 0x2200, subindex: 2, data: '02000000', on_abort: 'jump', jump_to: at('d') })
    expect(out[at('b')]).not.toHaveProperty('source')
  })

  it('refuses a jump backwards or to a line that is gone', () => {
    const node = genericNode(2)
    node.sdos = [
      sdo('a', 1),
      sdo('b', 2, { onAbort: 'jump', jumpTo: 'a' }),
      sdo('c', 3, { onAbort: 'jump', jumpTo: 'x' }),
    ]
    expect(jumpTargetProblem(node, node.sdos[1])).toBe('it can jump only to a later line')
    expect(jumpTargetProblem(node, node.sdos[2])).toMatch(/is gone/)
    expect(jumpTargetProblem(node, node.sdos[0])).toBeNull()
    const errors = validateCanopenProject([canopenDevice('CANopen_1', { ...defaultCanopenConfig(), nodes: [node] })])
    expect(errors.filter((e) => e.includes('jump'))).toHaveLength(2)
  })
})

/** The generic module with a writable RPDO 1 event timer (deadline). */
function nodeWithDeadline(): CanopenNode {
  const text = GENERIC_IO_EDS.replace(
    '[1600]\n',
    '[1400sub5]\nParameterName=Event timer\nObjectType=0x7\nDataType=0x0006\nAccessType=rw\nDefaultValue=0\nPDOMapping=0\n\n[1600]\n',
  )
  let id = 0
  return createCanopenNode(parseEds(text, 'deadline.eds'), {
    id: 'n2',
    name: 'io2',
    nodeId: 2,
    newId: () => `c${++id}`,
    allocate: sequentialAllocator(),
  })
}

describe('RPDO deadline', () => {
  it('writes the deadline to the node and sends the PDO every half of it, on the PLC cycle', () => {
    const node = nodeWithDeadline()
    node.rpdos[0] = { ...node.rpdos[0], deadlineMs: 105 }
    expect(rpdoSendPeriodMs(node.rpdos[0], 10000)).toBe(50)
    expect(rpdoSendPeriodMs(node.rpdos[0], null)).toBe(52)
    expect(rpdoSendPeriodMs({ ...node.rpdos[0], deadlineMs: 0 }, 10000)).toBeNull()
    const out = runtimeNode(node)
    expect(out.rpdos[0].send_period_ms).toBe(50)
    expect(out.sdo).toContainEqual({ index: 0x1400, subindex: 5, data: '6900' })
  })

  it('refuses a deadline shorter than two PLC cycles', () => {
    const node = genericNode(2)
    node.rpdos[0] = { ...node.rpdos[0], deadlineMs: 15 }
    const device = canopenDevice('CANopen_1', { ...defaultCanopenConfig(), nodes: [node] })
    expect(validateCanopenProject([device], 10000).some((e) => e.includes('at least two PLC cycles'))).toBe(true)
    expect(validateCanopenProject([device], 5000).some((e) => e.includes('PLC cycles'))).toBe(false)
  })
})

describe('gap entries', () => {
  it('names the gap by its size and gives it no address', () => {
    expect(gapEntry(5, 'g')).toEqual({
      channelId: 'g',
      index: 5,
      subIndex: 0,
      name: 'Gap (8 bits)',
      dataType: 'UNSIGNED8',
      iecLocation: '',
    })
    expect(gapEntry(1, 'g').name).toBe('Gap (1 bit)')
  })
})
