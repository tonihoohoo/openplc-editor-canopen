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
  it('loads, validates and maps node 2 to the addresses its program uses, with optional node 9', () => {
    const device = PLCRemoteDeviceSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
    expect(validateCanopenProject([device])).toEqual([])
    const conf: unknown = JSON.parse(generateCanopenConfig([device]) ?? '')
    expect(conf).toMatchObject({
      networks: [
        {
          interface: 'vcan0',
          bitrate: 0,
          nodes: [
            {
              node_id: 2,
              tpdos: [{ entries: [{ location: '%IB1' }, { location: '%IW0' }] }],
              rpdos: [{ entries: [{ location: '%QB0' }] }],
            },
            { node_id: 9, optional: true, state_location: '%IB2', tpdos: [], rpdos: [] },
          ],
        },
      ],
    })
  })
})
