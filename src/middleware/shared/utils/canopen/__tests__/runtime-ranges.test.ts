import type { CanopenConfig } from '../../../ports/canopen-types'
import { generateCanopenConfig } from '../generate-canopen-config'
import { validateCanopenProject } from '../validate-canopen-config'
import { canopenDevice, configWith, genericNode, sequentialAllocator } from './fixtures/helpers'

/**
 * The ranges the runtime's conf/canopen.json parser takes (core/src/drivers/plugins/native/canopen/
 * config.cpp, runtime fork `canopen` at d1f3e5a). The runtime refuses the whole file on any value
 * outside them, so the editor must refuse the same values. Change both together.
 */
const RUNTIME_RANGES: Record<string, [number, number]> = {
  'networks[].bitrate': [0, 1000000],
  'networks[].master_node_id': [1, 127],
  'networks[].heartbeat_producer_ms': [0, 65535],
  'networks[].priority': [1, 97],
  'networks[].sdo_timeout_ms': [10, 60000],
  'networks[].boot_timeout_ms': [100, 60000],
  'networks[].time.cob_id': [1, 0x7ff],
  'networks[].time.period_ms': [10, 65535],
  'networks[].sync.period_us': [1000, 10000000],
  'networks[].nodes[].node_id': [1, 127],
  'networks[].nodes[].restore_defaults': [0, 127],
  'networks[].nodes[].emcy.cob_id': [1, 0x7ff],
  'networks[].nodes[].identity.device_type': [0, 0xffffffff],
  'networks[].nodes[].identity.vendor_id': [0, 0xffffffff],
  'networks[].nodes[].identity.product_code': [0, 0xffffffff],
  'networks[].nodes[].identity.revision': [0, 0xffffffff],
  'networks[].nodes[].supervision.consumer_ms': [1, 65535],
  'networks[].nodes[].supervision.guard_time_ms': [1, 65535],
  'networks[].nodes[].supervision.life_time_factor': [1, 255],
  'networks[].nodes[].sdo[].index': [0, 0xffff],
  'networks[].nodes[].sdo[].subindex': [0, 0xff],
  'networks[].nodes[].sdo[].jump_to': [0, 0xffff],
  'networks[].nodes[].tpdos[].number': [1, 512],
  'networks[].nodes[].tpdos[].cob_id': [1, 0x7ff],
  'networks[].nodes[].tpdos[].receive_timeout_ms': [0, 65535],
  'networks[].nodes[].tpdos[].entries[].index': [1, 0xffff],
  'networks[].nodes[].tpdos[].entries[].subindex': [0, 0xff],
  'networks[].nodes[].rpdos[].number': [1, 512],
  'networks[].nodes[].rpdos[].cob_id': [1, 0x7ff],
  'networks[].nodes[].rpdos[].send_period_ms': [1, 65535],
  'networks[].nodes[].rpdos[].entries[].index': [1, 0xffff],
  'networks[].nodes[].rpdos[].entries[].subindex': [0, 0xff],
}

/** Every number in `value` with its path, arrays written as `[]`. */
function numbers(value: unknown, path: string, out: Array<[string, number]>): void {
  if (typeof value === 'number') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v) => numbers(v, `${path}[]`, out))
  else if (value !== null && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) numbers(v, path ? `${path}.${k}` : k, out)
}

function generated(config: CanopenConfig): Array<[string, number]> {
  const text = generateCanopenConfig([canopenDevice('net', config)], 1000)
  const out: Array<[string, number]> = []
  numbers(text === null ? null : JSON.parse(text), '', out)
  return out
}

const valid = (): CanopenConfig => {
  const allocate = sequentialAllocator()
  const config = configWith(genericNode(2, allocate), genericNode(3, allocate))
  config.network.syncMode = 'period'
  config.network.syncPeriodUs = 10000
  config.network.time = { enabled: true, cobId: 0x100, periodMs: 1000 }
  return config
}

const refused = (config: CanopenConfig) => validateCanopenProject([canopenDevice('net', config)]).length > 0

/** Only the changed value is wrong: the base configuration is valid. */
beforeAll(() => expect(validateCanopenProject([canopenDevice('net', valid())])).toEqual([]))

describe("the runtime's conf/canopen.json ranges", () => {
  it('holds every value the editor writes', () => {
    const config = valid()
    expect(validateCanopenProject([canopenDevice('net', config)])).toEqual([])
    for (const [path, value] of generated(config)) {
      if (path === 'version') continue
      const range = RUNTIME_RANGES[path]
      expect({ path, known: range !== undefined }).toEqual({ path, known: true })
      if (range) expect({ path, value, ok: value >= range[0] && value <= range[1] }).toEqual({ path, value, ok: true })
    }
  })

  const network: Array<[string, keyof CanopenConfig['network'], [number, number]]> = [
    ['master_node_id', 'masterNodeId', RUNTIME_RANGES['networks[].master_node_id']],
    ['heartbeat_producer_ms', 'heartbeatProducerMs', RUNTIME_RANGES['networks[].heartbeat_producer_ms']],
    ['priority', 'priority', RUNTIME_RANGES['networks[].priority']],
    ['sdo_timeout_ms', 'sdoTimeoutMs', RUNTIME_RANGES['networks[].sdo_timeout_ms']],
    ['boot_timeout_ms', 'bootTimeoutMs', RUNTIME_RANGES['networks[].boot_timeout_ms']],
    ['sync.period_us', 'syncPeriodUs', RUNTIME_RANGES['networks[].sync.period_us']],
  ]
  it.each(network)('refuses %s outside the range', (_name, field, [lo, hi]) => {
    for (const value of [lo - 1, hi + 1]) {
      if (value < 0) continue
      const config = valid()
      config.network = { ...config.network, [field]: value }
      expect({ field, value, refused: refused(config) }).toEqual({ field, value, refused: true })
    }
  })

  it('refuses a TIME period or COB-ID outside the range', () => {
    for (const periodMs of [9, 65536]) {
      const config = valid()
      config.network.time = { ...config.network.time, periodMs }
      expect(refused(config)).toBe(true)
    }
    for (const cobId of [0, 0x800]) {
      const config = valid()
      config.network.time = { ...config.network.time, cobId }
      expect(refused(config)).toBe(true)
    }
  })
})
