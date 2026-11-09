/**
 * Names a PLC program can use for the CANopen function blocks: one `USINT` constant per node of
 * every network that is on (its node ID), per such network (its number from 1, in the order of
 * conf/canopen.json) and per slave that is on (its place in `devices`, from 1), and the table of EDS object sizes `SDO_WRITE4` reads when its DATALENGTH is
 * 0. Shared by the build, which adds them to the program, and the language server.
 */

import type { PLCRemoteDevice, PLCServer } from '../../ports/types'
import { canopenTypeBits, toCanopenDataType } from './data-types'
import { slavesOn } from './slave'

/** The name of the function block library the editor ships for CANopen. */
export const CANOPEN_LIBRARY_NAME = 'canopen'

export interface CanopenPlcName {
  name: string
  value: number
  kind: 'network' | 'node' | 'slave'
  /** The network's device name (a network's own name for a network, a slave's own name for a slave). */
  network: string
}

function networksOn(remoteDevices: readonly PLCRemoteDevice[] | undefined): PLCRemoteDevice[] {
  return (remoteDevices ?? []).filter((d) => d.protocol === 'canopen' && d.canopenConfig?.network.enabled)
}

/** The constants, networks first, each network's nodes in their order, then the slaves. */
export function canopenPlcNames(
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
  servers?: readonly PLCServer[],
): CanopenPlcName[] {
  const networks = networksOn(remoteDevices)
  const names: CanopenPlcName[] = networks.map((d, i) => ({
    name: d.name,
    value: i + 1,
    kind: 'network',
    network: d.name,
  }))
  for (const d of networks) {
    for (const node of d.canopenConfig?.nodes ?? []) {
      names.push({ name: node.name, value: node.nodeId, kind: 'node', network: d.name })
    }
  }
  slavesOn(servers).forEach((s, i) => names.push({ name: s.name, value: i + 1, kind: 'slave', network: s.name }))
  return names
}

/**
 * Every object of 1 to 4 bytes in the EDS of every node of the networks that are on, packed as
 * network << 40 | node << 32 | index << 16 | sub-index << 8 | size, ascending.
 */
export function canopenObjectSizes(remoteDevices: readonly PLCRemoteDevice[] | undefined): number[] {
  const entries = new Map<number, number>()
  networksOn(remoteDevices).forEach((d, i) => {
    const network = i + 1
    for (const node of d.canopenConfig?.nodes ?? []) {
      for (const object of node.eds.objects) {
        const type = toCanopenDataType(object.dataType)
        if (!type) continue
        const bytes = Math.ceil(canopenTypeBits(type) / 8)
        if (bytes > 4) continue
        const key = (network * 2 ** 8 + node.nodeId) * 2 ** 32 + object.index * 2 ** 16 + object.subIndex * 2 ** 8
        entries.set(key, key + bytes)
      }
    }
  })
  return [...entries.keys()].sort((a, b) => a - b).map((key) => entries.get(key) ?? key)
}

function hexLiteral(value: number): string {
  return `16#${value.toString(16).toUpperCase().padStart(12, '0')}`
}

/**
 * The constants as a top-level `VAR_GLOBAL CONSTANT` block, which STruC++ puts in the global scope
 * without a `VAR_EXTERNAL`. With `objectSizes` (the library is in the project), also the size
 * table. '' when there is nothing to declare.
 */
export function serializeCanopenConstantsToST(
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
  objectSizes: boolean,
  servers?: readonly PLCServer[],
): string {
  const lines = canopenPlcNames(remoteDevices, servers).map((n) => `  ${n.name} : USINT := ${n.value};`)
  if (objectSizes) {
    const sizes = canopenObjectSizes(remoteDevices)
    const table = sizes.length > 0 ? sizes : [0]
    lines.push(`  CANOPEN_OBJECT_SIZE_COUNT : UINT := ${sizes.length};`)
    const values = table.map(hexLiteral)
    const rows: string[] = []
    for (let i = 0; i < values.length; i += 6) rows.push(`    ${values.slice(i, i + 6).join(', ')}`)
    lines.push(`  CANOPEN_OBJECT_SIZES : ARRAY[0..${table.length - 1}] OF ULINT := [\n${rows.join(',\n')}];`)
  }
  if (lines.length === 0) return ''
  return ['VAR_GLOBAL CONSTANT', ...lines, 'END_VAR', ''].join('\n')
}

/** Whether the project lists the CANopen block library. */
export function usesCanopenLibrary(libraries: ReadonlyArray<{ name: string }> | undefined): boolean {
  return (libraries ?? []).some((l) => l.name === CANOPEN_LIBRARY_NAME)
}

/** `programSt` with the CANopen constants after it, or unchanged when there are none. */
export function withCanopenConstants(
  programSt: string,
  project: {
    remoteDevices?: readonly PLCRemoteDevice[]
    servers?: readonly PLCServer[]
    libraries?: ReadonlyArray<{ name: string }>
  },
): string {
  const block = serializeCanopenConstantsToST(
    project.remoteDevices,
    usesCanopenLibrary(project.libraries),
    project.servers,
  )
  return block ? `${programSt.endsWith('\n') ? programSt : `${programSt}\n`}\n${block}` : programSt
}

/** Words of Structured Text (keywords and elementary types) that no node or network name may take. */
export const ST_RESERVED_WORDS: readonly string[] = [
  'ACTION',
  'AND',
  'ANY',
  'ARRAY',
  'AT',
  'BOOL',
  'BY',
  'BYTE',
  'CASE',
  'CONFIGURATION',
  'CONSTANT',
  'CONTINUE',
  'DATE',
  'DATE_AND_TIME',
  'DINT',
  'DO',
  'DT',
  'DWORD',
  'ELSE',
  'ELSIF',
  'END_ACTION',
  'END_CASE',
  'END_CONFIGURATION',
  'END_FOR',
  'END_FUNCTION',
  'END_FUNCTION_BLOCK',
  'END_IF',
  'END_PROGRAM',
  'END_REPEAT',
  'END_RESOURCE',
  'END_STRUCT',
  'END_TYPE',
  'END_VAR',
  'END_WHILE',
  'EXIT',
  'FALSE',
  'FOR',
  'FUNCTION',
  'FUNCTION_BLOCK',
  'IF',
  'INT',
  'LINT',
  'LREAL',
  'LWORD',
  'MOD',
  'NOT',
  'OF',
  'OR',
  'PROGRAM',
  'READ_ONLY',
  'READ_WRITE',
  'REAL',
  'REPEAT',
  'RESOURCE',
  'RETAIN',
  'RETURN',
  'SINT',
  'STEP',
  'STRING',
  'STRUCT',
  'TASK',
  'THEN',
  'TIME',
  'TIME_OF_DAY',
  'TO',
  'TOD',
  'TRUE',
  'TYPE',
  'UDINT',
  'UINT',
  'ULINT',
  'UNTIL',
  'USINT',
  'VAR',
  'VAR_ACCESS',
  'VAR_EXTERNAL',
  'VAR_GLOBAL',
  'VAR_INPUT',
  'VAR_IN_OUT',
  'VAR_OUTPUT',
  'VAR_TEMP',
  'WHILE',
  'WORD',
  'WSTRING',
  'XOR',
]

/** Names the canopen library declares, which a node or network name may not take. */
export const CANOPEN_LIBRARY_SYMBOLS: readonly string[] = [
  'CANOPEN_KERNEL_ERROR',
  'DEVICE_STATE',
  'TRANSITION_STATE',
  'CANOPEN_RUN_STATE',
  'EMCY_ERROR',
  'CANOPEN_KERNEL_NO_ERROR',
  'CANOPEN_KERNEL_OTHER_ERROR',
  'CANOPEN_KERNEL_TIMEOUT',
  'CANOPEN_KERNEL_BUS_OFF',
  'CANOPEN_KERNEL_ERROR_PASSIVE',
  'CANOPEN_KERNEL_INTERNAL',
  'CANOPEN_KERNEL_WRONG_PARAMETER',
  'CANOPEN_KERNEL_NODE_ID_UNKNOWN',
  'CANOPEN_KERNEL_NET_ID_UNKNOWN',
  'CANOPEN_KERNEL_REQUEST_ERROR',
  'CANOPEN_KERNEL_NO_DRIVER',
  'INIT',
  'RESET_COMM',
  'RESET_APP',
  'PRE_OPERATIONAL',
  'STOPPED',
  'OPERATIONAL',
  'UNKNOWN',
  'NOT_AVAIL',
  'START_REMOTE_NODE',
  'STOP_REMOTE_NODE',
  'ENTER_PRE_OPERATIONAL',
  'RESET_NODE',
  'RESET_COMMUNICATION',
  'RUN_NOT_FOUND',
  'RUN_BOOTING',
  'RUN_FAILED',
  'RUN_WAITING_START',
  'RUN_OPERATIONAL',
  'RUN_MANUAL',
  'RUN_LOST',
  'RUN_HELD',
  'RUN_DISABLED',
  'RUN_STOPPED',
  'CANOPEN_BUS_STATE',
  'BUS_ERROR_ACTIVE',
  'BUS_ERROR_PASSIVE',
  'BUS_OFF',
  'BUS_UNKNOWN',
  'CANOPEN_DWORD_TO_REAL',
  'CANOPEN_REAL_TO_DWORD',
  'SDO_READ4',
  'SDO_WRITE4',
  'SDO_READ_DATA',
  'SDO_WRITE_DATA',
  'SDO_READ_STRING',
  'SDO_WRITE_STRING',
  'NMT',
  'GET_STATE',
  'GET_LOCAL_NODE_ID',
  'GET_CANOPEN_KERNEL_STATE',
  'RECV_EMCY',
  'RECV_EMCY_DEV',
  'CANOPEN_NODE_ENABLE',
  'CANOPEN_NODE_STATUS',
  'CANOPEN_NETWORK_STATE',
  'CANOPEN_SLAVE_STATUS',
  'CANOPEN_SLAVE_NMT',
  'CANOPEN_SLAVE_EMCY',
  'CANOPEN_SLAVE_WRITTEN',
  'CANOPEN_OBJECT_SIZES',
  'CANOPEN_OBJECT_SIZE_COUNT',
]

/** A name the project already uses: a global variable, a POU, a data type or an enumeration value. */
export interface ProjectName {
  name: string
  kind: 'global variable' | 'POU' | 'data type' | 'enumeration value'
}

/** The project names a node or network name may not take, from the project's own lists. */
export function projectNamesForCanopen(
  globals: ReadonlyArray<{ name: string }>,
  pouNames: readonly string[],
  dataTypes: ReadonlyArray<{ name: string; derivation: string; values?: ReadonlyArray<{ description: string }> }>,
): ProjectName[] {
  const names: ProjectName[] = [
    ...globals.map((v) => ({ name: v.name, kind: 'global variable' as const })),
    ...pouNames.map((name) => ({ name, kind: 'POU' as const })),
  ]
  for (const t of dataTypes) {
    names.push({ name: t.name, kind: 'data type' })
    if (t.derivation === 'enumerated')
      for (const v of t.values ?? []) names.push({ name: v.description, kind: 'enumeration value' })
  }
  return names
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function describeName(n: CanopenPlcName): string {
  if (n.kind === 'network') return `CANopen network "${n.name}"`
  if (n.kind === 'slave') return `CANopen slave "${n.name}"`
  return `CANopen "${n.network}" node "${n.name}"`
}

/**
 * Why the node and network names cannot all be program constants: not an identifier, the same
 * name twice (letter case ignored, across networks), or a name the project or the canopen library
 * already uses. Only networks and slaves that are on are checked, as only they get constants.
 */
export function canopenNameProblems(
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
  projectNames: readonly ProjectName[],
  servers?: readonly PLCServer[],
): string[] {
  const problems: string[] = []
  const seen = new Map<string, CanopenPlcName>()
  const taken = new Map<string, string>()
  for (const n of projectNames) taken.set(n.name.toUpperCase(), `the ${n.kind} "${n.name}"`)
  for (const w of ST_RESERVED_WORDS) taken.set(w, `the Structured Text word "${w}"`)
  for (const s of CANOPEN_LIBRARY_SYMBOLS) taken.set(s, `"${s}" of the canopen library`)
  for (const n of canopenPlcNames(remoteDevices, servers)) {
    const what = describeName(n)
    if (!IDENTIFIER.test(n.name)) {
      problems.push(`${what}: the name must be letters, digits and underscores, not starting with a digit`)
      continue
    }
    const key = n.name.toUpperCase()
    const first = seen.get(key)
    if (first) {
      problems.push(`${what}: the name is also used by ${describeName(first)}; a program reaches both by name`)
      continue
    }
    seen.set(key, n)
    const clash = taken.get(key)
    if (clash) problems.push(`${what}: the name is also ${clash}; a program reaches it by name`)
  }
  return problems
}

/**
 * The program source a build compiles: the CANopen name check, then `programSt` with the CANopen
 * constants after it. The program build and the debug build both use it, so both hash the same
 * source and the debugger's MD5 check matches the uploaded program.
 */
export function canopenProgramSt(
  programSt: string,
  project: {
    remoteDevices?: readonly PLCRemoteDevice[]
    servers?: readonly PLCServer[]
    libraries?: ReadonlyArray<{ name: string }>
    pous: ReadonlyArray<{ data: { name: string } }>
    dataTypes?: ReadonlyArray<{ name: string; derivation: string; values?: ReadonlyArray<{ description: string }> }>
    configuration: { resource: { globalVariables: ReadonlyArray<{ name: string }> } }
  },
): { ok: true; programSt: string } | { ok: false; error: string } {
  const problems = canopenNameProblems(
    project.remoteDevices,
    projectNamesForCanopen(
      project.configuration.resource.globalVariables,
      project.pous.map((p) => p.data.name),
      project.dataTypes ?? [],
    ),
    project.servers,
  )
  if (problems.length > 0) return { ok: false, error: `Compilation aborted: ${problems.join('; ')}` }
  return { ok: true, programSt: withCanopenConstants(programSt, project) }
}
