import { receiveTimeoutWarning } from '../editing'
import { generateCanopenConfig } from '../generate-canopen-config'
import { canopenDevice, configWith, genericNode } from './fixtures/helpers'

describe('receive timeout', () => {
  it('is written for inputs only when set', () => {
    const node = genericNode(2)
    node.tpdos[0] = { ...node.tpdos[0], receiveTimeoutMs: 250 }
    const json: unknown = JSON.parse(generateCanopenConfig([canopenDevice('CANopen_1', configWith(node))]) ?? '')
    expect(json).toMatchObject({
      version: 2,
      networks: [{ nodes: [{ tpdos: [{ number: 1, receive_timeout_ms: 250 }] }] }],
    })
    const text = generateCanopenConfig([canopenDevice('CANopen_1', configWith(genericNode(2)))]) ?? ''
    expect(text).not.toContain('receive_timeout_ms')
  })

  it('warns when the PDO would be late between two regular frames', () => {
    const pdo = genericNode(2).tpdos[0]
    expect(receiveTimeoutWarning({ ...pdo, receiveTimeoutMs: 0, eventTimerMs: 500 }, null)).toBeNull()
    expect(
      receiveTimeoutWarning({ ...pdo, transmissionType: 255, eventTimerMs: 500, receiveTimeoutMs: 200 }, null),
    ).toContain('event timer (500 ms)')
    expect(
      receiveTimeoutWarning({ ...pdo, transmissionType: 255, eventTimerMs: 500, receiveTimeoutMs: 1200 }, null),
    ).toBeNull()
    const sync = { ...pdo, transmissionType: 2, eventTimerMs: 0 }
    expect(receiveTimeoutWarning({ ...sync, receiveTimeoutMs: 30 }, 10000)).toContain(
      'two SYNC intervals of this PDO (40 ms)',
    )
    expect(receiveTimeoutWarning({ ...sync, receiveTimeoutMs: 40 }, 10000)).toBeNull()
    expect(receiveTimeoutWarning({ ...sync, receiveTimeoutMs: 30 }, null)).toBeNull()
  })
})
