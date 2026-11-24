import { CanopenConfigSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import { writeEds, writeXdd } from '../device-writer'
import { parseEds } from '../eds-parser'
import { generateCanopenConfig } from '../generate-canopen-config'
import { parseXdd } from '../xdd-parser'
import { canopenDevice, configWith, GENERIC_IO_EDS, genericNode } from './fixtures/helpers'

const LSS_EDS = GENERIC_IO_EDS.replace('LSS_Supported=0', 'LSS_Supported=1')

type Out = { version: number; networks: Array<{ nodes: Array<Record<string, unknown>> }> }

describe('LSS support in the device file', () => {
  it('is read from LSS_Supported and written back', () => {
    expect(parseEds(GENERIC_IO_EDS, 'a.eds').lssSupported).toBeUndefined()
    const eds = parseEds(LSS_EDS, 'a.eds')
    expect(eds.lssSupported).toBe(true)
    const now = new Date(Date.UTC(2026, 10, 5))
    expect(writeEds(eds, { fileName: 'b.eds', now })).toContain('LSS_Supported=1')
    const xdd = writeXdd(eds, { fileName: 'b.xdd', now })
    expect(xdd).toContain('layerSettingServiceSlave="true"')
    expect(parseXdd(xdd, 'b.xdd').eds.lssSupported).toBe(true)
  })
})

describe('no LSS assignment by the master (format 15)', () => {
  it('writes format 15 with no lss object on a node', () => {
    const out = JSON.parse(
      generateCanopenConfig([canopenDevice('CANopen_1', configWith(genericNode(2)))]) ?? 'null',
    ) as Out
    expect(out.version).toBe(15)
    expect(out.networks[0].nodes[0]).not.toHaveProperty('lss')
  })

  it('drops the lss settings of a node when a project is opened', () => {
    const config = configWith(genericNode(3))
    const old = {
      ...config,
      nodes: config.nodes.map((n) => ({
        ...n,
        lss: { enabled: true, serialNumber: 0x1234, revision: 0, store: true },
      })),
    }
    const parsed = CanopenConfigSchema.parse(old)
    expect(parsed.nodes[0]).not.toHaveProperty('lss')
  })
})
