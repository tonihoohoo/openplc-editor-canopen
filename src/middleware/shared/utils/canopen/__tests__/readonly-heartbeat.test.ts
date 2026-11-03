import { checkCanopenNetwork } from '../check-fix'
import { parseEds } from '../eds-parser'
import { nodeBootWrites } from '../generate-canopen-config'
import { createCanopenNode, defaultCanopenConfig, effectiveProducerMs } from '../model'
import { validateCanopenProject } from '../validate-canopen-config'
import { canopenDevice, configWith, GENERIC_IO_EDS, sequentialAllocator } from './fixtures/helpers'

const HEARTBEAT =
  '[1017]\nParameterName=Producer heartbeat time\nObjectType=0x7\nDataType=0x0006\nAccessType=rw\nDefaultValue=0'

function nodeWithHeartbeat(access: string, ms: number) {
  const text = GENERIC_IO_EDS.replace(
    HEARTBEAT,
    `[1017]\nParameterName=Producer heartbeat time\nObjectType=0x7\nDataType=0x0006\nAccessType=${access}\nDefaultValue=${ms}`,
  )
  let id = 0
  return createCanopenNode(parseEds(text, 'fixed-heartbeat.eds'), {
    id: 'node-2',
    name: 'io2',
    nodeId: 2,
    newId: () => `ch${++id}`,
    allocate: sequentialAllocator(),
  })
}

const errors = (config: ReturnType<typeof configWith>) =>
  checkCanopenNetwork(config, null).filter((p) => p.level === 'error')

describe('heartbeat time the master cannot write', () => {
  it('uses the device file time for the timeout check', () => {
    const node = { ...nodeWithHeartbeat('ro', 1000), supervision: 'heartbeat' as const }
    node.heartbeatProducerMs = 100
    node.heartbeatConsumerMs = 150
    expect(effectiveProducerMs(node)).toBe(1000)
    const config = configWith(node)
    const problem = errors(config).find((p) => p.text.includes('heartbeat timeout'))
    expect(problem?.text).toBe("the heartbeat timeout (150 ms) must be longer than the node's heartbeat time (1000 ms)")
    expect(validateCanopenProject([canopenDevice('net', config)]).some((e) => e.includes('1000 ms'))).toBe(true)
    expect(nodeBootWrites(node, config.network).some((w) => w.index === 0x1017)).toBe(false)
    const fixed = problem?.fix?.apply(config)
    expect(fixed && errors(fixed)).toEqual([])
  })

  it('refuses heartbeat supervision when the device file time is 0', () => {
    const node = { ...nodeWithHeartbeat('const', 0), supervision: 'heartbeat' as const }
    const problem = errors(configWith(node)).find((p) => p.text.includes('sends no heartbeat'))
    expect(problem).toBeDefined()
    const fixed = problem?.fix?.apply(configWith(node))
    expect(fixed?.nodes[0].supervision).toBe('none')
  })

  it('supervises a new node by its fixed heartbeat', () => {
    const node = nodeWithHeartbeat('ro', 500)
    expect(node.supervision).toBe('heartbeat')
    expect(node.heartbeatConsumerMs).toBeGreaterThan(500)
    expect(errors(configWith(node))).toEqual([])
    expect(nodeWithHeartbeat('ro', 0).supervision).not.toBe('heartbeat')
  })

  it('keeps the user value when the master writes 0x1017', () => {
    const node = { ...nodeWithHeartbeat('rw', 0), supervision: 'heartbeat' as const, heartbeatProducerMs: 100 }
    expect(effectiveProducerMs(node)).toBe(100)
    expect(nodeBootWrites(node, defaultCanopenConfig().network).some((w) => w.index === 0x1017)).toBe(true)
  })
})
