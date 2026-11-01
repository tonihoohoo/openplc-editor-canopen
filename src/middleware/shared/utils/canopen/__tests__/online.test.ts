import type { CanopenRequest } from '../../../ports/canopen-online'
import { parseCanopenAnswer } from '../../../ports/canopen-online'
import type { CanopenRuntimeFetch } from '../../../ports/canopen-status'
import { parseCanopenStatus } from '../../../ports/canopen-status'
import type { CanopenObject } from '../../../ports/canopen-types'
import {
  createCanopenOnline,
  dataTypeLabel,
  defaultNetworkSettings,
  encodeForObject,
  encodeOnlineValue,
  encodeRawBytes,
  eventText,
  formatCanopenValue,
  nodeDot,
  nodeStateLabel,
  nvmScopes,
  onlineObjects,
  rawWriteRefusal,
  resetForRestore,
  saveSupport,
  valueDiffers,
} from '..'
import { genericNode } from './fixtures/helpers'
import { sampleStatus } from './fixtures/status'

/** A fake route: answers each request from `answers` in turn and records them. */
function fakeRoute(answers: unknown[]) {
  const sent: CanopenRequest[] = []
  const send = (request: CanopenRequest): Promise<CanopenRuntimeFetch> => {
    sent.push(request)
    const body = answers.shift()
    return Promise.resolve(body === 'down' ? { success: false, error: 'connection refused' } : { success: true, body })
  }
  return { sent, send }
}

const noSleep = { sleep: () => Promise.resolve(), pollMs: 100 }

describe('createCanopenOnline', () => {
  it('reads through a job it polls until done', async () => {
    const route = fakeRoute([{ job: 7 }, { state: 'pending' }, { state: 'done', data: 'e803' }])
    const online = createCanopenOnline(route.send, noSleep)
    await expect(online.read(0, 2, 0x1017, 0)).resolves.toEqual({ ok: true, bytes: [0xe8, 0x03] })
    expect(route.sent).toEqual([
      { op: 'sdo_read', network: 0, node: 2, index: 0x1017, subindex: 0 },
      { op: 'job', job: 7 },
      { op: 'job', job: 7 },
    ])
  })

  it('writes hex bytes and reports an abort in words', async () => {
    const route = fakeRoute([{ job: 8 }, { state: 'failed', abort_code: 0x08000022 }])
    const result = await createCanopenOnline(route.send, noSleep).write(0, 2, 0x2100, 0, [0x14, 0x00])
    expect(route.sent[0]).toEqual({ op: 'sdo_write', network: 0, node: 2, index: 0x2100, subindex: 0, data: '1400' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.abortCode).toBe(0x08000022)
      expect(result.message).toContain('0x08000022')
    }
  })

  it('turns refusals, failed jobs and transport errors into messages', async () => {
    const online = createCanopenOnline(
      fakeRoute([
        { error: 'unknown_node' },
        { job: 1 },
        { state: 'failed', reason: 'booting' },
        'down',
        { active: false },
        { surprise: 1 },
      ]).send,
      noSleep,
    )
    const unknown = await online.read(0, 9, 0x1000, 0)
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown_node' })
    expect(await online.read(0, 2, 0x1000, 0)).toMatchObject({ ok: false, reason: 'booting' })
    expect(await online.nmt(0, 2, 'start')).toMatchObject({ ok: false, message: 'connection refused' })
    expect(await online.nmt(0, 2, 'start')).toMatchObject({ ok: false, reason: 'inactive' })
    expect(await online.closeService()).toMatchObject({ ok: false, reason: 'error' })
  })

  it('polls a job soon at first, then less often', async () => {
    const waits: number[] = []
    const answers: unknown[] = [
      { job: 4 },
      ...Array.from({ length: 6 }, () => ({ state: 'pending' })),
      { state: 'done' },
    ]
    const online = createCanopenOnline(fakeRoute(answers).send, {
      pollMs: 100,
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })
    await online.read(0, 2, 0x1000, 0)
    expect(waits).toEqual([10, 20, 50, 100, 100, 100])
  })

  it('gives up on a job that stays pending', async () => {
    const answers: unknown[] = [{ job: 3 }, ...Array.from({ length: 40 }, () => ({ state: 'pending' }))]
    const online = createCanopenOnline(fakeRoute(answers).send, { ...noSleep, timeoutMs: 1000 })
    expect(await online.read(0, 2, 0x1000, 0)).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('sends NMT and opens service mode with the network settings', async () => {
    const route = fakeRoute([{ ok: true }, { ok: true, network: 0 }, { ok: true }])
    const online = createCanopenOnline(route.send, noSleep)
    const network = { ...defaultNetworkSettings(), interface: 'can1', bitrate: 500000 }
    expect(await online.nmt(0, 0, 'pre_operational')).toEqual({ ok: true, bytes: [] })
    expect(await online.openService('canopen_1', network, [2, 3])).toEqual({ ok: true, bytes: [] })
    expect(await online.closeService()).toEqual({ ok: true, bytes: [] })
    expect(route.sent).toEqual([
      { op: 'nmt', network: 0, node: 0, command: 'pre_operational' },
      {
        op: 'service_open',
        name: 'canopen_1',
        interface: 'can1',
        bitrate: 500000,
        master_node_id: network.masterNodeId,
        sdo_timeout_ms: network.sdoTimeoutMs,
        nodes: [2, 3],
      },
      { op: 'service_close' },
    ])
  })
})

describe('values', () => {
  it('formats by type, signed, in hex, and strings as text', () => {
    expect(formatCanopenValue('UNSIGNED16', [0xe8, 0x03], 'decimal')).toBe('1000')
    expect(formatCanopenValue('UNSIGNED16', [0xe8, 0x03], 'hex')).toBe('0x03E8')
    expect(formatCanopenValue('INTEGER16', [0x2e, 0xfb], 'decimal')).toBe('-1234')
    expect(formatCanopenValue('REAL32', [0, 0, 0x80, 0x3f], 'decimal')).toBe('1')
    expect(formatCanopenValue('0x0009', [0x49, 0x2f, 0x4f, 0], 'decimal')).toBe('"I/O"')
    expect(formatCanopenValue('0x000B', [0x41, 0, 0x42, 0], 'decimal')).toBe('"AB"')
    expect(formatCanopenValue('0x000A', [1, 0xab], 'decimal')).toBe('01AB')
    expect(formatCanopenValue('UNSIGNED32', [1, 2], 'decimal')).toBe('0102 (2 bytes, UNSIGNED32 has 4)')
    expect(dataTypeLabel('0x0009')).toBe('VISIBLE_STRING')
    expect(dataTypeLabel('UNSIGNED8')).toBe('UNSIGNED8')
  })

  it('encodes typed values, strings and raw bytes', () => {
    expect(encodeOnlineValue('UNSIGNED16', '1000')).toEqual({ ok: true, bytes: [0xe8, 0x03] })
    expect(encodeOnlineValue('0x0009', 'AB')).toEqual({ ok: true, bytes: [0x41, 0x42] })
    expect(encodeOnlineValue('UNSIGNED8', '300').ok).toBe(false)
    expect(encodeRawBytes('e8 03')).toEqual({ ok: true, bytes: [0xe8, 0x03] })
    expect(encodeRawBytes('0xE803')).toEqual({ ok: true, bytes: [0xe8, 0x03] })
    expect(encodeRawBytes('e8 0').ok).toBe(false)
  })

  it('checks the EDS limits', () => {
    const object: CanopenObject = {
      index: 0x2101,
      subIndex: 0,
      name: 'Gain',
      dataType: 'UNSIGNED16',
      access: 'rw',
      pdoMapping: false,
      lowLimit: '1',
      highLimit: '100',
    }
    expect(encodeForObject(object, '25', 2)).toEqual({ ok: true, bytes: [25, 0] })
    const out = encodeForObject(object, '200', 2)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('1 to 100')
  })

  it('compares the node with the project', () => {
    expect(valueDiffers([0xe8, 0x03], [0xf4, 0x01])).toBe(true)
    expect(valueDiffers([0xe8, 0x03], [0xe8, 0x03])).toBe(false)
    expect(valueDiffers(null, [1])).toBe(false)
  })
})

describe('objects of a node', () => {
  it('takes the project value from what the master writes, else the EDS default', () => {
    const node = { ...genericNode(2), heartbeatProducerMs: 1000, supervision: 'heartbeat' as const }
    const rows = onlineObjects(node, defaultNetworkSettings())
    const heartbeat = rows.find((r) => r.object.index === 0x1017)
    expect(heartbeat).toMatchObject({ project: [0xe8, 0x03], masterWrites: true })
    const parameter = rows.find((r) => r.object.index === 0x2100)
    expect(parameter).toMatchObject({ project: [0, 0, 0, 0], masterWrites: false })
    const name = rows.find((r) => r.object.index === 0x1008)
    expect(name?.project).toBeNull()
    expect(rows.map((r) => r.object.index)).toEqual([...rows.map((r) => r.object.index)].sort((a, b) => a - b))
  })
})

describe('save and restore', () => {
  const nvm = (index: number, subIndex: number, access: CanopenObject['access'], name = ''): CanopenObject => ({
    index,
    subIndex,
    name,
    dataType: 'UNSIGNED32',
    access,
    pdoMapping: false,
  })

  it('lists the writable scopes with their EDS names', () => {
    const node = genericNode(2)
    node.eds.objects.push(
      nvm(0x1010, 0, 'ro'),
      nvm(0x1010, 1, 'rw', 'Save all parameters'),
      nvm(0x1010, 2, 'ro', 'Save communication parameters'),
      nvm(0x1011, 1, 'rw'),
      nvm(0x1011, 4, 'rw'),
    )
    expect(nvmScopes(node.eds, 0x1010)).toEqual([{ subIndex: 1, name: 'Save all parameters' }])
    expect(nvmScopes(node.eds, 0x1011)).toEqual([
      { subIndex: 1, name: 'All parameters' },
      { subIndex: 4, name: 'Manufacturer specific (sub 4)' },
    ])
  })

  it('reads how the node saves', () => {
    expect(saveSupport({ ok: true, bytes: [1, 0, 0, 0] })).toBe('command')
    expect(saveSupport({ ok: true, bytes: [2, 0, 0, 0] })).toBe('auto')
    expect(saveSupport({ ok: true, bytes: [0, 0, 0, 0] })).toBe('none')
    expect(saveSupport({ ok: false, reason: 'timeout', message: '' })).toBe('unknown')
    expect(resetForRestore(2)).toBe('reset_communication')
    expect(resetForRestore(1)).toBe('reset_node')
    expect(rawWriteRefusal(0x1010)).toContain('Save to node')
    expect(rawWriteRefusal(0x1011)).toContain('Restore defaults')
    expect(rawWriteRefusal(0x2000)).toBeNull()
  })
})

describe('answers and status', () => {
  it('parses the route answers', () => {
    expect(parseCanopenAnswer({ job: 4 })).toEqual({ job: 4 })
    expect(parseCanopenAnswer({ state: 'done', data: '0a00' })).toEqual({ state: 'done', data: '0a00' })
    expect(parseCanopenAnswer({ state: 'done', data: 'xyz' })).toBeNull()
    expect(parseCanopenAnswer({ error: 'queue_full' })).toEqual({ error: 'queue_full' })
    expect(parseCanopenAnswer([1])).toBeNull()
  })

  it('reads the manual and service states and the client events', () => {
    const status = sampleStatus()
    const net = status.networks[0]
    const parsed = parseCanopenStatus({
      ...status,
      networks: [
        {
          ...net,
          mode: 'service',
          nodes: [
            { ...net.nodes[0], state: 'manual' },
            { ...net.nodes[1], state: 'service' },
          ],
          events: [
            { time: 1, node: 2, kind: 'sdo_write', index: 0x2100, subindex: 0, ok: false, abort_code: 0x08000022 },
            { time: 2, node: 2, kind: 'nmt_command', command: 'reset_node' },
            { time: 3, kind: 'service', open: true },
          ],
        },
      ],
    })
    expect(parsed?.active).toBe(true)
    if (!parsed?.active) return
    const n = parsed.networks[0]
    expect(n.mode).toBe('service')
    expect(nodeStateLabel(n.nodes[0].state)).toBe('Held by you')
    expect(nodeDot(n.nodes[0])).toBe('amber')
    expect(nodeDot(n.nodes[1])).toBe('grey')
    expect(n.events.map(eventText)).toEqual([
      expect.stringContaining('Online write to 0x2100:00 refused'),
      'NMT reset node sent from the online tools.',
      'Service mode opened.',
    ])
    expect(parseCanopenStatus({ version: 1, active: false })).toEqual({ active: false })
  })
})
