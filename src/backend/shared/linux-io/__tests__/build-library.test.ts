import { readFileSync } from 'fs'
import { join } from 'path'

import type { StlibArchiveDTO } from '../../../../middleware/shared/ports/library-port'
import type { PLCProjectData } from '../../../../middleware/shared/ports/types'
import type { CanopenLibraryManifest } from '../../canopen/build-library'
import { injectLibraryBlocks } from '../../library/inject-library-blocks'
import { __setStrucppRuntimeForTests, loadStrucpp } from '../../library/strucpp-runtime'
import { buildLinuxIoLibrary } from '../build-library'

const ROOT = join(__dirname, '..', '..', '..', '..', '..', 'resources', 'libraries')
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8')

const pins = (variables: Array<{ name: string; class?: string; type: { value: string } }>, cls: string): string[] =>
  variables.filter((v) => v.class === cls).map((v) => `${v.name}:${v.type.value.toUpperCase()}`)

beforeAll(() => __setStrucppRuntimeForTests(null))

describe('the linux_io block library', () => {
  const built = buildLinuxIoLibrary({
    manifest: JSON.parse(read('linux_io', 'library.json')) as CanopenLibraryManifest,
    typesSt: read('linux_io', 'src', 'types.st'),
    sharedCode: read('linux_io', 'src', 'shared.inc'),
  })

  it('builds, and the committed archive and block sources are current (npm run build:linux-io-lib)', () => {
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(read('linux_io.stlib')).toBe(built.archiveText)
    for (const block of built.blocks) expect(read('linux_io', 'blocks', block.fileName)).toBe(block.source)
  })

  it('declares five C++ blocks with documentation, and no dependency', () => {
    const archive = JSON.parse(read('linux_io.stlib')) as StlibArchiveDTO & { dependencies: unknown[] }
    expect(archive.dependencies).toEqual([])
    expect(archive.manifest.name).toBe('linux_io')
    const blocks = archive.manifest.functionBlocks ?? []
    expect(blocks.map((b) => b.name).sort()).toEqual(['GPIO_IN', 'GPIO_OUT', 'IIO_READ', 'PWM_OUT', 'READ_VALUE'])
    for (const b of blocks) {
      expect(b.implementation).toBe('cpp')
      expect(b.documentation).toMatch(/Example: /)
    }
  })

  it('is grafted into a project that enables it, with its pins', () => {
    const archive = JSON.parse(read('linux_io.stlib')) as StlibArchiveDTO
    const project = { pous: [], libraries: [{ name: 'linux_io', version: '1.0.0' }] } as unknown as PLCProjectData
    const grafted = injectLibraryBlocks(project, [archive]).pous
    expect(grafted).toHaveLength(5)
    const of = (name: string, cls: string): string[] =>
      pins(grafted.find((p) => p.name === name)?.interface?.variables ?? [], cls)
    const result = ['VALID:BOOL', 'ERROR:USINT', 'ERRORTEXT:STRING']
    expect(of('GPIO_IN', 'input')).toEqual([
      'ENABLE:BOOL',
      'PIN:STRING',
      'BIAS:USINT',
      'ACTIVE_LOW:BOOL',
      'DEBOUNCE:TIME',
    ])
    expect(of('GPIO_IN', 'output')).toEqual([...result, 'Q:BOOL'])
    expect(of('GPIO_OUT', 'input')).toEqual([
      'ENABLE:BOOL',
      'PIN:STRING',
      'VALUE:BOOL',
      'DRIVE:USINT',
      'ACTIVE_LOW:BOOL',
      'ON_STOP:USINT',
    ])
    expect(of('GPIO_OUT', 'output')).toEqual(result)
    expect(of('PWM_OUT', 'input')).toEqual([
      'ENABLE:BOOL',
      'CHIP:STRING',
      'CHANNEL:USINT',
      'FREQUENCY:REAL',
      'DUTY:REAL',
      'ON_STOP:USINT',
    ])
    expect(of('READ_VALUE', 'input')).toEqual([
      'ENABLE:BOOL',
      'PATH:STRING',
      'SCALE:REAL',
      'OFFSET:REAL',
      'PERIOD:TIME',
    ])
    expect(of('READ_VALUE', 'output')).toEqual([...result, 'VALUE:REAL', 'RAW:LINT'])
    expect(of('IIO_READ', 'input')).toEqual(['ENABLE:BOOL', 'DEVICE:STRING', 'CHANNEL:STRING', 'PERIOD:TIME'])
    expect(of('IIO_READ', 'output')).toEqual([...result, 'VALUE:REAL', 'RAW:DINT'])
    for (const p of grafted) {
      const body = typeof p.body.value === 'string' ? p.body.value : ''
      expect(body).toContain('#ifndef LINUX_IO_SHARED_INCLUDED')
      // Off Linux the block touches no pin and says so.
      expect(body).toContain('ERRORTEXT = "not supported on this target";')
    }
    expect(injectLibraryBlocks({ ...project, libraries: [] }, [archive]).pous).toHaveLength(0)
  })

  it('gives a program its constants', () => {
    const archive = JSON.parse(read('linux_io.stlib')) as Parameters<ReturnType<typeof loadStrucpp>['compile']>[1]
    const program = `PROGRAM main
VAR e : USINT; END_VAR
IF e = LIO_BUSY OR e = LIO_NOT_SUPPORTED THEN e := LIO_BIAS_PULL_UP; END_IF;
e := LIO_DRIVE_OPEN_DRAIN + LIO_STOP_HOLD + LIO_BIAS_PULL_DOWN;
END_PROGRAM
CONFIGURATION c RESOURCE r ON PLC TASK t(INTERVAL := T#20ms, PRIORITY := 1); PROGRAM i WITH t : main; END_RESOURCE END_CONFIGURATION
`
    const result = loadStrucpp().compile(program, { libraries: [archive] } as never)
    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
  })
})
