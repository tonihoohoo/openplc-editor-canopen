/**
 * The callable interface of a function block or function, looked up by name in the project's POUs
 * and the system libraries, in the shape the ST call builder, parser and providers share.
 */

import type { SystemLibrary } from '../../../middleware/shared/ports/library-types'
import type { PLCPou, PLCVariable } from '../../../middleware/shared/ports/types'

export type CallParamDirection = 'input' | 'inOut' | 'output'

export interface CallParam {
  name: string
  direction: CallParamDirection
  /** IEC type name as declared (`TIME`, `ANY_NUM`, a user type). */
  type: string
  documentation: string
}

export interface Callable {
  name: string
  kind: 'function' | 'function-block'
  /** Declaration order: inputs, in-outs, outputs. */
  params: CallParam[]
  documentation: string
  /** Variadic function (ADD, MUX): more inputs may follow the declared ones. */
  extensible: boolean
  /** Return type of a function; absent for a function block. */
  returnType?: string
}

export interface CallableSources {
  pous: readonly PLCPou[]
  /** The libraries visible to the project (bundled plus enabled). */
  libraries: readonly SystemLibrary[]
}

const DIRECTION_ORDER: Record<CallParamDirection, number> = { input: 0, inOut: 1, output: 2 }

const byDirection = (params: CallParam[]): CallParam[] =>
  params
    .map((param, index) => ({ param, index }))
    .sort((a, b) => DIRECTION_ORDER[a.param.direction] - DIRECTION_ORDER[b.param.direction] || a.index - b.index)
    .map(({ param }) => param)

const isCallParamDirection = (value: string | undefined): value is CallParamDirection =>
  value === 'input' || value === 'inOut' || value === 'output'

/** A function block's interface from a library or project variable list (the library drop's shape). */
export const functionBlockFromVariables = (
  name: string,
  variables: ReadonlyArray<{ name: string; class?: string; type: { value: string }; documentation?: string }>,
): Callable => ({
  name,
  kind: 'function-block',
  params: byDirection(
    variables.flatMap((variable) =>
      isCallParamDirection(variable.class)
        ? [
            {
              name: variable.name,
              direction: variable.class,
              type: variable.type.value,
              documentation: variable.documentation ?? '',
            },
          ]
        : [],
    ),
  ),
  documentation: '',
  extensible: false,
})

const fromProjectPou = (pou: PLCPou): Callable | null => {
  if (pou.pouType !== 'function' && pou.pouType !== 'function-block') return null
  const params = (pou.interface?.variables ?? [])
    .filter((variable): variable is PLCVariable & { class: CallParamDirection } => isCallParamDirection(variable.class))
    .map((variable) => ({
      name: variable.name,
      direction: variable.class,
      type: variable.type.value,
      documentation: variable.documentation ?? '',
    }))
  return {
    name: pou.name,
    kind: pou.pouType,
    params: byDirection(params),
    documentation: pou.documentation ?? '',
    extensible: false,
    ...(pou.pouType === 'function' && pou.interface?.returnType ? { returnType: pou.interface.returnType } : {}),
  }
}

const fromLibraryPou = (pou: SystemLibrary['pous'][number]): Callable => {
  const isFunction = pou.type === 'function'
  const declared = isFunction ? pou.variables.slice(0, -1) : pou.variables
  const returnVariable = isFunction ? pou.variables[pou.variables.length - 1] : undefined
  const params = declared
    .filter((variable): variable is typeof variable & { class: CallParamDirection } =>
      isCallParamDirection(variable.class),
    )
    .map((variable) => ({
      name: variable.name,
      direction: variable.class,
      type: variable.type.value,
      documentation: variable.documentation ?? '',
    }))
  return {
    name: pou.name,
    kind: pou.type,
    params: byDirection(params),
    documentation: pou.documentation ?? '',
    extensible: isFunction && pou.extensible === true,
    ...(returnVariable ? { returnType: returnVariable.type.value } : {}),
  }
}

/**
 * The function or function block named `name` (any case), or `null`. A project POU shadows a
 * library entry of the same name. A library function's last variable is its synthetic return pin
 * and is not a parameter.
 */
export const findCallable = (name: string, sources: CallableSources): Callable | null => {
  const wanted = name.toUpperCase()
  const pou = sources.pous.find((entry) => entry.name.toUpperCase() === wanted)
  if (pou) return fromProjectPou(pou)
  for (const library of sources.libraries) {
    const entry = library.pous.find((candidate) => candidate.name.toUpperCase() === wanted)
    if (entry) return fromLibraryPou(entry)
  }
  return null
}

/** Every function in the project and the libraries, project first, one per name. */
export const listFunctions = (sources: CallableSources): Callable[] => {
  const seen = new Set<string>()
  const result: Callable[] = []
  const add = (callable: Callable | null) => {
    if (!callable || callable.kind !== 'function' || seen.has(callable.name.toUpperCase())) return
    seen.add(callable.name.toUpperCase())
    result.push(callable)
  }
  for (const pou of sources.pous) add(fromProjectPou(pou))
  for (const library of sources.libraries) for (const entry of library.pous) add(fromLibraryPou(entry))
  return result
}

/** A variable in scope whose type is a known function block, with that block's interface. */
export interface InstanceInScope {
  variable: PLCVariable
  callable: Callable
  /** `local` for the POU's own variables, `global` for the resource's globals. */
  scope: 'local' | 'global'
}

const isPlainTypeReference = (variable: PLCVariable): boolean =>
  variable.type.definition === 'derived' || variable.type.definition === 'user-data-type'

/** The function block instances a POU can call: its own variables first, then the globals. */
export const listInstances = (
  pouVariables: readonly PLCVariable[],
  globalVariables: readonly PLCVariable[],
  sources: CallableSources,
): InstanceInScope[] => {
  const seen = new Set<string>()
  const result: InstanceInScope[] = []
  const add = (variable: PLCVariable, scope: InstanceInScope['scope']) => {
    const key = variable.name.toUpperCase()
    if (seen.has(key)) return
    seen.add(key)
    if (!isPlainTypeReference(variable)) return
    const callable = findCallable(variable.type.value, sources)
    if (callable?.kind === 'function-block') result.push({ variable, callable, scope })
  }
  for (const variable of pouVariables) add(variable, 'local')
  for (const variable of globalVariables) add(variable, 'global')
  return result
}

/** The variable in scope named `name` (any case), the POU's own first. */
export const findVariable = (
  name: string,
  pouVariables: readonly PLCVariable[],
  globalVariables: readonly PLCVariable[],
): { variable: PLCVariable; scope: 'local' | 'global' } | null => {
  const wanted = name.toUpperCase()
  const local = pouVariables.find((variable) => variable.name.toUpperCase() === wanted)
  if (local) return { variable: local, scope: 'local' }
  const global = globalVariables.find((variable) => variable.name.toUpperCase() === wanted)
  return global ? { variable: global, scope: 'global' } : null
}

/** The function block a variable is an instance of, or `null`. */
export const instanceCallable = (variable: PLCVariable, sources: CallableSources): Callable | null => {
  if (!isPlainTypeReference(variable)) return null
  const callable = findCallable(variable.type.value, sources)
  return callable?.kind === 'function-block' ? callable : null
}

/**
 * The name of the input that follows the last one of an extensible function: `IN2` gives `IN3`,
 * `IN1` of `MUX` gives `IN2`. `index` counts extra inputs past the declared ones, from 0.
 */
export const extensibleInputName = (callable: Callable, index: number): string | null => {
  const inputs = callable.params.filter((param) => param.direction === 'input')
  const last = inputs[inputs.length - 1]
  if (!callable.extensible || !last) return null
  const match = /^(.*?)(\d+)$/.exec(last.name)
  if (!match) return null
  return `${match[1]}${Number(match[2]) + 1 + index}`
}
