import { readFileSync } from 'fs'
import { join } from 'path'

import { PLCRemoteDeviceSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import { generateCanopenConfig } from '../generate-canopen-config'
import { validateCanopenProject } from '../validate-canopen-config'

const FIXTURE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'e2e',
  'fixtures',
  'canopen-generic-io',
  'project',
  'devices',
  'remote',
  'canopen_1.json',
)

describe('the end-to-end CANopen project', () => {
  it('loads, validates and maps node 2 bit by bit to the addresses its program uses, with optional node 9', () => {
    const device = PLCRemoteDeviceSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
    expect(validateCanopenProject([device])).toEqual([])
    const conf: unknown = JSON.parse(generateCanopenConfig([device]) ?? '')
    const bits = (prefix: string) => Array.from({ length: 8 }, (_, k) => `${prefix}0.${k}`)
    expect(conf).toMatchObject({
      networks: [
        {
          interface: 'vcan0',
          bitrate: 0,
          nodes: [
            {
              node_id: 2,
              tpdos: [{ entries: [{ bits: bits('%IX') }, { location: '%IW0' }] }],
              rpdos: [{ entries: [{ bits: bits('%QX') }] }],
            },
            { node_id: 9, optional: true, state_location: '%IB2', tpdos: [], rpdos: [] },
          ],
        },
      ],
    })
  })
})
