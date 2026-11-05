import { readFileSync } from 'fs'
import { join } from 'path'

import { PLCServerSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import { generateCanopenConfig } from '../generate-canopen-config'
import { validateCanopenSlaves } from '../slave'

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
  'canopen-slave',
  'project',
  'devices',
  'servers',
  'slave.json',
)

describe('the end-to-end CANopen slave project', () => {
  it('loads, validates and writes node 5 with the objects and PDOs the master script uses', () => {
    const server = PLCServerSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
    expect(validateCanopenSlaves([server], [])).toEqual([])
    const conf: unknown = JSON.parse(generateCanopenConfig([], null, [server]) ?? '')
    expect(conf).toMatchObject({
      version: 7,
      networks: [],
      devices: [
        {
          interface: 'vcan0',
          node_id: 5,
          heartbeat_ms: 100,
          identity: { vendor_id: 0xabcd },
          master_watch: { node_id: 127, time_ms: 500 },
          objects: [
            { index: 0x2000, subindex: 1, location: '%IW0' },
            { index: 0x2000, subindex: 2, location: '%IB0' },
            { index: 0x2000, subindex: 3, exchange: 'sdo', default: 1000, min: 100, max: 30000 },
            { index: 0x2100, subindex: 1, location: '%QW0' },
            { index: 0x2100, subindex: 2, location: '%QW1' },
            { index: 0x2200, subindex: 1, exchange: 'constant', value: 'SN-0001' },
          ],
          rpdos: [
            {
              cob_id: 0x205,
              entries: [
                { index: 0x2000, subindex: 1 },
                { index: 0x2000, subindex: 2 },
              ],
            },
          ],
          tpdos: [
            {
              cob_id: 0x185,
              transmission: 255,
              entries: [
                { index: 0x2100, subindex: 1 },
                { index: 0x2100, subindex: 2 },
              ],
            },
          ],
        },
      ],
    })
  })
})
