import { PLCRemoteDeviceSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import type { CanopenConfig } from '../../../ports/canopen-types'
import { buildAddressPool } from '../../iec-address/address-pool'
import { ALL_ADDRESS_PRODUCERS_ACTIVE } from '../../target-capabilities/presets'
import { canopenNetworksOff, generateCanopenConfig } from '../generate-canopen-config'
import { defaultCanopenConfig } from '../model'
import { validateCanopenProject } from '../validate-canopen-config'
import { canopenDevice, configWith, genericNode } from './fixtures/helpers'

const off = (config: CanopenConfig): CanopenConfig => ({ ...config, network: { ...config.network, enabled: false } })

describe('network on/off', () => {
  it('is on for a new network and for a saved project without the setting', () => {
    expect(defaultCanopenConfig().network.enabled).toBe(true)
    const { enabled: _dropped, ...saved } = defaultCanopenConfig().network
    const parsed = PLCRemoteDeviceSchema.parse({
      name: 'net',
      protocol: 'canopen',
      canopenConfig: { network: saved, nodes: [] },
    })
    expect(parsed.canopenConfig?.network.enabled).toBe(true)
  })

  it('leaves a network that is off out of the file, and writes no file when none is on', () => {
    const line1 = canopenDevice('line_1', configWith(genericNode(2)))
    const line2 = canopenDevice('line_2', off(configWith(genericNode(3))))
    const text = generateCanopenConfig([line1, line2])
    expect(JSON.parse(text ?? '').networks.map((n: { name: string }) => n.name)).toEqual(['line_1'])
    expect(generateCanopenConfig([line2])).toBeNull()
    expect(canopenNetworksOff([line1, line2]).map((d) => d.name)).toEqual(['line_2'])
  })

  it('does not stop the build on errors of a network that is off, but lists them on request', () => {
    const clash = configWith(genericNode(4), { ...genericNode(4), id: 'other', name: 'io4b' })
    const device = canopenDevice('net', off(clash))
    expect(validateCanopenProject([device])).toEqual([])
    expect(validateCanopenProject([device], null, { includeOff: true })).toContain(
      'CANopen "net" node 4 (io4b) and node 4 (io4) have the same node ID',
    )
  })

  it('leaves a network that is off out of the checks between networks', () => {
    const errors = validateCanopenProject([
      canopenDevice('a', off(configWith(genericNode(2)))),
      canopenDevice('b', configWith(genericNode(2))),
    ])
    expect(errors).toEqual([])
  })

  it('keeps the addresses and aliases of a network that is off', () => {
    const config = configWith(genericNode(2))
    const claimed = (c: CanopenConfig): string[] =>
      [
        ...buildAddressPool(
          { remoteDevices: [canopenDevice('net', c)] },
          ALL_ADDRESS_PRODUCERS_ACTIVE,
        ).byAddress.values(),
      ]
        .map((a) => `${a.address}=${a.alias ?? ''}`)
        .sort()
    expect(claimed(off(config))).toEqual(claimed(config))
    expect(claimed(config).length).toBeGreaterThan(0)
  })
})
