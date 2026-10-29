import { generateCanopenConfig, nodeConfigurationSdos, pdoActive } from '../generate-canopen-config'
import { canopenDevice, configWith, genericNode } from './fixtures/helpers'

describe('nodeConfigurationSdos', () => {
  it('writes heartbeat, PDO communication and mapping, then the user SDOs', () => {
    const node = {
      ...genericNode(2),
      sdos: [{ id: 's', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32' as const, value: '0x12345678' }],
    }
    expect(nodeConfigurationSdos(node).map((s) => `${s.index.toString(16)}:${s.subindex}=${s.data}`)).toEqual([
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
    ])
  })

  it('only disables an unused PDO', () => {
    const node = genericNode(2)
    node.rpdos[0].enabled = false
    expect(pdoActive(node.rpdos[0])).toBe(false)
    const sdos = nodeConfigurationSdos(node).filter((s) => s.index === 0x1400 || s.index === 0x1600)
    expect(sdos).toEqual([{ index: 0x1400, subindex: 1, data: '02020080' }])
  })

  it('leaves a fixed mapping alone and sends no heartbeat without supervision', () => {
    const node = { ...genericNode(2), supervision: 'none' as const }
    node.tpdos[0].fixedMapping = true
    const sdos = nodeConfigurationSdos(node)
    expect(sdos.some((s) => s.index === 0x1017)).toBe(false)
    expect(sdos.some((s) => s.index === 0x1a00)).toBe(false)
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
      version: 1,
      networks: [
        {
          name: 'CANopen_1',
          interface: 'can0',
          bitrate: 500000,
          master_node_id: 127,
          sync: { mode: 'period', period_us: 5000 },
          on_plc_stop: 'pre_operational',
          nodes: [
            {
              node_id: 2,
              name: 'io2',
              identity: { vendor_id: 1, product_code: 2, revision: 0 },
              supervision: { type: 'heartbeat', consumer_ms: 300 },
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
