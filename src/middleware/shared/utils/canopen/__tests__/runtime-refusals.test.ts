import type { CanopenConfig, CanopenEdsInfo, CanopenNode, CanopenObject } from '../../../ports/canopen-types'
import { checkCanopenNetwork, fixAllCanopenProblems } from '../check-fix'
import { OBJ_FLAG_REFUSE_WRITE } from '../eds-parser'
import { generateCanopenConfig } from '../generate-canopen-config'
import { createCanopenNode, effectiveEmcy, emcyMissingReason, emcySupport } from '../model'
import { validateCanopenProject } from '../validate-canopen-config'
import { canopenDevice, configWith, genericIoEds, genericNode, sequentialAllocator } from './fixtures/helpers'

const object = (index: number, subIndex: number, dataType: string, defaultValue?: string): CanopenObject => ({
  index,
  subIndex,
  name: `0x${index.toString(16)}:${subIndex}`,
  dataType,
  access: 'rw',
  pdoMapping: false,
  defaultValue,
})

const withObjects = (...extra: CanopenObject[]): CanopenEdsInfo => {
  const eds = genericIoEds()
  const replaced = new Set(extra.map((o) => `${o.index}:${o.subIndex}`))
  return { ...eds, objects: [...eds.objects.filter((o) => !replaced.has(`${o.index}:${o.subIndex}`)), ...extra] }
}

const nodeOf = (eds: CanopenEdsInfo, nodeId = 2): CanopenNode =>
  createCanopenNode(eds, {
    id: `node-${nodeId}`,
    name: `io${nodeId}`,
    nodeId,
    newId: () => `ch${nodeId}`,
    allocate: sequentialAllocator(),
  })

const errorsOf = (config: CanopenConfig) => validateCanopenProject([canopenDevice('net', config)])
const output = (config: CanopenConfig) =>
  JSON.parse(generateCanopenConfig([canopenDevice('net', config)]) ?? '{}') as {
    networks: Array<{ interface: string; nodes: Array<{ emcy: unknown }> }>
  }

describe('SYNC period the runtime takes', () => {
  it('refuses a period below 1 ms and offers a multiple of the PLC cycle', () => {
    const config = configWith(genericNode(2))
    config.network.syncMode = 'period'
    config.network.syncPeriodUs = 500
    expect(errorsOf(config)).toContain('CANopen "net": the SYNC period (500 µs) must be 1000 - 10000000 µs')
    const problem = checkCanopenNetwork(config, 400).find((p) => p.text.startsWith('the SYNC period (500'))
    expect(problem?.fix?.label).toBe('Set to 1200 µs')
    expect(fixAllCanopenProblems(config, 400).network.syncPeriodUs).toBe(1200)
    expect(fixAllCanopenProblems(config, null).network.syncPeriodUs).toBe(1000)
  })

  it('refuses a period above 10 s', () => {
    const config = configWith(genericNode(2))
    config.network.syncMode = 'period'
    config.network.syncPeriodUs = 10000001
    expect(errorsOf(config).some((e) => e.includes('must be 1000 - 10000000 µs'))).toBe(true)
    expect(fixAllCanopenProblems(config, null).network.syncPeriodUs).toBe(10000000)
  })
})

describe('node guarding values the node has', () => {
  const guarded = (guardTime?: string, factor?: string) =>
    nodeOf(withObjects(object(0x100c, 0, 'UNSIGNED16', guardTime), object(0x100d, 0, 'UNSIGNED8', factor)))

  it('refuses guarding without configuration when the file has no guard time', () => {
    const node = { ...guarded(undefined, '2'), configure: false, supervision: 'guarding' as const }
    const config = configWith(node)
    expect(errorsOf(config)).toContain(
      'CANopen "net" node 2 (io2): is supervised by node guarding, but its file default guard time or life time factor is 0 and the master does not set it',
    )
    const fixed = fixAllCanopenProblems(config, null)
    expect(fixed.nodes[0].supervision).toBe('none')
    expect(errorsOf(fixed)).toEqual([])
  })

  it('refuses a life time factor of 0 from the file', () => {
    const node = { ...guarded('500', '0'), configure: false, supervision: 'guarding' as const }
    expect(errorsOf(configWith(node)).some((e) => e.includes('node guarding'))).toBe(true)
  })

  it('takes the file values when they are above 0', () => {
    const node = { ...guarded('500', '2'), configure: false, supervision: 'guarding' as const }
    expect(errorsOf(configWith(node))).toEqual([])
  })

  it('keeps the error without a fix when the master configures the node', () => {
    const node = { ...guarded('500', '2'), supervision: 'guarding' as const, guardTimeMs: 0 }
    const problem = checkCanopenNetwork(configWith(node), null).find((p) => p.text.includes('node guarding'))
    expect(problem?.text).toBe('node guarding needs a guard time and a life time factor above 0')
    expect(problem?.fix).toBeUndefined()
  })
})

describe('emergency without a usable COB-ID', () => {
  const fixedEmcy = (value: string) => withObjects({ ...object(0x1014, 0, 'UNSIGNED32', value), access: 'ro' })

  it('treats a read-only COB-ID of 0 as no emergency', () => {
    const eds = fixedEmcy('0')
    expect(emcySupport(eds)).toBe('none')
    expect(emcyMissingReason(eds)).toBe('its device file gives a read-only emergency COB-ID (0x1014) of 0')
    const node = nodeOf(eds)
    expect(effectiveEmcy(node).enabled).toBe(false)
    const config = configWith(node)
    expect(errorsOf(config)).toEqual([])
    expect(output(config).networks[0].nodes[0].emcy).toEqual({ enabled: false, cob_id: 0x82 })
    expect(checkCanopenNetwork(config, null).find((p) => p.field === 'emcy')).toMatchObject({
      level: 'warning',
      text: 'its emergencies are not watched: its device file gives a read-only emergency COB-ID (0x1014) of 0',
    })
  })

  it('names a COB-ID marked as not valid', () => {
    expect(emcyMissingReason(fixedEmcy('0x80000000+$NODEID+0x80'))).toBe(
      'its device file marks the emergency COB-ID (0x1014) as not valid',
    )
  })

  it('keeps a usable read-only COB-ID and warns about nothing', () => {
    const eds = fixedEmcy('$NODEID+0x80')
    expect(emcyMissingReason(eds)).toBeNull()
    expect(checkCanopenNetwork(configWith(nodeOf(eds)), null).some((p) => p.field === 'emcy')).toBe(false)
  })

  it('does not warn for a device without 0x1014', () => {
    const full = genericIoEds()
    const eds = { ...full, objects: full.objects.filter((o) => o.index !== 0x1014) }
    expect(checkCanopenNetwork(configWith(nodeOf(eds)), null).some((p) => p.field === 'emcy')).toBe(false)
  })
})

describe('interface name', () => {
  it('is written without spaces', () => {
    const config = configWith(genericNode(2))
    config.network.interface = ' can0 '
    expect(errorsOf(config)).toEqual([])
    expect(output(config).networks[0].interface).toBe('can0')
  })
})

describe('jump targets that are written', () => {
  it('refuses a jump to a line whose object refuses writes', () => {
    const eds = withObjects(object(0x2000, 0, 'UNSIGNED8', '0'), object(0x2001, 0, 'UNSIGNED8', '0'), {
      ...object(0x2002, 0, 'UNSIGNED8', '0'),
      objFlags: OBJ_FLAG_REFUSE_WRITE,
    })
    const node: CanopenNode = {
      ...nodeOf(eds),
      sdos: [
        { id: 'a', index: 0x2000, subIndex: 0, dataType: 'UNSIGNED8', value: '1', onAbort: 'jump', jumpTo: 'c' },
        { id: 'b', index: 0x2001, subIndex: 0, dataType: 'UNSIGNED8', value: '1' },
        { id: 'c', index: 0x2002, subIndex: 0, dataType: 'UNSIGNED8', value: '1' },
      ],
    }
    expect(errorsOf(configWith(node))).toContain(
      'CANopen "net" node 2 (io2) startup SDO 0x2000:00: line 3 is not written (the device refuses writes to its object); pick another',
    )
  })
})
