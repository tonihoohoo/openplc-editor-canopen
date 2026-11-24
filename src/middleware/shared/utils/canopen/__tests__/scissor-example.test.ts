import { readFileSync } from 'fs'
import { join } from 'path'

import { PLCRemoteDeviceSchema } from '../../../../../backend/shared/types/PLC/open-plc'
import { nodeEntries } from '../model'
import { validateCanopenProject } from '../validate-canopen-config'

const CHASSIS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'examples',
  'canopen',
  'scissor-lift',
  'chassis-controller',
)

describe('the scissor lift example', () => {
  it('maps the node bytes it reads bit by bit and its program uses their aliases, not masks', () => {
    const device = PLCRemoteDeviceSchema.parse(
      JSON.parse(readFileSync(join(CHASSIS, 'devices', 'remote', 'machine_bus.json'), 'utf8')),
    )
    expect(validateCanopenProject([device])).toEqual([])
    const aliases = new Set(
      (device.canopenConfig?.nodes ?? []).flatMap((n) => nodeEntries(n).flatMap((e) => (e.alias ? [e.alias] : []))),
    )
    const program = readFileSync(join(CHASSIS, 'pous', 'programs', 'main.st'), 'utf8')
    const bound = Array.from(program.matchAll(/AT (\w+) : BOOL;/g), (m) => m[1])
    expect(bound).toContain('platform_enable_switch')
    expect(bound.filter((a) => !aliases.has(a))).toEqual([])
    expect(program).not.toMatch(/AND 16#/)
  })

  it('keeps node IDs fixed: no LSS assignment on the master, the platform box starts as node 10', () => {
    const bus = readFileSync(join(CHASSIS, 'devices', 'remote', 'machine_bus.json'), 'utf8')
    expect(bus).not.toContain('"lss"')
    const box = JSON.parse(
      readFileSync(join(CHASSIS, '..', 'platform-box', 'devices', 'servers', 'box.json'), 'utf8'),
    ) as { canopenSlaveConfig: { nodeId: number; lss: Record<string, unknown> } }
    expect(box.canopenSlaveConfig.nodeId).toBe(10)
    expect(box.canopenSlaveConfig.lss).toMatchObject({ enabled: true })
    expect(box.canopenSlaveConfig.lss).not.toHaveProperty('waitForMaster')
  })
})
