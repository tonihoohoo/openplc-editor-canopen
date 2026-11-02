import type { CanopenNode } from '../../../ports/canopen-types'
import { generateCanopenConfig, nodeConfigurationSdos, pdoConfigured, watchesMaster } from '../generate-canopen-config'
import { defaultNetworkSettings } from '../model'
import { canopenDevice, configWith, genericNode } from './fixtures/helpers'

const net = (masterNodeId = 127) => ({ ...defaultNetworkSettings(), masterNodeId })

describe('nodeConfigurationSdos', () => {
  it('writes heartbeat, PDO communication and mapping, the user SDOs, then the master watch', () => {
    const node = {
      ...genericNode(2),
      sdos: [{ id: 's', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32' as const, value: '0x12345678' }],
    }
    expect(nodeConfigurationSdos(node, net()).map((s) => `${s.index.toString(16)}:${s.subindex}=${s.data}`)).toEqual([
      '1017:0=6400',
      // TPDO 1 (RTR off): disable, clear mapping, map 0x6000:1 (8 bits) and 0x6401:1 (16 bits), count, settings, enable.
      '1800:1=820100C0',
      '1a00:0=00',
      '1a00:1=08010060',
      '1a00:2=10010164',
      '1a00:0=02',
      '1800:2=FF',
      '1800:3=0000',
      '1800:5=1400',
      '1800:1=82010040',
      // RPDO 1
      '1400:1=02020080',
      '1600:0=00',
      '1600:1=08010062',
      '1600:0=01',
      '1400:2=FF',
      '1400:1=02020000',
      '2100:0=78563412',
      // Watch master 127 for 300 ms, go pre-operational when it is gone.
      '1016:1=2C017F00',
      '1029:1=00',
    ])
  })

  it('only disables an unused PDO', () => {
    const node = genericNode(2)
    expect(pdoConfigured({ ...node.rpdos[0], entries: [] })).toBe(false)
    node.rpdos = []
    const sdos = nodeConfigurationSdos(node, net()).filter((s) => s.index === 0x1400 || s.index === 0x1600)
    expect(sdos).toEqual([{ index: 0x1400, subindex: 1, data: '02020080' }])
  })

  it('leaves a fixed mapping alone and sends no heartbeat without supervision', () => {
    const node = { ...genericNode(2), supervision: 'none' as const }
    node.tpdos[0].fixedMapping = true
    const sdos = nodeConfigurationSdos(node, net())
    expect(sdos.some((s) => s.index === 0x1017)).toBe(false)
    expect(sdos.some((s) => s.index === 0x1a00)).toBe(false)
  })
})

describe('watch the master', () => {
  const watchSdos = (node: CanopenNode, master = 127): string[] =>
    nodeConfigurationSdos(node, net(master))
      .filter((s) => s.index === 0x1016 || s.index === 0x1029)
      .map((s) => `${s.index.toString(16)}:${s.subindex}=${s.data}`)

  it('encodes the master node ID, the timeout and the reaction', () => {
    const node = genericNode(2)
    node.watchMaster = { enabled: true, consumerMs: 500, onError: 'stopped' }
    expect(watchesMaster(node)).toBe(true)
    expect(watchSdos(node, 1)).toEqual(['1016:1=F4010100', '1029:1=02'])
    node.watchMaster.onError = 'no_change'
    expect(watchSdos(node)).toEqual(['1016:1=F4017F00', '1029:1=01'])
  })

  it('writes nothing when it is off', () => {
    const node = genericNode(2)
    node.watchMaster.enabled = false
    expect(watchesMaster(node)).toBe(false)
    expect(watchSdos(node)).toEqual([])
  })

  it('writes nothing when the EDS has no consumer heartbeat, and skips 0x1029 when it is missing', () => {
    const node = genericNode(2)
    const without = (index: number): CanopenNode['eds'] => ({
      ...node.eds,
      objects: node.eds.objects.filter((o) => o.index !== index),
    })
    expect(watchSdos({ ...node, eds: without(0x1016) })).toEqual([])
    expect(watchSdos({ ...node, eds: without(0x1029) })).toEqual(['1016:1=2C017F00'])
  })
})

describe('generateCanopenConfig', () => {
  it('returns null without a CANopen device', () => {
    expect(generateCanopenConfig(undefined)).toBeNull()
    expect(generateCanopenConfig([{ name: 'm', protocol: 'modbus-tcp' }])).toBeNull()
  })

  it('writes one network per device in the runtime format', () => {
    const config = configWith(genericNode(2))
    config.network.syncMode = 'period'
    config.network.syncPeriodUs = 5000
    const text = generateCanopenConfig([canopenDevice('CANopen_1', config)])
    expect(text).not.toBeNull()
    const json: unknown = JSON.parse(text ?? '')
    expect(json).toMatchObject({
      version: 3,
      networks: [
        {
          name: 'CANopen_1',
          interface: 'can0',
          bitrate: 500000,
          master_node_id: 127,
          sync: { mode: 'period', period_us: 5000 },
          on_plc_stop: 'pre_operational',
          heartbeat_producer_ms: 100,
          priority: 90,
          nodes: [
            {
              node_id: 2,
              name: 'io2',
              identity: { vendor_id: 1, product_code: 2, revision: 0 },
              supervision: { type: 'heartbeat', consumer_ms: 150 },
              on_loss: 'hold',
              state_location: '%IB0',
              tpdos: [
                {
                  number: 1,
                  cob_id: 0x182,
                  entries: [
                    { index: 0x6000, subindex: 1, type: 'UNSIGNED8', location: '%IB1' },
                    { index: 0x6401, subindex: 1, type: 'INTEGER16', location: '%IW0' },
                  ],
                },
              ],
              rpdos: [
                {
                  number: 1,
                  cob_id: 0x202,
                  entries: [{ index: 0x6200, subindex: 1, type: 'UNSIGNED8', location: '%QB0' }],
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it('leaves out inactive PDOs and keeps the sync mode name', () => {
    const node = genericNode(2)
    node.rpdos[0].entries = []
    const text = generateCanopenConfig([canopenDevice('n', configWith(node))]) ?? ''
    expect(JSON.parse(text)).toMatchObject({ networks: [{ sync: { mode: 'none' }, nodes: [{ rpdos: [] }] }] })
  })
})
