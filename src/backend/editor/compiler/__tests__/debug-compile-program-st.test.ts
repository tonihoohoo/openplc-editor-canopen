/**
 * `compileForDebugger` writes the same program.st the program build compiles, so the MD5 in its
 * debug map matches the program on the target.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { PLCProjectData } from '../../../shared/types/PLC/open-plc'
import { canopenProgramSt } from '../../../../middleware/shared/utils/canopen'
import {
  canopenDevice,
  configWith,
  genericNode,
} from '../../../../middleware/shared/utils/canopen/__tests__/fixtures/helpers'
import type { CompileProgressChannel } from '../types'
;(process as unknown as { resourcesPath: string }).resourcesPath = '/tmp/never-used'

jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/never-used',
    isPackaged: false,
    getAppPath: () => '/tmp/never-used',
    getVersion: () => '0.0.0-test',
  },
}))
jest.mock('electron/main', () => ({}), { virtual: true })
jest.mock(
  'strucpp',
  () => ({
    compileStlib: jest.fn(),
    loadStlibFromString: jest.fn((text: string) => JSON.parse(text)),
  }),
  { virtual: true },
)

const TRANSPILED = 'PROGRAM main\nEND_PROGRAM\n'
jest.mock('@root/backend/shared/transpilers/st-transpiler', () => ({
  fromSchemaShape: (data: unknown) => data,
  transpileToSt: () => ({ programSt: 'PROGRAM main\nEND_PROGRAM\n', errors: [] }),
}))
jest.mock('@root/backend/shared/firmware/hals-loader', () => ({ readHalsFile: () => Promise.resolve({}) }))
jest.mock('../../../shared/hardware/board-info-resolver', () => ({
  BoardInfoResolver: class {
    resolve() {
      return { boardRuntime: 'openplc-compiler' }
    }
  },
}))
jest.mock('../../package-manager', () => ({
  formatPackageIntegrityError: () => 'integrity',
  PackageManagerModule: class {
    verifyBoardPackageIntegrity() {
      return { ok: true }
    }
  },
}))

import { CompilerModule } from '../compiler-module'

function project(remoteDevices: PLCProjectData['remoteDevices']): PLCProjectData {
  return {
    pous: [
      {
        type: 'program',
        data: { name: 'main', language: 'st', variables: [], documentation: '', body: { language: 'st', value: '' } },
      },
    ],
    dataTypes: [],
    libraries: [{ name: 'canopen', version: '1.0.0' }],
    servers: [],
    remoteDevices,
    configuration: { resource: { tasks: [], instances: [], globalVariables: [] } },
  }
}

function channel(): { port: CompileProgressChannel; messages: unknown[] } {
  const messages: unknown[] = []
  return {
    messages,
    port: { start: () => undefined, postMessage: (m: unknown) => messages.push(m), close: () => undefined },
  }
}

describe('compileForDebugger program.st', () => {
  let dir: string
  let compiler: CompilerModule

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'debug-st-')))
    compiler = new CompilerModule()
    jest.spyOn(compiler, 'checkStrucppAvailability').mockReturnValue({ success: true, data: 'test' })
    jest.spyOn(compiler, 'copyStaticFiles').mockResolvedValue(undefined as never)
    // Stops the run once program.st is on disk; the test reads the file.
    jest.spyOn(compiler, 'handleCompileSTtoCpp').mockRejectedValue(new Error('stop'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const bridge = { loadEnabledArchives: () => ({ archives: [], missing: [] }) }
  const programSt = () => readFileSync(join(dir, 'build', 'board', 'src', 'program.st'), 'utf8')

  it('appends the CANopen constants exactly as the program build does', async () => {
    const data = project([canopenDevice('line_1', configWith(genericNode(2))) as never])
    await compiler.compileForDebugger([join(dir, 'project.json'), 'board', data], channel().port, bridge)

    const expected = canopenProgramSt(TRANSPILED, data)
    expect(expected.ok).toBe(true)
    expect(programSt()).toBe(expected.ok ? expected.programSt : '')
    expect(programSt()).toContain('io2 : USINT := 2;')
  })

  it('stops with the name problem the program build reports', async () => {
    const node = { ...genericNode(2), name: 'main' }
    const data = project([canopenDevice('line_1', configWith(node)) as never])
    const { port, messages } = channel()
    await compiler.compileForDebugger([join(dir, 'project.json'), 'board', data], port, bridge)

    const errors = messages.filter((m) => (m as { logLevel?: string }).logLevel === 'error')
    expect(JSON.stringify(errors)).toContain('Compilation aborted:')
    expect(compiler.handleCompileSTtoCpp).not.toHaveBeenCalled()
  })
})
