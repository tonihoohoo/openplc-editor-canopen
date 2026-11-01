import { readFileSync } from 'fs'
import { join } from 'path'

import type { StlibArchiveDTO } from '../../../../middleware/shared/ports/library-port'
import type { PLCProjectData } from '../../../../middleware/shared/ports/types'
import { injectLibraryBlocks } from '../../library/inject-library-blocks'
import { __setStrucppRuntimeForTests, loadStrucpp } from '../../library/strucpp-runtime'
import { buildCanopenLibrary, type CanopenLibraryManifest } from '../build-library'

const ROOT = join(__dirname, '..', '..', '..', '..', '..', 'resources', 'libraries')
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8')

const pins = (variables: Array<{ name: string; class?: string; type: { value: string } }>, cls: string): string[] =>
  variables.filter((v) => v.class === cls).map((v) => `${v.name}:${v.type.value.toUpperCase()}`)

beforeAll(() => __setStrucppRuntimeForTests(null))

describe('the canopen block library', () => {
  const built = buildCanopenLibrary({
    manifest: JSON.parse(read('canopen', 'library.json')) as CanopenLibraryManifest,
    typesSt: read('canopen', 'src', 'types.st'),
    sharedCode: read('canopen', 'src', 'shared.inc'),
  })

  it('builds, and the committed archive and block sources are current (npm run build:canopen-lib)', () => {
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(read('canopen.stlib')).toBe(built.archiveText)
    for (const block of built.blocks) expect(read('canopen', 'blocks', block.fileName)).toBe(block.source)
  })

  it('declares the CiA 405 blocks as C++ blocks with documentation, and no dependency', () => {
    const archive = JSON.parse(read('canopen.stlib')) as StlibArchiveDTO & { dependencies: unknown[] }
    expect(archive.dependencies).toEqual([])
    expect(archive.manifest.name).toBe('canopen')
    const blocks = archive.manifest.functionBlocks ?? []
    expect(blocks.map((b) => b.name).sort()).toEqual(
      [
        'GET_CANOPEN_KERNEL_STATE',
        'GET_LOCAL_NODE_ID',
        'GET_STATE',
        'NMT',
        'RECV_EMCY',
        'RECV_EMCY_DEV',
        'SDO_READ4',
        'SDO_READ_DATA',
        'SDO_READ_STRING',
        'SDO_WRITE4',
        'SDO_WRITE_DATA',
        'SDO_WRITE_STRING',
      ].sort(),
    )
    for (const b of blocks) {
      expect(b.implementation).toBe('cpp')
      expect(b.documentation).toMatch(/Example: /)
    }
  })

  it('is grafted into a project that enables it, with the CiA 405 pins', () => {
    const archive = JSON.parse(read('canopen.stlib')) as StlibArchiveDTO
    const project = { pous: [], libraries: [{ name: 'canopen', version: '1.0.0' }] } as unknown as PLCProjectData
    const grafted = injectLibraryBlocks(project, [archive]).pous
    expect(grafted).toHaveLength(12)
    const read4 = grafted.find((p) => p.name === 'SDO_READ4')
    const vars = read4?.interface?.variables ?? []
    expect(pins(vars, 'input')).toEqual([
      'NETWORK:USINT',
      'ENABLE:BOOL',
      'DEVICE:USINT',
      'INDEX:WORD',
      'SUBINDEX:BYTE',
      'TIMEOUT:TIME',
    ])
    expect(pins(vars, 'output')).toEqual([
      'CONFIRM:BOOL',
      'BUSY:BOOL',
      'ERROR:USINT',
      'ERRORINFO:UDINT',
      'ERRORTEXT:STRING',
      'DATA:DWORD',
      'DATALENGTH:USINT',
    ])
    const body = read4?.body.value
    expect(typeof body === 'string' ? body : '').toContain('#ifndef CANOPEN_FB_SHARED_INCLUDED')
    // Not enabled: nothing is grafted.
    expect(injectLibraryBlocks({ ...project, libraries: [] }, [archive]).pous).toHaveLength(0)
  })

  it('gives a program the constants and the bit-exact REAL helpers', () => {
    const archive = JSON.parse(read('canopen.stlib')) as Parameters<ReturnType<typeof loadStrucpp>['compile']>[1]
    const program = `PROGRAM main
VAR r : REAL; d : DWORD; e : USINT; END_VAR
r := CANOPEN_DWORD_TO_REAL(16#3FC00000);
d := CANOPEN_REAL_TO_DWORD(r);
IF e = CANOPEN_KERNEL_TIMEOUT OR e = STOPPED THEN e := START_REMOTE_NODE; END_IF;
END_PROGRAM
CONFIGURATION c RESOURCE r ON PLC TASK t(INTERVAL := T#20ms, PRIORITY := 1); PROGRAM i WITH t : main; END_RESOURCE END_CONFIGURATION
`
    const result = loadStrucpp().compile(program, { libraries: [archive] } as never)
    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
    expect(result.cppCode).toContain('__builtin_memcpy')
  })
})
