import { readFileSync } from 'fs'
import { join } from 'path'

import { __setStrucppRuntimeForTests, loadStrucpp } from '../../../../../backend/shared/library/strucpp-runtime'
import { PLCServerSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import { generateCanopenConfig } from '../generate-canopen-config'
import { serializeCanopenConstantsToST } from '../plc-names'
import { validateCanopenSlaves } from '../slave'

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..')
const PROJECT = join(ROOT, 'e2e', 'fixtures', 'canopen-slave-blocks', 'project')

beforeAll(() => __setStrucppRuntimeForTests(null))

describe('the end-to-end CANopen slave blocks project', () => {
  const server = PLCServerSchema.parse(
    JSON.parse(readFileSync(join(PROJECT, 'devices', 'servers', 'slave.json'), 'utf8')),
  )

  it('loads, validates and writes node 5 going pre-operational on a PLC stop', () => {
    expect(validateCanopenSlaves([server], [])).toEqual([])
    const conf: unknown = JSON.parse(generateCanopenConfig([], null, [server]) ?? '')
    expect(conf).toMatchObject({
      version: 9,
      devices: [
        {
          name: 'io',
          interface: 'vcan0',
          node_id: 5,
          master_watch: null,
          on_plc_stop_state: 'pre_operational',
          objects: [
            { index: 0x2000, subindex: 1, location: '%IB0' },
            { index: 0x2000, subindex: 2, location: '%ID0' },
            { index: 0x2100, subindex: 1, location: '%QB0' },
            { index: 0x2100, subindex: 2, location: '%QD0' },
            { index: 0x2100, subindex: 3, location: '%QB1' },
            { index: 0x2100, subindex: 4, location: '%QB2' },
            { index: 0x2100, subindex: 5, location: '%QB3' },
          ],
        },
      ],
    })
  })

  it('compiles its program against the canopen library with the slave as a constant', () => {
    const archive = JSON.parse(
      readFileSync(join(ROOT, 'resources', 'libraries', 'canopen.stlib'), 'utf8'),
    ) as Parameters<ReturnType<typeof loadStrucpp>['compile']>[1]
    const program = readFileSync(join(PROJECT, 'pous', 'programs', 'main.st'), 'utf8')
    const constants = serializeCanopenConstantsToST([], false, [server])
    expect(constants).toContain('io : USINT := 1;')
    const source = `${program}\n${constants}\nCONFIGURATION c RESOURCE r ON PLC TASK t(INTERVAL := T#20ms, PRIORITY := 1); PROGRAM i WITH t : main; END_RESOURCE END_CONFIGURATION\n`
    const result = loadStrucpp().compile(source, { libraries: [archive] } as never)
    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
  })
})
