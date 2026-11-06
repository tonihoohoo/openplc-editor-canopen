import { lssAddressText, lssDeviceName, lssNodeFacts } from '..'
import { genericNode } from './fixtures/helpers'

const device = { vendorId: 1, productCode: 2, revision: 3, serialNumber: 0x1234 }
const time = (t: number) => `t${t}`

describe('LSS display texts', () => {
  it('names a found device by the device file it matches', () => {
    const node = genericNode(2)
    expect(lssDeviceName({ kind: 'node', node })).toBe(node.eds.productName)
    expect(lssDeviceName({ kind: 'file', eds: node.eds, fileName: 'io.eds' })).toBe(node.eds.productName)
    expect(lssDeviceName({ kind: 'none' })).toBe('Unknown device')
  })

  it('gives the full LSS address in one line', () => {
    expect(lssAddressText(device)).toBe('Vendor 0x00000001, product 0x00000002, revision 0x00000003, serial 0x00001234')
  })

  it('says how the node got its ID and what the master looks for', () => {
    const address = { vendorId: 1, productCode: 2, serialNumber: 0x1234, productName: 'IO' }
    const given = lssNodeFacts({ result: 'given', previous_id: 255, stored: true, time: 5 }, 3, address, time)
    expect(given.map((f) => [f.value, f.detail, f.tone])).toEqual([
      ['3', 'Given by the master, stored in the device', 'plain'],
      ['0x00001234', 'Serial number, IO', 'plain'],
      ['Given', 't5', 'good'],
    ])
    const lost = lssNodeFacts({ result: 'not_found' }, 3, undefined, time)
    expect(lost.map((f) => [f.value, f.detail, f.tone])).toEqual([
      ['-', 'Not given: no device answered', 'plain'],
      ['-', 'Serial number', 'plain'],
      ['No answer', '', 'bad'],
    ])
    expect(lssNodeFacts({ result: 'store_refused' }, 3, undefined, time)[0].value).toBe('3')
    expect(lssNodeFacts({ result: 'none' }, 3, undefined, time)[2].tone).toBe('plain')
  })
})
