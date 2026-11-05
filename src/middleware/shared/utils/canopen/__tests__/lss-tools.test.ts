import type { CanopenRequest } from '../../../ports/canopen-online'
import type { CanopenRuntimeFetch } from '../../../ports/canopen-status'
import type { CanopenConfig, CanopenNode } from '../../../ports/canopen-types'
import {
  createCanopenOnline,
  type LssDevice,
  lssMatch,
  lssNodeForDevice,
  lssNodeIdChoices,
  placeholderAddress,
  serviceBitrateNote,
} from '..'
import { configWith, genericNode } from './fixtures/helpers'

function fakeRoute(answers: unknown[]) {
  const sent: CanopenRequest[] = []
  const send = (request: CanopenRequest): Promise<CanopenRuntimeFetch> => {
    sent.push(request)
    return Promise.resolve({ success: true, body: answers.shift() })
  }
  return { sent, send }
}

const noSleep = { sleep: () => Promise.resolve(), pollMs: 100 }
const wire = { vendor_id: 1, product_code: 2, revision: 3, serial_number: 0x5678 }

function deviceOf(node: CanopenNode, serialNumber: number): LssDevice {
  return { vendorId: node.eds.vendorId, productCode: node.eds.productCode, revision: 3, serialNumber }
}

describe('the lss requests', () => {
  it('finds devices and reports those that answered so far while it runs', async () => {
    const route = fakeRoute([
      { job: 4 },
      { state: 'pending' },
      { state: 'pending', devices: [wire] },
      { state: 'done', devices: [wire] },
    ])
    const progress: LssDevice[][] = []
    const result = await createCanopenOnline(route.send, noSleep).lssFind(0, (d) => progress.push(d))
    const device = { vendorId: 1, productCode: 2, revision: 3, serialNumber: 0x5678 }
    expect(result).toEqual({ ok: true, devices: [device] })
    expect(progress).toEqual([[device]])
    expect(route.sent[0]).toEqual({ op: 'lss', network: 0, action: 'find' })
  })

  it('keeps the devices found when the search stops early', async () => {
    const route = fakeRoute([{ job: 4 }, { state: 'failed', reason: 'too_many', devices: [wire] }])
    const result = await createCanopenOnline(route.send, noSleep).lssFind(0)
    expect(result.ok).toBe(false)
    expect(result.devices).toHaveLength(1)
    if (!result.ok) expect(result.message).toContain('64 devices')
  })

  it('gives a node ID with the LSS address and reports the previous one', async () => {
    const route = fakeRoute([{ job: 5 }, { state: 'done', previous_id: 255, stored: true }])
    const device = { vendorId: 1, productCode: 2, revision: 3, serialNumber: 0x5678 }
    await expect(createCanopenOnline(route.send, noSleep).lssSetId(0, device, 4, true)).resolves.toEqual({
      ok: true,
      previousId: 255,
      stored: true,
    })
    expect(route.sent[0]).toEqual({ op: 'lss', network: 0, action: 'set_id', node_id: 4, store: true, ...wire })
  })

  it('reports refusals in words', async () => {
    const device = { vendorId: 1, productCode: 2, revision: 3, serialNumber: 0x5678 }
    const busy = fakeRoute([{ job: 5 }, { state: 'failed', reason: 'node_in_use' }])
    const r = await createCanopenOnline(busy.send, noSleep).lssSetId(0, device, 2, false)
    expect(r).toEqual({ ok: false, reason: 'node_in_use', message: 'a running node of the network has this node ID' })
    const rate = fakeRoute([{ job: 6 }, { state: 'failed', reason: 'needs_service_mode' }])
    const b = await createCanopenOnline(rate.send, noSleep).lssSetBitrate(0, device, 125000)
    expect(b.ok).toBe(false)
    expect(rate.sent[0]).toEqual({ op: 'lss', network: 0, action: 'set_bitrate', bitrate: 125000, ...wire })
    const done = fakeRoute([{ job: 7 }, { state: 'done', stored: true }])
    await expect(createCanopenOnline(done.send, noSleep).lssSetBitrate(0, device, 125000)).resolves.toEqual({
      ok: true,
    })
  })
})

describe('matching a found device to the project', () => {
  const lssNode = (id: number, serialNumber: number): CanopenNode => {
    const node = genericNode(id)
    return {
      ...node,
      eds: { ...node.eds, lssSupported: true },
      lss: { enabled: true, serialNumber, revision: 0, store: false },
    }
  }

  it('prefers the node with the serial number, then a device file with the product', () => {
    const config = configWith(genericNode(2), lssNode(3, 0x1234))
    expect(lssMatch(deviceOf(config.nodes[1], 0x1234), config)).toEqual({ kind: 'node', node: config.nodes[1] })
    const other = lssMatch(deviceOf(config.nodes[1], 0x9999), config)
    expect(other.kind).toBe('file')
    expect(lssMatch({ vendorId: 0x77, productCode: 1, revision: 0, serialNumber: 1 }, config)).toEqual({
      kind: 'none',
    })
  })

  it('looks in the other networks for a device file', () => {
    const config: CanopenConfig = configWith()
    const other = configWith(genericNode(5))
    expect(lssMatch(deviceOf(other.nodes[0], 1), config, [other]).kind).toBe('file')
  })

  it('offers the free node IDs first and never the master', () => {
    const config = configWith(genericNode(2), genericNode(3))
    const { free, taken } = lssNodeIdChoices(config)
    expect(free[0]).toBe(1)
    expect(free).not.toContain(2)
    expect(free).not.toContain(config.network.masterNodeId)
    expect(taken).toEqual([2, 3])
  })

  it('makes an LSS node when the device file lists LSS support', () => {
    const config = configWith(genericNode(2))
    const eds = { ...config.nodes[0].eds, lssSupported: true }
    const options = { id: 'n', newId: () => 'x', allocate: placeholderAddress }
    const device = deviceOf(config.nodes[0], 0x5678)
    const node = lssNodeForDevice(config, eds, device, 4, true, options)
    expect(node.nodeId).toBe(4)
    expect(node.lss).toEqual({ enabled: true, serialNumber: 0x5678, revision: 3, store: true })
    expect(node.name).not.toBe(config.nodes[0].name)
    expect(lssNodeForDevice(config, config.nodes[0].eds, device, 4, true, options).lss).toBeUndefined()
  })

  it('notes a bus open at another bit rate', () => {
    expect(serviceBitrateNote(null, 250000)).toBeNull()
    expect(serviceBitrateNote(250000, 250000)).toBeNull()
    expect(serviceBitrateNote(125000, 250000)).toContain('125 kbit/s')
  })
})
