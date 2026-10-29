import type { BoardInfo, PLCVariable } from '@root/middleware/shared/ports/types'
import {
  canopenDevice,
  configWith,
  genericNode,
} from '@root/middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import { buildAddressPool, buildAliasRegistry } from '@root/middleware/shared/utils/iec-address'
import { canopenPoolEntries } from '@root/middleware/shared/utils/iec-address/address-pool'
import { placeholderAddress, withEntryAlias } from '@root/middleware/shared/utils/canopen'

import type { OpenPLCStore } from '../index'
import { createTestStore } from '../testing'

const RUNTIME_V4: BoardInfo = {
  compiler: 'openplc-compiler',
  core: 'rt-v4',
  preview: '',
  specs: {},
  capabilities: {
    pinMapping: false,
    vppIo: false,
    modbusTcpRemote: true,
    ethercat: true,
    modbusTcpServer: true,
    opcuaServer: true,
    s7Server: true,
    debuggerTransports: ['websocket'],
    pythonFunctionBlocks: true,
    arduinoApiCompletions: false,
    hasRuntimeStats: true,
    isInProcessSimulator: false,
    directUsbUpload: false,
  },
}

function seedRuntimeV4(store: OpenPLCStore) {
  store.getState().deviceActions.setAvailableOptions({ availableBoards: new Map([['OpenPLC Runtime v4', RUNTIME_V4]]) })
  store.getState().deviceActions.setDeviceBoard('OpenPLC Runtime v4')
}

const configOf = (store: OpenPLCStore, name = 'CANopen_1') =>
  store.getState().project.data.remoteDevices?.find((d) => d.name === name)?.canopenConfig

describe('CANopen device in the project store', () => {
  let store: OpenPLCStore
  beforeEach(() => {
    store = createTestStore()
    seedRuntimeV4(store)
  })

  it('creates a CANopen device with the default network', () => {
    const result = store
      .getState()
      .projectActions.createRemoteDevice({ data: { name: 'CANopen_1', protocol: 'canopen' } })
    expect(result.ok).toBe(true)
    expect(configOf(store)).toMatchObject({ network: { interface: 'can0', bitrate: 500000 }, nodes: [] })
  })

  it('refuses a config for a missing or non-CANopen device', () => {
    store.getState().projectActions.createRemoteDevice({ data: { name: 'Bus', protocol: 'ethercat' } })
    const config = configWith()
    expect(store.getState().projectActions.updateCanopenConfig('Missing', config)).toEqual({
      ok: false,
      message: 'Remote device not found',
    })
    expect(store.getState().projectActions.updateCanopenConfig('Bus', config)).toEqual({
      ok: false,
      message: 'Device is not a CANopen device',
    })
  })

  it('places placeholder addresses at free locations of their class', () => {
    store.getState().projectActions.createRemoteDevice({ data: { name: 'CANopen_1', protocol: 'canopen' } })
    const a = genericNode(2, placeholderAddress)
    const b = { ...genericNode(3, placeholderAddress), id: 'node-3b' }
    store.getState().projectActions.updateCanopenConfig('CANopen_1', configWith(a, b))
    const nodes = configOf(store)?.nodes ?? []
    const all = nodes.flatMap((n) => canopenPoolEntries(n).map((e) => e.iecLocation))
    expect(new Set(all).size).toBe(all.length)
    expect(all.filter((l) => l.startsWith('%IB')).sort()).toEqual(['%IB0', '%IB1', '%IB2', '%IB3'])
    expect(all.filter((l) => l.startsWith('%QB')).sort()).toEqual(['%QB0', '%QB1'])
    expect(all.filter((l) => l.startsWith('%IW')).sort()).toEqual(['%IW0', '%IW1'])
  })

  it('claims CANopen addresses and aliases in the address pool', () => {
    store.getState().projectActions.createRemoteDevice({ data: { name: 'CANopen_1', protocol: 'canopen' } })
    const node = withEntryAlias(genericNode(2), 'state', 'io2_state')
    store.getState().projectActions.updateCanopenConfig('CANopen_1', configWith(node))
    const pool = buildAddressPool(
      { pinMapping: { pins: [] }, remoteDevices: store.getState().project.data.remoteDevices },
      { pinMapping: false, vppIo: false, modbusTcpRemote: true, ethercat: true },
    )
    const registry = buildAliasRegistry(pool)
    expect(registry.byAlias.get('io2_state')).toMatchObject({
      address: '%IB0',
      source: { kind: 'canopen', ref: 'CANopen_1:io2:state' },
    })
    const off = buildAddressPool(
      { pinMapping: { pins: [] }, remoteDevices: [canopenDevice('CANopen_1', configWith(node))] },
      { pinMapping: false, vppIo: false, modbusTcpRemote: true, ethercat: false },
    )
    expect(off.byAddress.size).toBe(0)
  })

  it('cascades an alias rename onto bound variables', () => {
    store.getState().projectActions.createRemoteDevice({ data: { name: 'CANopen_1', protocol: 'canopen' } })
    const node = genericNode(2)
    const channel = node.rpdos[0].entries[0].channelId
    store.getState().projectActions.updateCanopenConfig('CANopen_1', configWith(withEntryAlias(node, channel, 'lamp')))
    const variable: PLCVariable = {
      name: 'out',
      class: 'global',
      type: { definition: 'base-type', value: 'BYTE' },
      location: 'lamp',
      documentation: '',
    }
    const project = store.getState().project
    store.getState().projectActions.setProject({
      ...project,
      data: {
        ...project.data,
        configurations: {
          ...project.data.configurations,
          resource: { ...project.data.configurations.resource, globalVariables: [variable] },
        },
      },
    })
    const current = configOf(store)
    if (!current) throw new Error('no CANopen config')
    const renamed = { ...current, nodes: current.nodes.map((n) => withEntryAlias(n, channel, 'lamp1')) }
    store.getState().projectActions.updateCanopenConfig('CANopen_1', renamed)
    expect(store.getState().project.data.configurations.resource.globalVariables[0].location).toBe('lamp1')
  })
})
