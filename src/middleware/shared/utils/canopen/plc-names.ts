/**
 * Names a PLC program can use for the CANopen function blocks: one `USINT` constant per node of
 * every network that is on (its node ID) and per such network (its number from 1, in the order of
 * conf/canopen.json), and the table of EDS object sizes `SDO_WRITE4` reads when its DATALENGTH is
 * 0. Shared by the build, which adds them to the program, and the language server.
 */

import type { PLCRemoteDevice } from '../../ports/types'
import { canopenTypeBits, toCanopenDataType } from './data-types'

/** The name of the function block library the editor ships for CANopen. */
export const CANOPEN_LIBRARY_NAME = 'canopen'

export interface CanopenPlcName {
  name: string
  value: number
  kind: 'network' | 'node'
  /** The network's device name (a network's own name for a network). */
  network: string
}

function networksOn(remoteDevices: readonly PLCRemoteDevice[] | undefined): PLCRemoteDevice[] {
  return (remoteDevices ?? []).filter((d) => d.protocol === 'canopen' && d.canopenConfig?.network.enabled)
}

/** The constants, networks first, each network's nodes in their order. */
export function canopenPlcNames(remoteDevices: readonly PLCRemoteDevice[] | undefined): CanopenPlcName[] {
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
): string {
  const lines = canopenPlcNames(remoteDevices).map((n) => `  ${n.name} : USINT := ${n.value};`)
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
  project: { remoteDevices?: readonly PLCRemoteDevice[]; libraries?: ReadonlyArray<{ name: string }> },
): string {
  const block = serializeCanopenConstantsToST(project.remoteDevices, usesCanopenLibrary(project.libraries))
  return block ? `${programSt.endsWith('\n') ? programSt : `${programSt}\n`}\n${block}` : programSt
}

/** Names the canopen library declares, which a node or network name may not take. */
export const CANOPEN_LIBRARY_SYMBOLS: readonly string[] = [
  'CANOPEN_KERNEL_ERROR',
  'DEVICE_STATE',
  'TRANSITION_STATE',
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
  return n.kind === 'network' ? `CANopen network "${n.name}"` : `CANopen "${n.network}" node "${n.name}"`
}

/**
 * Why the node and network names cannot all be program constants: not an identifier, the same
 * name twice (letter case ignored, across networks), or a name the project or the canopen library
 * already uses. Only networks that are on are checked, as only they get constants.
 */
export function canopenNameProblems(
  remoteDevices: readonly PLCRemoteDevice[] | undefined,
  projectNames: readonly ProjectName[],
): string[] {
  const problems: string[] = []
  const seen = new Map<string, CanopenPlcName>()
  const taken = new Map<string, string>()
  for (const n of projectNames) taken.set(n.name.toUpperCase(), `the ${n.kind} "${n.name}"`)
  for (const s of CANOPEN_LIBRARY_SYMBOLS) taken.set(s, `"${s}" of the canopen library`)
  for (const n of canopenPlcNames(remoteDevices)) {
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
    if (clash) problems.push(`${what}: the name is also ${clash}; a program reaches the node or network by name`)
  }
  return problems
}
