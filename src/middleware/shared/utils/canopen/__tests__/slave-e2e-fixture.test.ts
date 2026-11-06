import { readFileSync } from 'fs'
import { join } from 'path'

import { PLCServerSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import { generateCanopenConfig } from '../generate-canopen-config'
import { validateCanopenSlaves } from '../slave'

const fixture = (project: string): string =>
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'e2e',
    'fixtures',
    project,
    'project',
    'devices',
    'servers',
    'slave.json',
  )

const FIXTURE = fixture('canopen-slave')

describe('the end-to-end CANopen slave project', () => {
  it('loads, validates and writes node 5 with the objects and PDOs the master script uses', () => {
    const server = PLCServerSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
    expect(validateCanopenSlaves([server], [])).toEqual([])
    const conf: unknown = JSON.parse(generateCanopenConfig([], null, [server]) ?? '')
    expect(conf).toMatchObject({
      version: 12,
      networks: [],
      devices: [
        {
          interface: 'vcan0',
          node_id: 5,
          heartbeat_ms: 100,
          identity: { vendor_id: 0xabcd, hardware_version: 'HW 2' },
          master_watch: { node_id: 127, time_ms: 500 },
          objects: [
            { index: 0x2000, subindex: 1, location: '%IW0' },
            { index: 0x2000, subindex: 2, location: '%IB0' },
            { index: 0x2000, subindex: 3, exchange: 'sdo', default: 1000, min: 100, max: 30000 },
            { index: 0x2000, subindex: 4, type: 'UNSIGNED8', bits: Array.from({ length: 8 }, (_, i) => `%IX0.${i}`) },
            { index: 0x2100, subindex: 1, location: '%QW0' },
            { index: 0x2100, subindex: 2, location: '%QW1' },
            { index: 0x2100, subindex: 3, type: 'UNSIGNED8', bits: Array.from({ length: 8 }, (_, i) => `%QX0.${i}`) },
            { index: 0x2100, subindex: 4, location: '%QW2' },
            { index: 0x2200, subindex: 1, exchange: 'constant', value: 'SN-0001' },
          ],
          rpdos: [
            {
              cob_id: 0x205,
              entries: [
                { index: 0x2000, subindex: 1 },
                { index: 0x2000, subindex: 2 },
                { index: 0x2000, subindex: 4 },
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
                { index: 0x2100, subindex: 3 },
              ],
            },
            { number: 5, transmission: 255, entries: [{ index: 0x2100, subindex: 4 }] },
          ],
        },
      ],
    })
    // TPDO 5 waits for the master's COB-ID, so the runtime starts it off.
    expect(conf).not.toHaveProperty('devices.0.tpdos.1.cob_id')
  })
  it('writes the LSS project as the same slave waiting for the master with serial number 23', () => {
    const server = PLCServerSchema.parse(JSON.parse(readFileSync(fixture('canopen-slave-lss'), 'utf8')))
    const plain = PLCServerSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
    expect(validateCanopenSlaves([server], [])).toEqual([])
    const conf: unknown = JSON.parse(generateCanopenConfig([], null, [server]) ?? '')
    const plainConf: unknown = JSON.parse(generateCanopenConfig([], null, [plain]) ?? '')
    expect(conf).toMatchObject({
      devices: [
        {
          node_id: 5,
          identity: { vendor_id: 0xabcd, product_code: 1, revision: 0x10000 },
          lss: { enabled: true, wait_for_master: true, serial: 23, bitrate_change: true },
        },
      ],
    })
    expect(plainConf).toMatchObject({ devices: [{ lss: null }] })
  })
})
