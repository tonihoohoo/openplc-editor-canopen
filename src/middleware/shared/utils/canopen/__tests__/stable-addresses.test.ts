import type { IecAddressRegistry } from '../../iec-address/registry/types'
import { keepCanopenAddresses } from '../stable-addresses'

const byte = { direction: 'I', size: 'B' } as const

describe('keepCanopenAddresses', () => {
  it('keeps CANopen addresses pinned and unpins only one an earlier channel holds', () => {
    const registry: IecAddressRegistry = {
      assignments: {},
      consumers: [
        { id: 'pins', kind: 'pin-mapping', order: 0, channels: [{ channelId: 'p', class: byte, pinned: '%IB0' }] },
        {
          id: 'canopen:a',
          kind: 'canopen',
          order: 1,
          channels: [
            { channelId: 'state', class: byte, pinned: '%IB0' },
            { channelId: 'in', class: byte, pinned: '%IB5' },
          ],
        },
        { id: 'canopen:b', kind: 'canopen', order: 2, channels: [{ channelId: 'in', class: byte, pinned: '%IB5' }] },
      ],
    }
    const kept = keepCanopenAddresses(registry)
    const pinned = kept.consumers.map((c) => c.channels.map((ch) => ch.pinned))
    expect(pinned).toEqual([['%IB0'], [undefined, '%IB5'], [undefined]])
  })
})
