import { checkCanopenNetwork, fixAllCanopenProblems, roundDownToCycle } from '../check-fix'
import { receiveTimeoutWarning, sentOnlyOnChange } from '../editing'
import { generateCanopenConfig } from '../generate-canopen-config'
import { effectiveEventTimerMs } from '../model'
import { canopenDevice, configWith, genericNode } from './fixtures/helpers'

describe('receive timeout', () => {
  it('is written for inputs only when set', () => {
    const node = genericNode(2)
    node.tpdos[0] = { ...node.tpdos[0], receiveTimeoutMs: 250 }
    const json: unknown = JSON.parse(generateCanopenConfig([canopenDevice('CANopen_1', configWith(node))]) ?? '')
    expect(json).toMatchObject({
      version: 3,
      networks: [{ nodes: [{ tpdos: [{ number: 1, receive_timeout_ms: 250 }] }] }],
    })
    const text = generateCanopenConfig([canopenDevice('CANopen_1', configWith(genericNode(2)))]) ?? ''
    expect(text).not.toContain('receive_timeout_ms')
  })

  it('warns when the PDO would be late between two regular frames', () => {
    const node = genericNode(2)
    const pdo = node.tpdos[0]
    expect(receiveTimeoutWarning(node, { ...pdo, receiveTimeoutMs: 0, eventTimerMs: 500 }, null)).toBeNull()
    expect(
      receiveTimeoutWarning(node, { ...pdo, transmissionType: 255, eventTimerMs: 500, receiveTimeoutMs: 200 }, null),
    ).toContain('event timer (500 ms)')
    expect(
      receiveTimeoutWarning(node, { ...pdo, transmissionType: 255, eventTimerMs: 500, receiveTimeoutMs: 1200 }, null),
    ).toBeNull()
    const sync = { ...pdo, transmissionType: 2, eventTimerMs: 0 }
    expect(receiveTimeoutWarning(node, { ...sync, receiveTimeoutMs: 30 }, 10000)).toContain(
      'two SYNC intervals of this PDO (40 ms)',
    )
    expect(receiveTimeoutWarning(node, { ...sync, receiveTimeoutMs: 40 }, 10000)).toBeNull()
    expect(receiveTimeoutWarning(node, { ...sync, receiveTimeoutMs: 30 }, null)).toBeNull()
  })

  it('treats types 0, and 254 and 255 without event timer, as sent only on a change', () => {
    expect(sentOnlyOnChange(0, 20)).toBe(true)
    expect(sentOnlyOnChange(254, 0)).toBe(true)
    expect(sentOnlyOnChange(255, 0)).toBe(true)
    expect(sentOnlyOnChange(255, 100)).toBe(false)
    expect(sentOnlyOnChange(1, 0)).toBe(false)
  })

  it('warns on a PDO sent only on a change and names the ways out', () => {
    const node = { ...genericNode(2), onLoss: 'zero' as const }
    const pdo = { ...node.tpdos[0], transmissionType: 255, eventTimerMs: 0, receiveTimeoutMs: 250 }
    const zero = receiveTimeoutWarning(node, pdo, null)
    expect(zero).toBe(
      'The PDO is sent only when an input changes, so while the inputs are steady it is reported late after 250 ms and its inputs read 0. To avoid it, set an event timer shorter than the timeout, pick a cyclic SYNC type or set the timeout to 0',
    )
    const hold = receiveTimeoutWarning({ ...node, onLoss: 'hold' }, pdo, null)
    expect(hold).toContain('reported late after 250 ms.')
    expect(hold).not.toContain('read 0')
    expect(receiveTimeoutWarning(node, { ...pdo, transmissionType: 254 }, null)).toContain('only when an input changes')
    expect(receiveTimeoutWarning(node, { ...pdo, eventTimerMs: 100 }, null)).toBeNull()
    expect(receiveTimeoutWarning(node, { ...pdo, receiveTimeoutMs: 0 }, null)).toBeNull()
  })

  it('warns on a synchronous acyclic PDO without offering an event timer', () => {
    const node = genericNode(2)
    const pdo = { ...node.tpdos[0], transmissionType: 0, eventTimerMs: 20, receiveTimeoutMs: 250 }
    const text = receiveTimeoutWarning(node, pdo, 10000)
    expect(text).toContain('only at a SYNC after an input changes')
    expect(text).toContain('pick a cyclic SYNC type or set the timeout to 0')
    expect(text).not.toContain('event timer')
  })

  it('checks the event timer the node uses when the master does not write it', () => {
    const base = genericNode(6)
    const node = { ...base, configure: false }
    const pdo = { ...base.tpdos[0], transmissionType: 254, eventTimerMs: 0, receiveTimeoutMs: 250 }
    expect(effectiveEventTimerMs(node, pdo)).toBe(20)
    expect(receiveTimeoutWarning(node, pdo, null)).toBeNull()
    const eds = {
      ...base.eds,
      objects: base.eds.objects.map((o) => (o.index === 0x1800 && o.subIndex === 5 ? { ...o, defaultValue: '0' } : o)),
    }
    const noTimer = { ...node, eds }
    const text = receiveTimeoutWarning(noTimer, { ...pdo, eventTimerMs: 100 }, null)
    expect(text).toContain('only when an input changes')
    expect(text).toContain('To avoid it, set the timeout to 0')
  })

  it('rounds down to the PLC cycle', () => {
    expect(roundDownToCycle(125, 20000)).toBe(120)
    expect(roundDownToCycle(125, 1500)).toBe(123)
    expect(roundDownToCycle(5, 10000)).toBe(0)
  })

  it('offers an event timer of half the timeout in check and fix', () => {
    const node = genericNode(2)
    node.tpdos[0] = { ...node.tpdos[0], transmissionType: 255, eventTimerMs: 0, receiveTimeoutMs: 250 }
    const config = configWith(node)
    const problems = checkCanopenNetwork(config, 20000).filter((p) => p.where === 'node 2 (io2) TPDO 1')
    expect(problems).toHaveLength(1)
    expect(problems[0].level).toBe('warning')
    expect(problems[0].text).toBe(
      'has a receive timeout, but the PDO is sent only when an input changes, so while the inputs are steady it is reported late after 250 ms',
    )
    expect(problems[0].fix?.label).toBe('Set event timer to 120 ms')
    const fixed = problems[0].fix?.apply(config)
    expect(fixed?.nodes[0].tpdos[0].eventTimerMs).toBe(120)
    expect(checkCanopenNetwork(fixed ?? config, 20000).filter((p) => p.where === 'node 2 (io2) TPDO 1')).toEqual([])
    expect(checkCanopenNetwork(config, null)[0]?.fix?.label).toBe('Set event timer to 125 ms')
  })

  it('clears the timeout when no event timer helps', () => {
    const base = genericNode(6)
    const configured = { ...base, configure: false }
    const eds = {
      ...base.eds,
      objects: base.eds.objects.map((o) => (o.index === 0x1800 && o.subIndex === 5 ? { ...o, defaultValue: '0' } : o)),
    }
    configured.eds = eds
    configured.tpdos = [{ ...base.tpdos[0], transmissionType: 255, receiveTimeoutMs: 250 }, ...base.tpdos.slice(1)]
    const config = configWith(configured)
    const problem = checkCanopenNetwork(config, null).find((p) => p.where === 'node 6 (io6) TPDO 1')
    expect(problem?.fix?.label).toBe('Clear the receive timeout')
    expect(fixAllCanopenProblems(config, null).nodes[0].tpdos[0].receiveTimeoutMs).toBe(0)

    const sync = genericNode(2)
    sync.tpdos[0] = { ...sync.tpdos[0], transmissionType: 0, receiveTimeoutMs: 250 }
    const syncProblem = checkCanopenNetwork(configWith(sync), null).find((p) => p.where === 'node 2 (io2) TPDO 1')
    expect(syncProblem?.fix?.label).toBe('Clear the receive timeout')

    const short = genericNode(2)
    short.tpdos[0] = { ...short.tpdos[0], transmissionType: 255, eventTimerMs: 0, receiveTimeoutMs: 15 }
    const shortProblem = checkCanopenNetwork(configWith(short), 10000).find((p) => p.where === 'node 2 (io2) TPDO 1')
    expect(shortProblem?.fix?.label).toBe('Clear the receive timeout')
  })
})
