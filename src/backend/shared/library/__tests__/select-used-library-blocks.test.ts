import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

import { createTestStore } from '../../../../frontend/store/testing'
import type { StlibArchiveDTO } from '../../../../middleware/shared/ports/library-port'
import type { PLCProjectData } from '../../../../middleware/shared/ports/types'
import { parseProjectFiles } from '../../utils/parse-project-files'
import { injectLibraryBlocks } from '../inject-library-blocks'
import { findUsedLibraryBlocks, selectUsedLibraryArchives } from '../select-used-library-blocks'

const cppBlock = (name: string, extraVars = '') => `FUNCTION_BLOCK ${name}
VAR_INPUT
  IN : INT;
END_VAR
VAR
${extraVars}END_VAR
void setup() {}
void loop() {}
END_FUNCTION_BLOCK
`

function archive(name: string, blocks: Array<{ name: string; source?: string }>, stBlocks: string[] = []) {
  return {
    manifest: {
      name,
      version: '1.0.0',
      functionBlocks: [
        ...stBlocks.map((n) => ({ name: n, inputs: [], outputs: [], inouts: [] })),
        ...blocks.map((b) => ({
          name: b.name,
          inputs: [],
          outputs: [],
          inouts: [],
          implementation: 'cpp',
          sourceFile: `${b.name}.cpp`,
        })),
      ],
    },
    sources: blocks.map((b) => ({ fileName: `${b.name}.cpp`, source: b.source ?? cppBlock(b.name) })),
  } as unknown as StlibArchiveDTO
}

function project(parts: Partial<PLCProjectData> & { body?: unknown; variables?: unknown[] } = {}): PLCProjectData {
  return {
    dataTypes: parts.dataTypes ?? [],
    globalVariableLists: parts.globalVariableLists ?? [],
    configurations: parts.configurations ?? { resource: { tasks: [], instances: [], globalVariables: [] } },
    pous: parts.pous ?? [
      {
        name: 'main',
        pouType: 'program',
        interface: { variables: parts.variables ?? [] },
        body: parts.body ?? { language: 'st', value: 'x := 1;' },
      },
    ],
    libraries: parts.libraries ?? [{ name: 'lib', version: '1.0.0' }],
  } as unknown as PLCProjectData
}

const lib = archive('lib', [{ name: 'SDO_READ4' }, { name: 'NMT' }, { name: 'GPIO_OUT' }], ['ST_HELPER'])
const variable = (name: string, type: string) => ({ name, type: { definition: 'derived', value: type } })

describe('findUsedLibraryBlocks', () => {
  it('finds no block when the project names none', () => {
    expect([...findUsedLibraryBlocks(project(), [lib])]).toEqual([])
  })

  it('finds a block named in a POU variable table', () => {
    expect([...findUsedLibraryBlocks(project({ variables: [variable('r', 'SDO_READ4')] }), [lib])]).toEqual([
      'SDO_READ4',
    ])
  })

  it('finds a block named in an ST body in any letter case', () => {
    const body = { language: 'st', value: 'VAR n : nmt; END_VAR' }
    expect([...findUsedLibraryBlocks(project({ body }), [lib])]).toEqual(['NMT'])
  })

  it('finds a block held by a graphical body', () => {
    const body = {
      language: 'ld',
      value: { rungs: [{ nodes: [{ type: 'block', data: { variant: { name: 'GPIO_OUT' } } }] }] },
    }
    expect([...findUsedLibraryBlocks(project({ body }), [lib])]).toEqual(['GPIO_OUT'])
  })

  it('finds a block named by a global variable, a list or a data type', () => {
    const globals = project({
      configurations: { resource: { tasks: [], instances: [], globalVariables: [variable('g', 'NMT')] } },
    } as never)
    expect([...findUsedLibraryBlocks(globals, [lib])]).toEqual(['NMT'])
    const list = project({ globalVariableLists: [{ name: 'GVL', variables: [variable('o', 'GPIO_OUT')] }] } as never)
    expect([...findUsedLibraryBlocks(list, [lib])]).toEqual(['GPIO_OUT'])
    const struct = project({
      dataTypes: [{ name: 'T', derivation: 'structure', variable: [{ name: 'r', type: { value: 'SDO_READ4' } }] }],
    } as never)
    expect([...findUsedLibraryBlocks(struct, [lib])]).toEqual(['SDO_READ4'])
  })

  it('does not count a name inside a longer identifier', () => {
    const body = { language: 'st', value: 'NMT_STATE := MY_NMT; X := GPIO_OUT2;' }
    expect([...findUsedLibraryBlocks(project({ body }), [lib])]).toEqual([])
  })

  it('finds a block declared only inside another used library block', () => {
    const chained = archive('lib', [
      { name: 'OUTER', source: cppBlock('OUTER', '  inner : INNER;\n') },
      { name: 'INNER' },
    ])
    const used = findUsedLibraryBlocks(project({ variables: [variable('o', 'OUTER')] }), [chained])
    expect([...used].sort()).toEqual(['INNER', 'OUTER'])
  })

  it('finds a block a native POU of the project declares', () => {
    const pous = [
      {
        name: 'main',
        pouType: 'function-block',
        interface: { variables: [] },
        body: { language: 'cpp', value: 'r : SDO_READ4;' },
      },
    ]
    expect([...findUsedLibraryBlocks(project({ pous } as never), [lib])]).toEqual(['SDO_READ4'])
  })
})

describe('selectUsedLibraryArchives', () => {
  it('removes unused native blocks and keeps ST blocks', () => {
    const [selected] = selectUsedLibraryArchives(project({ variables: [variable('n', 'NMT')] }), [lib])
    expect(selected.manifest.functionBlocks.map((b) => b.name)).toEqual(['ST_HELPER', 'NMT'])
    expect(lib.manifest.functionBlocks).toHaveLength(4)
  })

  it('returns an archive with nothing to remove as it is', () => {
    const data = project({ body: { language: 'st', value: 'SDO_READ4 NMT GPIO_OUT' } })
    expect(selectUsedLibraryArchives(data, [lib])[0]).toBe(lib)
  })

  it('does not look inside libraries the project has not enabled', () => {
    const other = archive('other', [{ name: 'OUTER', source: cppBlock('OUTER', '  n : NMT;\n') }])
    const data = project({ variables: [variable('o', 'OUTER')] })
    const [selectedLib] = selectUsedLibraryArchives(data, [lib, other])
    expect(selectedLib.manifest.functionBlocks.map((b) => b.name)).toEqual(['ST_HELPER'])
  })

  it('grafts nothing for an unused library and only the used block otherwise', () => {
    const none = project()
    expect(injectLibraryBlocks(none, selectUsedLibraryArchives(none, [lib]))).toBe(none)
    const some = project({ variables: [variable('o', 'GPIO_OUT')] })
    const grafted = injectLibraryBlocks(some, selectUsedLibraryArchives(some, [lib]))
    expect(grafted.pous.map((p) => p.name)).toEqual(['main', 'GPIO_OUT'])
  })

  it("leaves a project POU with a block's name in place of the library block", () => {
    const pous = [
      {
        name: 'main',
        pouType: 'program',
        interface: { variables: [variable('n', 'NMT')] },
        body: { language: 'st', value: '' },
      },
      { name: 'NMT', pouType: 'function-block', interface: { variables: [] }, body: { language: 'st', value: '' } },
    ]
    const data = project({ pous } as never)
    const grafted = injectLibraryBlocks(data, selectUsedLibraryArchives(data, [lib]))
    expect(grafted.pous.map((p) => p.name)).toEqual(['main', 'NMT'])
    expect(grafted.pous[1].body.language).toBe('st')
  })
})

describe('the bundled block libraries on the end-to-end projects', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..', '..')
  const bundled = ['canopen', 'linux_io'].map(
    (n) => JSON.parse(readFileSync(join(ROOT, 'resources', 'libraries', `${n}.stlib`), 'utf8')) as StlibArchiveDTO,
  )

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))

  function load(fixture: string): PLCProjectData {
    const dir = join(ROOT, 'e2e', 'fixtures', fixture, 'project')
    const files = walk(dir).map((p) => ({ relativePath: relative(dir, p), content: readFileSync(p, 'utf8') }))
    const get = (rel: string) => files.find((f) => f.relativePath === rel)?.content ?? ''
    const parsed = parseProjectFiles(
      dir,
      get('project.json'),
      get('devices/configuration.json'),
      get('devices/pin-mapping.json'),
      files.filter((f) => f.relativePath.startsWith('pous/')),
      files.filter((f) => f.relativePath.startsWith('devices/servers/')),
      files.filter((f) => f.relativePath.startsWith('devices/remote/')),
    )
    const store = createTestStore()
    store.getState().sharedWorkspaceActions.handleOpenProjectResponse(parsed)
    return {
      ...store.getState().projectActions.getCompileReadyProjectData(),
      libraries: [
        { name: 'canopen', version: '1.0.0' },
        { name: 'linux_io', version: '1.0.0' },
      ],
    }
  }

  const graftedNames = (data: PLCProjectData) =>
    injectLibraryBlocks(data, selectUsedLibraryArchives(data, bundled))
      .pous.map((p) => p.name)
      .filter((name) => name !== 'main')
      .sort()

  it('grafts no block into a project that only maps PDOs', () => {
    expect(graftedNames(load('canopen-generic-io'))).toEqual([])
  })

  it('grafts exactly the blocks the PLC blocks project declares', () => {
    expect(graftedNames(load('canopen-plc-blocks'))).toEqual([
      'GET_CANOPEN_KERNEL_STATE',
      'GET_LOCAL_NODE_ID',
      'GET_STATE',
      'NMT',
      'RECV_EMCY_DEV',
      'SDO_READ4',
      'SDO_READ_DATA',
      'SDO_READ_STRING',
      'SDO_WRITE4',
      'SDO_WRITE_DATA',
    ])
  })
})
