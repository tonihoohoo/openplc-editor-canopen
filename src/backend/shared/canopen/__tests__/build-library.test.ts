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
        'CANOPEN_NETWORK_STATE',
        'CANOPEN_NODE_ENABLE',
        'CANOPEN_NODE_STATUS',
        'CANOPEN_SLAVE_EMCY',
        'CANOPEN_SLAVE_NMT',
        'CANOPEN_SLAVE_STATUS',
        'CANOPEN_SLAVE_WRITTEN',
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
    expect(grafted).toHaveLength(19)
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
    const enable = grafted.find((p) => p.name === 'CANOPEN_NODE_ENABLE')?.interface?.variables ?? []
    expect(pins(enable, 'input')).toEqual(['NETWORK:USINT', 'ENABLE:BOOL', 'DEVICE:USINT', 'ACTIVE:BOOL'])
    expect(pins(enable, 'output')).toEqual(['CONFIRM:BOOL', 'BUSY:BOOL', 'ERROR:USINT', 'ERRORTEXT:STRING'])
    const status = grafted.find((p) => p.name === 'CANOPEN_NODE_STATUS')?.interface?.variables ?? []
    expect(pins(status, 'output')).toEqual([
      'CONFIRM:BOOL',
      'ERROR:USINT',
      'ERRORTEXT:STRING',
      'RUNSTATE:USINT',
      'ENABLED:BOOL',
      'OPTIONAL:BOOL',
      'PROGRAMSTART:BOOL',
    ])
    const network = grafted.find((p) => p.name === 'CANOPEN_NETWORK_STATE')?.interface?.variables ?? []
    expect(pins(network, 'output')).toEqual([
      'CONFIRM:BOOL',
      'ERROR:USINT',
      'ERRORTEXT:STRING',
      'MANDATORY_UP:BOOL',
      'OPTIONAL_UP:BOOL',
      'CONFIGURED:USINT',
      'OPERATIONAL:USINT',
      'WAITING:USINT',
      'DISABLED:USINT',
      'FAULTY:USINT',
    ])
    const slavePins = (name: string, cls: string): string[] =>
      pins(grafted.find((p) => p.name === name)?.interface?.variables ?? [], cls)
    expect(slavePins('CANOPEN_SLAVE_STATUS', 'input')).toEqual(['SLAVE:USINT', 'ENABLE:BOOL'])
    expect(slavePins('CANOPEN_SLAVE_STATUS', 'output')).toEqual([
      'CONFIRM:BOOL',
      'ERROR:USINT',
      'ERRORTEXT:STRING',
      'STATE:USINT',
      'OPERATIONAL:BOOL',
      'NODEID:USINT',
      'MASTERWATCHED:BOOL',
      'MASTERSEEN:BOOL',
      'BUSSTATE:USINT',
      'ERRORREGISTER:BYTE',
      'EMCYACTIVE:USINT',
    ])
    expect(slavePins('CANOPEN_SLAVE_NMT', 'input')).toEqual(['SLAVE:USINT', 'ENABLE:BOOL', 'STATE:USINT'])
    expect(slavePins('CANOPEN_SLAVE_NMT', 'output')).toEqual([
      'CONFIRM:BOOL',
      'BUSY:BOOL',
      'ERROR:USINT',
      'ERRORTEXT:STRING',
    ])
    expect(slavePins('CANOPEN_SLAVE_EMCY', 'input')).toEqual([
      'SLAVE:USINT',
      'ENABLE:BOOL',
      'ERRORCODE:WORD',
      'INFO:UDINT',
    ])
    expect(slavePins('CANOPEN_SLAVE_EMCY', 'output')).toEqual([
      'CONFIRM:BOOL',
      'ERROR:USINT',
      'ERRORTEXT:STRING',
      'ACTIVE:BOOL',
    ])
    expect(slavePins('CANOPEN_SLAVE_WRITTEN', 'input')).toEqual([
      'SLAVE:USINT',
      'ENABLE:BOOL',
      'INDEX:WORD',
      'SUBINDEX:BYTE',
    ])
    expect(slavePins('CANOPEN_SLAVE_WRITTEN', 'output')).toEqual([
      'CONFIRM:BOOL',
      'ERROR:USINT',
      'ERRORTEXT:STRING',
      'COUNT:UDINT',
      'NEW:BOOL',
    ])
    const slaveBody = grafted.find((p) => p.name === 'CANOPEN_SLAVE_EMCY')?.body.value
    expect(typeof slaveBody === 'string' ? slaveBody : '').toContain('canopen_fb::api3(')
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
IF e = RUN_WAITING_START OR e = RUN_DISABLED THEN e := RUN_OPERATIONAL; END_IF;
IF e = BUS_OFF OR e = BUS_ERROR_PASSIVE OR e = BUS_UNKNOWN THEN e := BUS_ERROR_ACTIVE; END_IF;
END_PROGRAM
CONFIGURATION c RESOURCE r ON PLC TASK t(INTERVAL := T#20ms, PRIORITY := 1); PROGRAM i WITH t : main; END_RESOURCE END_CONFIGURATION
`
    const result = loadStrucpp().compile(program, { libraries: [archive] } as never)
    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
    expect(result.cppCode).toContain('__builtin_memcpy')
  })
})
