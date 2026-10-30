import type { CanopenConfig, CanopenEdsInfo, CanopenNode, CanopenObject } from '../../../ports/canopen-types'
import { checkCanopenNetwork, checkText, fixAllCanopenProblems, plcCycleUs, roundUpToCycle } from '../check-fix'
import { generateCanopenConfig, nodeConfigurationSdos } from '../generate-canopen-config'
import {
  autoSupervision,
  canBeGuarded,
  consumerTimeFor,
  createCanopenNode,
  defaultNetworkSettings,
  effectiveGuarding,
  effectiveProducerMs,
  restoreChoiceName,
  restoreChoices,
  withNodeId,
} from '../model'
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

/** The generic I/O module with guarding, restore, EMCY, TIME and SYNC window objects added. */
const fullEds = (): CanopenEdsInfo => {
  const eds = genericIoEds()
  return {
    ...eds,
    objects: [
      ...eds.objects,
      object(0x1007, 0, 'UNSIGNED32', '0'),
      object(0x100c, 0, 'UNSIGNED16', '500'),
      object(0x100d, 0, 'UNSIGNED8', '2'),
      object(0x1011, 1, 'UNSIGNED32'),
      object(0x1011, 2, 'UNSIGNED32'),
      object(0x1011, 3, 'UNSIGNED32'),
      object(0x1012, 0, 'UNSIGNED32', '0x80000100'),
      object(0x1014, 0, 'UNSIGNED32', '$NODEID+0x80'),
      object(0x1016, 2, 'UNSIGNED32', '0'),
    ],
  }
}

const fullNode = (nodeId: number): CanopenNode =>
  createCanopenNode(fullEds(), {
    id: `node-${nodeId}`,
    name: `io${nodeId}`,
    nodeId,
    newId: () => `ch${nodeId}`,
    allocate: sequentialAllocator(),
  })

const sdoText = (node: CanopenNode, config: CanopenConfig = configWith(node)): string[] =>
  nodeConfigurationSdos(node, config.network).map((s) => `${s.index.toString(16)}:${s.subindex}=${s.data}`)

const network = (config: CanopenConfig): Record<string, unknown> => {
  const json: unknown = JSON.parse(generateCanopenConfig([canopenDevice('net', config)]) ?? '')
  if (typeof json !== 'object' || json === null || !('networks' in json) || !Array.isArray(json.networks))
    throw new Error('no networks')
  const first: unknown = json.networks[0]
  if (typeof first !== 'object' || first === null) throw new Error('no network')
  return { ...first }
}

describe('node options in the model', () => {
  it('reads what the EDS supports', () => {
    const eds = fullEds()
    expect(canBeGuarded(eds)).toBe(true)
    expect(canBeGuarded(genericIoEds())).toBe(false)
    expect(restoreChoices(eds)).toEqual([1, 2, 3])
    const appReadOnly = {
      ...eds,
      objects: eds.objects.map((o) => (o.index === 0x1011 && o.subIndex === 3 ? { ...o, access: 'ro' as const } : o)),
    }
    expect(restoreChoices(appReadOnly)).toEqual([1, 2])
    expect(restoreChoiceName(2)).toBe('Communication parameters')
    expect(restoreChoiceName(5)).toBe('Manufacturer specific (sub 5)')
    expect(autoSupervision(eds)).toBe('heartbeat')
    const guardOnly = { ...eds, objects: eds.objects.filter((o) => o.index !== 0x1017) }
    expect(autoSupervision(guardOnly)).toBe('guarding')
  })

  it('gives new nodes the network defaults', () => {
    const node = createCanopenNode(fullEds(), {
      id: 'n',
      name: 'n',
      nodeId: 4,
      newId: () => 'c',
      allocate: sequentialAllocator(),
      defaults: { heartbeatTimeoutPercent: 200, supervision: 'guarding', emcy: false },
    })
    expect(node.supervision).toBe('guarding')
    expect(node.guardTimeMs).toBe(500)
    expect(node.lifeTimeFactor).toBe(2)
    expect(node.heartbeatConsumerMs).toBe(200)
    expect(node.emcy).toEqual({ enabled: false, cobId: 0x84 })
    expect(node.optional).toBe(false)
    expect(node.configure).toBe(true)
    expect(node.restoreDefaults).toBe(0)
    const plain = genericNode(2)
    expect(plain.supervision).toBe('heartbeat')
    expect(plain.heartbeatConsumerMs).toBe(consumerTimeFor(100, 150))
  })

  it('moves the default EMCY COB-ID with the node ID only', () => {
    const node = fullNode(4)
    expect(withNodeId(node, 9).emcy.cobId).toBe(0x89)
    expect(withNodeId({ ...node, emcy: { enabled: true, cobId: 0x0f0 } }, 9).emcy.cobId).toBe(0x0f0)
  })

  it('uses the EDS values of a node that is not initialized', () => {
    const node = { ...fullNode(4), configure: false, heartbeatProducerMs: 250, guardTimeMs: 900 }
    expect(effectiveProducerMs(node)).toBe(0)
    expect(effectiveGuarding(node)).toEqual({ guardTimeMs: 500, lifeTimeFactor: 2 })
    expect(effectiveProducerMs({ ...node, configure: true })).toBe(250)
  })
})

describe('node options in the configuration SDOs', () => {
  it('writes nothing to a node that is not initialized', () => {
    expect(sdoText({ ...fullNode(4), configure: false })).toEqual([])
  })

  it('switches heartbeat off and writes guard time and life time factor for guarding', () => {
    const node = { ...fullNode(4), supervision: 'guarding' as const, guardTimeMs: 200, lifeTimeFactor: 3 }
    expect(sdoText(node).slice(0, 3)).toEqual(['1017:0=0000', '100c:0=C800', '100d:0=03'])
  })

  it('writes the EMCY COB-ID only when it differs from the EDS', () => {
    const node = fullNode(4)
    expect(sdoText(node).some((s) => s.startsWith('1014:'))).toBe(false)
    expect(sdoText({ ...node, emcy: { enabled: true, cobId: 0x0f0 } })).toContain('1014:0=F0000000')
    expect(sdoText({ ...node, emcy: { enabled: false, cobId: 0x84 } })).toContain('1014:0=84000080')
  })

  it('writes the SYNC window and TIME consumption', () => {
    const node = { ...fullNode(4), receiveTime: true }
    const config = configWith(node)
    config.network.syncMode = 'period'
    config.network.syncWindowUs = 2000
    expect(sdoText(node, config)).not.toContain('1012:0=00010080')
    config.network.time.enabled = true
    const sdos = sdoText(node, config)
    expect(sdos).toContain('1007:0=D0070000')
    expect(sdos).toContain('1012:0=00010080')
  })

  it('puts the heartbeats a node watches after the master', () => {
    const node = {
      ...fullNode(4),
      heartbeatConsumers: [{ id: 'c', producerNodeId: 5, consumerMs: 400 }],
    }
    const watch = sdoText(node).filter((s) => s.startsWith('1016:'))
    expect(watch).toEqual(['1016:1=2C017F00', '1016:2=90010500'])
  })
})

describe('node options in edge cases of the generator', () => {
  it('guards a node without a heartbeat producer and leaves out what the EDS lacks', () => {
    const eds = fullEds()
    const guardOnly: CanopenNode = {
      ...fullNode(4),
      eds: { ...eds, objects: eds.objects.filter((o) => o.index !== 0x1017 && o.index !== 0x1014) },
      supervision: 'guarding',
      guardTimeMs: 200,
      lifeTimeFactor: 3,
      emcy: { enabled: true, cobId: 0x0f0 },
    }
    const sdos = sdoText(guardOnly)
    expect(sdos.slice(0, 2)).toEqual(['100c:0=C800', '100d:0=03'])
    expect(sdos.some((x) => x.startsWith('1017:') || x.startsWith('1014:'))).toBe(false)
    const asIs = { ...guardOnly, configure: false, restoreDefaults: 2 }
    expect(network(configWith(asIs))).toMatchObject({
      nodes: [{ configure: false, restore_defaults: 0, supervision: { type: 'guarding', guard_time_ms: 500 } }],
    })
    expect(network(configWith({ ...asIs, supervision: 'none' as const }))).toMatchObject({
      nodes: [{ supervision: { type: 'none' } }],
    })
  })
})

describe('node options in canopen.json', () => {
  it('writes the network and node options', () => {
    const node = {
      ...fullNode(4),
      optional: true,
      restoreDefaults: 2,
      supervision: 'guarding' as const,
      guardTimeMs: 200,
      lifeTimeFactor: 3,
    }
    const config = configWith(node)
    config.network.bootTimeoutMs = 5000
    config.network.onNodeError = 'stop'
    config.network.time = { enabled: true, cobId: 0x100, periodMs: 500 }
    expect(network(config)).toMatchObject({
      boot_timeout_ms: 5000,
      on_node_error: 'stop',
      time: { cob_id: 0x100, period_ms: 500 },
      nodes: [
        {
          optional: true,
          configure: true,
          restore_defaults: 2,
          emcy: { enabled: true, cob_id: 0x84 },
          supervision: { type: 'guarding', guard_time_ms: 200, life_time_factor: 3 },
        },
      ],
    })
    config.network.time.enabled = false
    expect(network(config).time).toBeNull()
  })
})

describe('checkCanopenNetwork', () => {
  it('finds nothing on a plain network', () => {
    expect(checkCanopenNetwork(configWith(genericNode(2)), 10000)).toEqual([])
  })

  it('fixes a heartbeat timeout that is not longer than the heartbeat', () => {
    const node = { ...genericNode(2), heartbeatConsumerMs: 100 }
    const [problem] = checkCanopenNetwork(configWith(node), null)
    expect(problem.level).toBe('error')
    expect(checkText(problem)).toBe(
      "node 2 (io2): the heartbeat timeout (100 ms) must be longer than the node's heartbeat time (100 ms)",
    )
    expect(problem.fix?.label).toBe('Set to 150 ms')
    const fixed = problem.fix?.apply(configWith(node))
    expect(fixed?.nodes[0].heartbeatConsumerMs).toBe(150)
  })

  it('moves a clashing COB-ID to a free one', () => {
    const a = genericNode(2)
    const b = genericNode(3)
    b.tpdos[0].cobId = 0x182
    const problems = checkCanopenNetwork(configWith(a, b), null)
    expect(problems.map(checkText)).toEqual(['node 3 (io3) TPDO 1 and node 2 (io2) TPDO 1 use the same COB-ID 0x182'])
    expect(problems[0].fix?.label).toBe('Move node 3 (io3) TPDO 1 to 0x181')
    expect(checkCanopenNetwork(fixAllCanopenProblems(configWith(a, b), null), null)).toEqual([])
  })

  it('checks the heartbeats a node watches', () => {
    const watcher = { ...fullNode(4), heartbeatConsumers: [{ id: 'c', producerNodeId: 2, consumerMs: 50 }] }
    const problems = checkCanopenNetwork(configWith(genericNode(2), watcher), null)
    expect(problems.map(checkText)).toEqual([
      'node 4 (io4): waits 50 ms for node 2 (io2), which must be longer than its heartbeat time (100 ms)',
    ])
    expect(problems[0].field).toBe('heartbeatConsumers')
    const missing = { ...watcher, heartbeatConsumers: [{ id: 'c', producerNodeId: 9, consumerMs: 500 }] }
    expect(checkCanopenNetwork(configWith(missing), null)[0].text).toBe('watches node 9, which is not in the network')
  })

  it('refuses restore on a node that is not initialized or has no such sub-index', () => {
    const node = { ...fullNode(4), restoreDefaults: 2, configure: false }
    const restore = (config: CanopenConfig) =>
      checkCanopenNetwork(config, null).find((p) => p.field === 'restoreDefaults')
    expect(restore(configWith(node))?.fix?.label).toBe('Turn restore defaults off')
    const unknown = { ...fullNode(4), restoreDefaults: 7 }
    expect(restore(configWith(unknown))?.text).toContain('0x1011 sub 7')
    expect(fixAllCanopenProblems(configWith(unknown), null).nodes[0].restoreDefaults).toBe(0)
    const readOnly = {
      ...fullNode(4),
      restoreDefaults: 3,
      eds: {
        ...fullEds(),
        objects: fullEds().objects.map((o) =>
          o.index === 0x1011 && o.subIndex === 3 ? { ...o, access: 'ro' as const } : o,
        ),
      },
    }
    expect(restore(configWith(readOnly))?.text).toBe(
      'restores its defaults with 0x1011 sub 3, which its EDS does not define as writable',
    )
  })

  it('shortens a SYNC window that is not shorter than the period', () => {
    const config = configWith(genericNode(2))
    config.network.syncMode = 'period'
    config.network.syncPeriodUs = 10000
    config.network.syncWindowUs = 10000
    const [problem] = checkCanopenNetwork(config, 1000)
    expect(problem.fix?.label).toBe('Set to 9000 µs')
  })

  it('warns about times that are not multiples of the PLC cycle and errors stop the build', () => {
    const node = { ...genericNode(2), heartbeatProducerMs: 105, heartbeatConsumerMs: 300 }
    const problems = checkCanopenNetwork(configWith(node), 10000)
    expect(problems).toHaveLength(1)
    expect(problems[0].level).toBe('warning')
    expect(problems[0].fix?.label).toBe('Round to 110 ms')
    expect(validateCanopenProject([canopenDevice('net', configWith(node))], 10000)).toEqual([])
    const bad = { ...node, heartbeatConsumerMs: 50 }
    expect(validateCanopenProject([canopenDevice('net', configWith(bad))], 10000)[0]).toContain(
      'the heartbeat timeout (50 ms) must be longer',
    )
  })
})

describe('checkCanopenNetwork fixes', () => {
  const fixAll = (config: CanopenConfig, cycleUs: number | null = null) => fixAllCanopenProblems(config, cycleUs)

  it('rounds every time to the PLC cycle', () => {
    const node = { ...genericNode(2), heartbeatProducerMs: 105, heartbeatConsumerMs: 300 }
    node.tpdos[0] = { ...node.tpdos[0], eventTimerMs: 15 }
    const guarded = { ...fullNode(4), supervision: 'guarding' as const, guardTimeMs: 505 }
    const config = configWith(node, guarded)
    config.network.syncMode = 'period'
    config.network.syncPeriodUs = 15000
    config.network.heartbeatProducerMs = 95
    config.network.time = { enabled: true, cobId: 0x100, periodMs: 999 }
    const texts = checkCanopenNetwork(config, 10000).map(checkText)
    expect(texts).toEqual(
      expect.arrayContaining([
        'the SYNC period (15000 µs) is not a multiple of the PLC cycle (10 ms)',
        'the master heartbeat (95 ms) is not a multiple of the PLC cycle (10 ms)',
        'the TIME period (999 ms) is not a multiple of the PLC cycle (10 ms)',
        'node 4 (io4): the guard time (505 ms) is not a multiple of the PLC cycle (10 ms)',
        'node 2 (io2) TPDO 1: the event timer (15 ms) is not a multiple of the PLC cycle (10 ms)',
      ]),
    )
    const fixed = fixAll(config, 10000)
    expect(fixed.network).toMatchObject({ syncPeriodUs: 20000, heartbeatProducerMs: 100, time: { periodMs: 1000 } })
    expect(fixed.nodes[0]).toMatchObject({ heartbeatProducerMs: 110 })
    expect(fixed.nodes[0].tpdos[0].eventTimerMs).toBe(20)
    expect(fixed.nodes[1].guardTimeMs).toBe(510)
    expect(checkCanopenNetwork(fixed, 10000)).toEqual([])
    // A node that is not initialized keeps its own times.
    expect(checkCanopenNetwork(configWith({ ...node, configure: false, supervision: 'none' }), 2500)).toEqual([])
  })

  it('moves a clashing emergency or TIME COB-ID', () => {
    const a = fullNode(4)
    const b = { ...fullNode(5), emcy: { enabled: true, cobId: 0x84 } }
    const config = configWith(a, b)
    config.network.time = { enabled: true, cobId: 0x184, periodMs: 1000 }
    const problems = checkCanopenNetwork(config, null)
    expect(problems.map((p) => p.fix?.label)).toEqual(expect.arrayContaining(['Move node 5 (io5) emergency to 0x081']))
    expect(problems.find((p) => p.text.includes('emergency'))?.field).toBe('emcy')
    const fixed = fixAll(config)
    expect(fixed.nodes[1].emcy.cobId).toBe(0x81)
    expect(checkCanopenNetwork(fixed, null)).toEqual([])
    expect(fixed.network.time.cobId).toBe(0x184)
    expect(fixed.nodes[0].tpdos[0].cobId).not.toBe(0x184)
  })

  it('checks guarding settings', () => {
    const zero = { ...fullNode(4), supervision: 'guarding' as const, guardTimeMs: 0 }
    expect(checkCanopenNetwork(configWith(zero), null)[0].text).toBe(
      'node guarding needs a guard time and a life time factor above 0',
    )
    const unsupported = { ...genericNode(2), supervision: 'guarding' as const }
    const [problem] = checkCanopenNetwork(configWith(unsupported), null)
    expect(problem.fix?.label).toBe('Turn supervision off')
    expect(fixAll(configWith(unsupported)).nodes[0].supervision).toBe('none')
  })

  it('checks a heartbeat time of 0', () => {
    const node = { ...genericNode(2), heartbeatProducerMs: 0 }
    expect(checkCanopenNetwork(configWith(node), null)[0].text).toBe(
      'is supervised by heartbeat with a heartbeat time of 0',
    )
    const asIs = { ...fullNode(4), configure: false }
    expect(checkCanopenNetwork(configWith(asIs), null)[0].text).toContain('its EDS default heartbeat time is 0')
  })

  it('removes heartbeats a node cannot watch', () => {
    const consumers = (...ids: number[]) => ids.map((id, k) => ({ id: `c${k}`, producerNodeId: id, consumerMs: 500 }))
    const tooMany = { ...fullNode(4), heartbeatConsumers: consumers(2, 2) }
    const config = configWith(genericNode(2), tooMany)
    expect(checkCanopenNetwork(config, null).map((p) => p.text)).toEqual([
      'watches more heartbeats than its 0x1016 has entries for (1)',
    ])
    expect(fixAll(config).nodes[1].heartbeatConsumers).toHaveLength(1)
    const own = { ...fullNode(4), heartbeatConsumers: consumers(4) }
    expect(checkCanopenNetwork(configWith(own), null)[0].text).toBe('watches its own heartbeat')
    const silent = { ...genericNode(2), supervision: 'none' as const }
    const watcher = { ...fullNode(4), heartbeatConsumers: consumers(2) }
    expect(checkCanopenNetwork(configWith(silent, watcher), null)[0].text).toBe(
      'watches node 2 (io2), which sends no heartbeat',
    )
    const short = { ...fullNode(4), heartbeatConsumers: [{ id: 'c', producerNodeId: 2, consumerMs: 50 }] }
    expect(fixAll(configWith(genericNode(2), short)).nodes[1].heartbeatConsumers[0].consumerMs).toBe(150)
  })

  it('removes a startup SDO that makes a node a SYNC producer', () => {
    const node = genericNode(2)
    node.sdos = [
      { id: 'sync', index: 0x1005, subIndex: 0, dataType: 'UNSIGNED32', value: '0x40000080' },
      { id: 'plain', index: 0x1005, subIndex: 0, dataType: 'UNSIGNED32', value: '0x80' },
      { id: 'other', index: 0x2100, subIndex: 0, dataType: 'UNSIGNED32', value: '1' },
    ]
    const config = configWith(node)
    config.network.syncMode = 'plc_cycle'
    expect(checkCanopenNetwork(config, null)[0].fix?.label).toBe('Remove that startup SDO')
    expect(fixAll(config).nodes[0].sdos.map((s) => s.id)).toEqual(['plain', 'other'])
    config.network.syncWindowUs = 20000
    expect(fixAll(config, 10000).network.syncWindowUs).toBe(5000)
  })
})

describe('validateCanopenProject with node options', () => {
  it('checks the boot-up timeout and the TIME period', () => {
    const config = configWith(genericNode(2))
    config.network.bootTimeoutMs = 50
    config.network.time = { enabled: true, cobId: 0x100, periodMs: 5 }
    expect(validateCanopenProject([canopenDevice('net', config)])).toEqual([
      'CANopen "net": the boot-up timeout must be 100 - 60000 ms',
      'CANopen "net": the TIME period must be 10 - 65535 ms',
    ])
  })
})

describe('PLC cycle', () => {
  it('is the greatest common divisor of the cyclic tasks', () => {
    expect(
      plcCycleUs([
        { triggering: 'Cyclic', interval: 'T#20ms' },
        { triggering: 'Cyclic', interval: 'T#30ms' },
        { triggering: 'Interrupt', interval: 'T#1ms' },
      ]),
    ).toBe(10000)
    expect(plcCycleUs([])).toBeNull()
    expect(roundUpToCycle(105, 10000)).toBe(110)
    expect(roundUpToCycle(3, 2500)).toBe(5)
  })
})

describe('network defaults', () => {
  it('has the documented defaults', () => {
    const net = defaultNetworkSettings()
    expect(net.bootTimeoutMs).toBe(2000)
    expect(net.onNodeError).toBe('restart')
    expect(net.time).toEqual({ enabled: false, cobId: 0x100, periodMs: 1000 })
    expect(net.newNodeDefaults).toEqual({ heartbeatTimeoutPercent: 150, supervision: 'auto', emcy: true })
  })
})
