import type { CanopenRequest } from '../../../ports/canopen-online'
import { parseCanopenAnswer } from '../../../ports/canopen-online'
import type { CanopenRuntimeFetch } from '../../../ports/canopen-status'
import {
  addCommissionedNode,
  addToProjectCheck,
  answeredCount,
  bitrateBlock,
  commissionList,
  defaultCommissionBitrate,
  deviceLssAddress,
  matchingFiles,
  newCommissionNetwork,
  newNetworkName,
  nodeIdRefusal,
  pickedFileWarning,
  projectDeviceFiles,
  projectInterfaces,
  scopesFromCount,
} from '../commissioning'
import { createCanopenOnline, type ScanDevice } from '../online'
import { configWith, genericNode } from './fixtures/helpers'

const scanned = (nodeId: number, over: Partial<ScanDevice> = {}): ScanDevice => ({
  nodeId,
  answered: true,
  heard: [],
  deviceType: 401,
  vendorId: 1,
  productCode: 2,
  revision: 3,
  serialNumber: 0x100 + nodeId,
  ...over,
})
const unconfigured = { vendorId: 1, productCode: 2, revision: 3, serialNumber: 0x55 }

describe('the commissioning list', () => {
  it('lists answered node IDs, then heard-only IDs, then devices without a node ID', () => {
    const list = commissionList(
      [scanned(127), scanned(12, { answered: false, heard: ['heartbeat'] }), scanned(10)],
      [unconfigured],
    )
    expect(list.map((d) => d.key)).toEqual(['node:10', 'node:127', 'heard:12', 'lss:1:2:3:85'])
    expect(answeredCount(list)).toBe(3)
  })

  it('counts a scan ID that was neither answered nor heard as nothing', () => {
    expect(commissionList([scanned(5, { answered: false })], [])).toEqual([])
  })

  it('has the full LSS address only when every part was read', () => {
    const [full, partial] = commissionList([scanned(10), scanned(11, { serialNumber: null })], [])
    expect(deviceLssAddress(full)).toEqual({ vendorId: 1, productCode: 2, revision: 3, serialNumber: 0x10a })
    expect(deviceLssAddress(partial)).toBeNull()
  })
})

describe('node ID and bit rate rules', () => {
  const list = commissionList([scanned(10), scanned(127)], [])
  it('refuses an ID another device of the last search uses', () => {
    expect(nodeIdRefusal(list, list[1], 10)).toBe('Node 10 is already on the bus.')
    expect(nodeIdRefusal(list, list[1], 127)).toBe('The device has node ID 127 already.')
    expect(nodeIdRefusal(list, list[1], 0)).toBe('A node ID is 1 to 127.')
    expect(nodeIdRefusal(list, list[1], 20)).toBeNull()
  })

  it('allows a bit rate only when exactly one device answered', () => {
    expect(bitrateBlock(list)).toBe('The device must be alone on the link to change its bit rate; 2 devices answered.')
    expect(bitrateBlock([])).toBe('Find the device first.')
    expect(bitrateBlock(commissionList([scanned(127)], []))).toBeNull()
    expect(
      bitrateBlock(commissionList([scanned(127), scanned(5, { answered: false, heard: ['emcy'] })], [])),
    ).toBeNull()
  })
})

describe('device files for a device', () => {
  const node = genericNode(2)
  const other = { ...genericNode(3), eds: { ...node.eds, revision: 9, fileName: 'newer.eds', source: undefined } }
  const files = projectDeviceFiles([configWith(node), configWith(other)])

  it('lists the files of the project once each', () => {
    expect(projectDeviceFiles([configWith(node), configWith(genericNode(4))])).toHaveLength(1)
    expect(files).toHaveLength(2)
  })

  it('matches by vendor ID and product code, the same revision first, then the newest', () => {
    const { vendorId, productCode } = node.eds
    const same = matchingFiles(files, { vendorId, productCode, revision: node.eds.revision, serialNumber: 1 })
    expect(same[0].eds.revision).toBe(node.eds.revision)
    const otherRevision = matchingFiles(files, { vendorId, productCode, revision: 1234, serialNumber: 1 })
    expect(otherRevision[0].eds.revision).toBe(9)
    expect(matchingFiles(files, { vendorId: null, productCode, revision: 1, serialNumber: 1 })).toEqual([])
    expect(matchingFiles(files, { vendorId: vendorId + 1, productCode, revision: 1, serialNumber: 1 })).toEqual([])
  })

  it('warns when a picked file is for another device', () => {
    const { vendorId, productCode } = node.eds
    expect(pickedFileWarning(node.eds, { vendorId, productCode, revision: 0, serialNumber: 0 })).toBeNull()
    expect(
      pickedFileWarning(node.eds, { vendorId: vendorId + 1, productCode, revision: 0, serialNumber: 0 }),
    ).toContain('This file is for another device: vendor ID')
  })
})

describe('save and restore without a device file', () => {
  it('names each sub-index the device reports by CiA 301', () => {
    expect(scopesFromCount(4).map((s) => s.name)).toEqual([
      'All parameters',
      'Communication parameters',
      'Application parameters',
      'Manufacturer specific (sub 4)',
    ])
    expect(scopesFromCount(0)).toEqual([])
  })
})

describe('the bus and Add to project', () => {
  it('opens at the bit rate of the network on the interface, else 125 kbit/s', () => {
    const config = configWith(genericNode(2))
    const net = { ...config, network: { ...config.network, interface: 'can0', bitrate: 500000 } }
    expect(defaultCommissionBitrate([net], 'can0')).toBe(500000)
    expect(defaultCommissionBitrate([net], 'can1')).toBe(125000)
    expect(projectInterfaces([net])).toEqual(['can0'])
    expect(projectInterfaces([])).toEqual(['can0'])
  })

  it('refuses a used ID and warns about another bit rate', () => {
    const config = configWith(genericNode(10))
    const net = { ...config, network: { ...config.network, bitrate: 500000 } }
    expect(addToProjectCheck(net, 10, 500000).error).toContain('node 10 already')
    expect(addToProjectCheck(net, net.network.masterNodeId, 500000).error).toContain('master')
    expect(addToProjectCheck(net, 11, 125000)).toEqual({
      error: null,
      warning:
        'The network runs at 500 kbit/s, the device was found at 125 kbit/s. Set the device to 500 kbit/s first.',
    })
    expect(addToProjectCheck(null, 11, 125000)).toEqual({ error: null, warning: null })
  })

  it('adds a node with the default PDOs of the file, and stores a picked file', () => {
    const eds = { ...genericNode(2).eds, source: { format: 'eds' as const, fileName: 'p.eds', sha256: 'abc' } }
    const empty = newCommissionNetwork('can1', 250000)
    expect(empty.network).toMatchObject({ interface: 'can1', bitrate: 250000 })
    let n = 0
    const { config, node } = addCommissionedNode(
      empty,
      { eds, fileName: 'p.eds', text: '[FileInfo]', picked: true },
      10,
      { id: 'a', newId: () => `id${n++}`, allocate: () => '%IX0.0' },
    )
    expect(node.nodeId).toBe(10)
    expect(node.tpdos.length + node.rpdos.length).toBeGreaterThan(0)
    expect(config.nodes).toHaveLength(1)
    expect(config.files).toEqual({ abc: { fileName: 'p.eds', text: '[FileInfo]' } })
  })

  it('names a new network once', () => {
    expect(newNetworkName([])).toBe('canopen_network')
    expect(newNetworkName(['canopen_network', 'canopen_network_2'])).toBe('canopen_network_3')
  })
})

describe('the commissioning requests', () => {
  const runtime = (answers: (r: CanopenRequest) => unknown) => {
    const sent: CanopenRequest[] = []
    const send = (r: CanopenRequest): Promise<CanopenRuntimeFetch> => {
      sent.push(r)
      return Promise.resolve({ success: true, body: answers(r) })
    }
    return { sent, client: createCanopenOnline(send, { sleep: () => Promise.resolve() }) }
  }

  it('opens service mode for commissioning, with take over when asked', async () => {
    const { sent, client } = runtime(() => ({ ok: true, network: 1 }))
    expect(await client.openCommission('Device commissioning', 'can0', 125000, false)).toEqual({
      ok: true,
      bytes: [],
      network: 1,
    })
    await client.openCommission('Device commissioning', 'can0', 125000, true)
    expect(sent[0]).toMatchObject({ op: 'service_open', interface: 'can0', bitrate: 125000, commission: true })
    expect(sent[0]).not.toHaveProperty('take_over')
    expect(sent[0]).not.toHaveProperty('nodes')
    expect(sent[1]).toMatchObject({ commission: true, take_over: true })
  })

  it('names the network or slave that refused the open', async () => {
    const net = runtime(() => ({ error: 'network_on_interface', name: 'machine' }))
    expect(await net.client.openCommission('x', 'can0', 125000, false)).toMatchObject({
      ok: false,
      reason: 'network_on_interface',
      name: 'machine',
      message: 'the network machine runs on this interface, kept on the bus at PLC stop',
    })
    const slave = runtime(() => ({ error: 'slave_on_interface', name: 'io' }))
    expect(await slave.client.openCommission('x', 'can0', 125000, true)).toMatchObject({
      reason: 'slave_on_interface',
      message: expect.stringContaining('the slave io of the runtime') as unknown,
    })
  })

  it('scans with partial results and ends with the devices', async () => {
    const device = {
      node_id: 10,
      answered: true,
      heard: ['heartbeat'],
      device_type: 401,
      vendor_id: 1,
      product_code: 2,
      revision: 3,
      serial_number: 4,
    }
    const heard = { ...device, node_id: 12, answered: false, device_type: null, vendor_id: null }
    let polls = 0
    const { client } = runtime((r) => {
      if (r.op === 'scan') return { job: 7 }
      polls++
      return polls === 1 ? { state: 'pending', devices: [device] } : { state: 'done', devices: [device, heard] }
    })
    const progress: number[] = []
    const result = await client.scan(0, (d) => progress.push(d.length))
    expect(progress).toEqual([1])
    expect(result).toMatchObject({
      ok: true,
      devices: [
        { nodeId: 10, answered: true, heard: ['heartbeat'], deviceType: 401, serialNumber: 4 },
        { nodeId: 12, answered: false, vendorId: null },
      ],
    })
  })

  it('refuses a scan outside commissioning service mode', async () => {
    const { client } = runtime(() => ({ error: 'not_commissioning' }))
    expect(await client.scan(0)).toMatchObject({
      ok: false,
      message: 'only while the bus is open for device commissioning',
    })
  })

  it('reads scan and LSS devices in answers', () => {
    expect(parseCanopenAnswer({ state: 'done', devices: [] })).toEqual({ state: 'done', devices: [] })
    expect(
      parseCanopenAnswer({
        state: 'done',
        devices: [{ vendor_id: 1, product_code: 2, revision: 3, serial_number: 4 }],
      }),
    ).not.toBeNull()
    expect(parseCanopenAnswer({ state: 'done', devices: [{ node_id: 0, answered: true }] })).toBeNull()
  })
})
