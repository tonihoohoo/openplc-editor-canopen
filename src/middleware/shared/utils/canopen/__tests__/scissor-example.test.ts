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
})
