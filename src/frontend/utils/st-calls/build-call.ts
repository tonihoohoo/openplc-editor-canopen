/**
 * Monaco snippet text for a function block or function call: the full call, a group of parameters
 * (inputs or outputs), or the parameters still missing from a call.
 */

import type { Callable, CallParam } from './callable'

export type CallPart = 'all' | 'inputs' | 'outputs'

const DEFAULT_VALUES: Record<string, string> = {
  BOOL: 'TRUE',
  TIME: 'T#100ms',
  INT: '0',
  DINT: '0',
  REAL: '0.0',
  STRING: "''",
}

/** The prefilled value of an input of `type`, or `''` for a type without one. */
export const defaultValueFor = (type: string): string => DEFAULT_VALUES[type.trim().toUpperCase()] ?? ''

/** Escape text for use inside a snippet placeholder. */
export const escapeSnippet = (text: string): string => text.replace(/[\\$}]/g, (char) => `\\${char}`)

/** The parameters of `part`, without those named in `exclude` (upper-case names). */
export const selectParams = (
  callable: Callable,
  part: CallPart = 'all',
  exclude: ReadonlySet<string> = new Set(),
): CallParam[] =>
  callable.params.filter((param) => {
    if (exclude.has(param.name.toUpperCase())) return false
    if (part === 'inputs') return param.direction !== 'output'
    if (part === 'outputs') return param.direction === 'output'
    return true
  })

/** `IN := ${1:TRUE}` or `Q => ${3}`; outputs and in-outs start empty. */
export const paramSnippet = (param: CallParam, tabStop: number): string => {
  const operator = param.direction === 'output' ? '=>' : ':='
  const value = param.direction === 'input' ? defaultValueFor(param.type) : ''
  const placeholder = value ? `\${${tabStop}:${escapeSnippet(value)}}` : `\${${tabStop}}`
  return `${param.name} ${operator} ${placeholder}`
}

/** Named parameters joined by `separator`, tab stops numbered from `firstTabStop`. */
export const paramsSnippet = (params: readonly CallParam[], separator: string, firstTabStop = 1): string =>
  params.map((param, index) => paramSnippet(param, firstTabStop + index)).join(separator)

/** `n` empty unnamed values, `${1}, ${2}`. */
export const unnamedSnippet = (count: number, firstTabStop = 1): string =>
  Array.from({ length: count }, (_, index) => `\${${firstTabStop + index}}`).join(', ')

export interface BuildCallOptions {
  /** Instance name for a function block, the function's name otherwise. */
  target: string
  part?: CallPart
}

/**
 * The full call. A function block call is a statement with one parameter per line and `);`; a
 * function call is an expression on one line. An extensible function uses the unnamed form with its
 * declared inputs as empty values. Tab moves through the values and ends after the call.
 */
export const buildCallSnippet = (callable: Callable, options: BuildCallOptions): string => {
  const params = selectParams(callable, options.part ?? 'all')
  if (callable.kind === 'function-block') {
    if (params.length === 0) return `${options.target}();$0`
    return `${options.target}(\n\t${paramsSnippet(params, ',\n\t')}\n);$0`
  }
  if (callable.extensible && (options.part ?? 'all') !== 'outputs') {
    const inputs = callable.params.filter((param) => param.direction === 'input').length
    return `${options.target}(${unnamedSnippet(inputs)})$0`
  }
  return `${options.target}(${paramsSnippet(params, ', ')})$0`
}
