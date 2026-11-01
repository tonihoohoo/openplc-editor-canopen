import type { CanopenConfig } from '../../../ports/canopen-types'
import { reservedCobId } from '../check-fix'
import { canopenSdoWarnings, validateCanopenProject, watchMasterProblem } from '../validate-canopen-config'
import { canopenDevice, configWith, genericNode } from './fixtures/helpers'

const errorsOf = (config: CanopenConfig): string[] => validateCanopenProject([canopenDevice('net', config)])

describe('validateCanopenProject', () => {
  it('accepts a valid network', () => {
    expect(errorsOf(configWith(genericNode(2)))).toEqual([])
    expect(validateCanopenProject(undefined)).toEqual([])
  })

  it('checks the network settings', () => {
    const config = configWith()
    config.network.interface = ''
    config.network.bitrate = 123
    config.network.syncMode = 'period'
    config.network.syncPeriodUs = 0
    expect(errorsOf(config)).toEqual([
      'CANopen "net": no CAN interface',
      'CANopen "net": bit rate 123 is not a CANopen bit rate',
      'CANopen "net": periodic SYNC needs a period',
      'CANopen "net": no nodes',
    ])
    config.network.interface = 'a-very-long-interface'
    expect(errorsOf(config)[0]).toMatch(/longer than 15 characters/)
  })

  it('refuses one interface on two networks', () => {
    const errors = validateCanopenProject([
      canopenDevice('a', configWith(genericNode(2))),
      canopenDevice('b', configWith(genericNode(2))),
    ])
    expect(errors).toContain('CANopen "b": interface can0 is also used by CANopen "a"')
  })

  it('refuses duplicate node IDs and names, and the master node ID', () => {
    const config = configWith(genericNode(2), { ...genericNode(3), nodeId: 2, name: 'io2' })
    config.network.masterNodeId = 2
    const errors = errorsOf(config)
    expect(errors).toContain('CANopen "net" node 2 (io2): has the master\'s node ID')
    expect(errors.some((e) => e.includes('have the same node ID'))).toBe(true)
    expect(errors.some((e) => e.includes('another node has the name "io2"'))).toBe(true)
  })

  it('checks PDO size, COB-IDs and locations', () => {
    const node = genericNode(2)
    node.tpdos[0].entries.push(...node.tpdos[0].entries, ...node.tpdos[0].entries)
    node.rpdos[0].cobId = 0x182
    node.rpdos[0].entries[0].iecLocation = '%IB9'
    const errors = errorsOf(configWith(node))
    expect(errors).toContain('CANopen "net" node 2 (io2) TPDO 1: maps 72 bits; a PDO holds at most 64')
    expect(errors.some((e) => e.includes('use the same COB-ID 0x182'))).toBe(true)
    expect(errors).toContain('CANopen "net" node 2 (io2) RPDO 1: Outputs 1-8 needs a %QB address, has "%IB9"')
    expect(errors.some((e) => e.includes('%IB1 is also written by'))).toBe(true)
    const reserved = genericNode(2)
    reserved.tpdos[0].cobId = 0x702
    expect(errorsOf(configWith(reserved))).toContain(
      'CANopen "net" node 2 (io2) TPDO 1: COB-ID 0x702 is reserved for heartbeat',
    )
  })

  it('refuses RTR and reserved transmission types', () => {
    const node = genericNode(2)
    node.tpdos[0].transmissionType = 253
    node.rpdos[0].transmissionType = 245
    const errors = errorsOf(configWith(node))
    expect(errors).toContain(
      'CANopen "net" node 2 (io2) TPDO 1: transmission type 253 needs remote requests (RTR), which are not supported',
    )
    expect(errors).toContain('CANopen "net" node 2 (io2) RPDO 1: transmission type 245 is reserved')
  })

  it('refuses store and restore SDOs and bad values', () => {
    const node = genericNode(2)
    node.sdos = [
      { id: 'a', index: 0x1010, subIndex: 1, dataType: 'UNSIGNED32', value: '0x65766173' },
      { id: 'b', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED8', value: '300' },
      { id: 'c', index: 0x1011, subIndex: 1, dataType: 'UNSIGNED32', value: '0x64616F6C' },
    ]
    const errors = errorsOf(configWith(node))
    expect(errors).toContain(
      'CANopen "net" node 2 (io2) startup SDO 0x1010:1: the master never writes 0x1010 (store parameters)',
    )
    expect(errors).toContain(
      'CANopen "net" node 2 (io2) startup SDO 0x1011:1: 0x1011 is written only by the node\'s "Restore defaults" setting',
    )
    expect(errors.some((e) => e.includes('0x2100:0: 300 is out of range'))).toBe(true)
  })
})

describe('watch the master', () => {
  it('needs a master heartbeat shorter than the node waits', () => {
    const node = genericNode(2)
    const config = configWith(node)
    config.network.heartbeatProducerMs = 0
    expect(errorsOf(config)).toEqual([
      'CANopen "net" node 2 (io2): watches the master\'s heartbeat, but the master sends none; set the master heartbeat',
    ])
    config.network.heartbeatProducerMs = 300
    expect(watchMasterProblem(node, 300)).toBe(
      "the master's heartbeat (300 ms) must be shorter than the time the node waits for it (300 ms)",
    )
    expect(errorsOf(config)).toHaveLength(1)
    node.watchMaster.enabled = false
    expect(errorsOf(config)).toEqual([])
  })

  it('checks the real-time priority', () => {
    const config = configWith(genericNode(2))
    config.network.priority = 98
    expect(errorsOf(config)).toEqual(['CANopen "net": real-time priority 98 is outside 1 - 97'])
  })
})

describe('reservedCobId', () => {
  it('names the reserved ranges', () => {
    expect(reservedCobId(0)).toBe('NMT')
    expect(reservedCobId(0x80)).toBe('SYNC')
    expect(reservedCobId(0x85)).toBe('EMCY')
    expect(reservedCobId(0x100)).toBe('TIME')
    expect(reservedCobId(0x581)).toBe('SDO')
    expect(reservedCobId(0x7e5)).toBe('LSS')
    expect(reservedCobId(0x182)).toBeNull()
  })
})

describe('canopenSdoWarnings', () => {
  it('warns about objects the EDS lacks or marks read-only', () => {
    const node = genericNode(2)
    node.sdos = [
      { id: 'a', index: 0x3000, subIndex: 0, dataType: 'UNSIGNED8', value: '1' },
      { id: 'b', index: 0x1018, subIndex: 1, dataType: 'UNSIGNED32', value: '1' },
      { id: 'c', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '1' },
    ]
    expect(canopenSdoWarnings(canopenDevice('net', configWith(node)))).toEqual([
      { nodeId: 'node-2', sdoId: 'a', message: "This object is not in the node's device file." },
      { nodeId: 'node-2', sdoId: 'b', message: 'The device file marks this object read-only.' },
    ])
  })

  it('warns that Watch the master overrides a user SDO to its objects', () => {
    const node = genericNode(2)
    node.sdos = [{ id: 'w', index: 0x1016, subIndex: 1, dataType: 'UNSIGNED32', value: '0' }]
    expect(canopenSdoWarnings(canopenDevice('net', configWith(node)))).toEqual([
      { nodeId: 'node-2', sdoId: 'w', message: '"Watch the master" writes this object after the startup SDOs.' },
    ])
    node.watchMaster.enabled = false
    expect(canopenSdoWarnings(canopenDevice('net', configWith(node)))).toEqual([])
  })
})
