import type { CanopenEdsInfo, CanopenNode, CanopenObject } from '../../../ports/canopen-types'
import { checkCanopenNetwork } from '../check-fix'
import { generateCanopenConfig, nodeConfigurationSdos } from '../generate-canopen-config'
import { createCanopenNode, effectiveEmcy, emcySupport, fixedEmcyCobId, withNodeId } from '../model'
import { canopenDevice, configWith, genericIoEds, sequentialAllocator } from './fixtures/helpers'

/** The generic I/O module with its 0x1014 replaced, or removed when `access` is undefined. */
const edsWithEmcy = (access?: CanopenObject['access'], defaultValue = '$NODEID+0x80'): CanopenEdsInfo => {
  const eds = genericIoEds()
  const objects = eds.objects.filter((o) => o.index !== 0x1014)
  if (access)
    objects.push({
      index: 0x1014,
      subIndex: 0,
      name: 'COB-ID EMCY',
      dataType: 'UNSIGNED32',
      access,
      pdoMapping: false,
      defaultValue,
    })
  return { ...eds, objects }
}

const node = (eds: CanopenEdsInfo, nodeId = 4): CanopenNode =>
  createCanopenNode(eds, {
    id: `node-${nodeId}`,
    name: `io${nodeId}`,
    nodeId,
    newId: () => `ch${nodeId}`,
    allocate: sequentialAllocator(),
  })

describe('emcySupport', () => {
  it('reads the support from 0x1014', () => {
    expect(emcySupport(edsWithEmcy())).toBe('none')
    expect(emcySupport(edsWithEmcy('rw'))).toBe('writable')
    expect(emcySupport(edsWithEmcy('ro'))).toBe('fixed')
    expect(emcySupport(edsWithEmcy('const'))).toBe('fixed')
    expect(emcySupport(edsWithEmcy('ro', '0x80000000+$NODEID+0x80'))).toBe('none')
    expect(emcySupport(edsWithEmcy('rw', '0x80000000+$NODEID+0x80'))).toBe('writable')
  })

  it('takes a fixed COB-ID from the EDS default with the node ID resolved', () => {
    expect(fixedEmcyCobId(edsWithEmcy('ro'), 2)).toBe(0x82)
    expect(fixedEmcyCobId(edsWithEmcy('ro', '0x0F5'), 2)).toBe(0x0f5)
    expect(fixedEmcyCobId(edsWithEmcy('ro', ''), 3)).toBe(0x83)
  })
})

describe('emergency of new nodes', () => {
  it('is off without 0x1014 whatever the default', () => {
    expect(node(edsWithEmcy()).emcy).toEqual({ enabled: false, cobId: 0x84 })
  })

  it('follows the default and the EDS COB-ID when 0x1014 is read-only', () => {
    expect(node(edsWithEmcy('ro', '0x0F5')).emcy).toEqual({ enabled: true, cobId: 0x0f5 })
    expect(withNodeId(node(edsWithEmcy('ro')), 9).emcy.cobId).toBe(0x89)
  })

  it('is on with the predefined COB-ID when 0x1014 is writable', () => {
    expect(node(edsWithEmcy('rw')).emcy).toEqual({ enabled: true, cobId: 0x84 })
  })
})

describe('effective emergency', () => {
  it('turns off a saved emergency the device cannot send', () => {
    const saved = { ...node(edsWithEmcy()), emcy: { enabled: true, cobId: 0x84 } }
    expect(effectiveEmcy(saved).enabled).toBe(false)
    const conf = JSON.parse(generateCanopenConfig([canopenDevice('net', configWith(saved))]) ?? '')
    expect(conf.networks[0].nodes[0].emcy).toEqual({ enabled: false, cob_id: 0x84 })
    expect(nodeConfigurationSdos(saved, configWith(saved).network).some((s) => s.index === 0x1014)).toBe(false)
  })

  it('listens on the EDS COB-ID when 0x1014 is read-only', () => {
    const saved = { ...node(edsWithEmcy('ro'), 2), emcy: { enabled: true, cobId: 0x0f0 } }
    const conf = JSON.parse(generateCanopenConfig([canopenDevice('net', configWith(saved))]) ?? '')
    expect(conf.networks[0].nodes[0].emcy).toEqual({ enabled: true, cob_id: 0x82 })
    expect(nodeConfigurationSdos(saved, configWith(saved).network).some((s) => s.index === 0x1014)).toBe(false)
  })

  it('reserves no COB-ID for a node without 0x1014', () => {
    const quiet = { ...node(edsWithEmcy(), 4), emcy: { enabled: true, cobId: 0x84 } }
    const sender = { ...node(edsWithEmcy('rw'), 5), emcy: { enabled: true, cobId: 0x84 } }
    expect(checkCanopenNetwork(configWith(quiet, sender), null).some((p) => p.text.includes('emergency'))).toBe(false)
  })

  it('offers no move for a clash on a fixed COB-ID', () => {
    const fixed = node(edsWithEmcy('ro'), 2)
    const other = { ...node(edsWithEmcy('rw'), 5), emcy: { enabled: true, cobId: 0x82 } }
    const clash = checkCanopenNetwork(configWith(other, fixed), null).find((p) =>
      p.text.startsWith('node 2 (io2) emergency'),
    )
    expect(clash).toBeDefined()
    expect(clash?.fix).toBeUndefined()
  })
})
