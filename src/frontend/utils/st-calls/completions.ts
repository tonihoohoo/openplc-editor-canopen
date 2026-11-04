/**
 * The call suggestions of the ST editor, computed on plain text so they can be tested without
 * Monaco: the full call after an instance or function name, and inside a call the groups and each
 * missing parameter. Offsets are 0-based; the provider turns them into Monaco ranges.
 */

import type { PLCVariable } from '../../../middleware/shared/ports/types'
import { buildCallSnippet, type CallPart, paramSnippet, paramsSnippet, selectParams } from './build-call'
import {
  type Callable,
  type CallableSources,
  type CallParam,
  extensibleInputName,
  findCallable,
  findVariable,
  instanceCallable,
  listFunctions,
  listInstances,
} from './callable'
import { callDocumentation, paramDocumentation } from './documentation'
import { argIndexAt, type CallSite, codeMask, findCallAt, isEmptyArg } from './parse-call'

export interface CallScope {
  pouVariables: readonly PLCVariable[]
  globalVariables: readonly PLCVariable[]
  sources: CallableSources
}

export type CallSuggestionKind = 'call' | 'group' | 'param'

export interface CallSuggestion {
  kind: CallSuggestionKind
  label: string
  /** Shown after the label: the parameter's type. */
  detail?: string
  /** Shown at the right: `IN`, `OUT` or `IN/OUT`. */
  badge?: string
  /** Markdown for the details panel. */
  documentation?: string
  /** Snippet text. */
  insertText: string
  /** Range replaced, 0-based offsets. */
  start: number
  end: number
  filterText?: string
  sortText: string
  preselect?: boolean
}

export const ALL_PARAMETERS = 'all parameters'
export const ALL_REMAINING = 'all remaining'
export const NEXT_INPUT = 'next input'

const badgeFor = (param: CallParam): string =>
  param.direction === 'output' ? 'OUT' : param.direction === 'inOut' ? 'IN/OUT' : 'IN'

const operatorFor = (param: CallParam): string => (param.direction === 'output' ? '=>' : ':=')

const IDENTIFIER_BEFORE = /[A-Za-z_][A-Za-z0-9_]*$/

/** The identifier being typed right before `offset`, and where it starts. */
const prefixAt = (text: string, offset: number): { prefix: string; start: number } => {
  const match = IDENTIFIER_BEFORE.exec(text.slice(Math.max(0, offset - 128), offset))
  return match ? { prefix: match[0], start: offset - match[0].length } : { prefix: '', start: offset }
}

interface ResolvedCall {
  callable: Callable
  target: string
  documentation: string
}

/** The interface behind a call's name: an instance in scope, or a function. */
export const resolveCall = (name: string, scope: CallScope): ResolvedCall | null => {
  const found = findVariable(name, scope.pouVariables, scope.globalVariables)
  if (found) {
    const callable = instanceCallable(found.variable, scope.sources)
    return callable
      ? { callable, target: found.variable.name, documentation: callDocumentation(callable, found.variable) }
      : null
  }
  const callable = findCallable(name, scope.sources)
  if (callable?.kind !== 'function') return null
  return { callable, target: callable.name, documentation: callDocumentation(callable) }
}

/**
 * `name — all parameters` items for the identifier being typed: instances whose name starts with it,
 * and the function whose full name it is.
 */
const nameSuggestions = (text: string, offset: number, scope: CallScope): CallSuggestion[] => {
  const { prefix, start } = prefixAt(text, offset)
  if (!prefix) return []
  const before = text.slice(0, start).replace(/\s+$/, '')
  if (before.endsWith('.') || before.endsWith('#')) return []
  const wanted = prefix.toUpperCase()
  const end = offset + (/^[A-Za-z0-9_]*/.exec(text.slice(offset))?.[0].length ?? 0)
  const suggestions: CallSuggestion[] = []
  for (const instance of listInstances(scope.pouVariables, scope.globalVariables, scope.sources)) {
    if (!instance.variable.name.toUpperCase().startsWith(wanted)) continue
    suggestions.push({
      kind: 'call',
      label: `${instance.variable.name} — ${ALL_PARAMETERS}`,
      detail: ` ${instance.callable.name}`,
      documentation: callDocumentation(instance.callable, instance.variable),
      insertText: buildCallSnippet(instance.callable, { target: instance.variable.name }),
      start,
      end,
      filterText: instance.variable.name,
      sortText: instance.scope === 'local' ? '1' : '2',
    })
  }
  for (const callable of listFunctions(scope.sources)) {
    if (callable.name.toUpperCase() !== wanted) continue
    if (findVariable(callable.name, scope.pouVariables, scope.globalVariables)) continue
    suggestions.push({
      kind: 'call',
      label: `${callable.name} — ${ALL_PARAMETERS}`,
      ...(callable.returnType ? { detail: ` : ${callable.returnType}` } : {}),
      documentation: callDocumentation(callable),
      insertText: buildCallSnippet(callable, { target: callable.name }),
      start,
      end,
      filterText: callable.name,
      sortText: '4',
    })
  }
  return suggestions
}

const lineIndentAt = (text: string, offset: number): string => {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ''
}

/** The end of a one-line call: after `)`, and after a following `;` when asked. */
const callEndOnLine = (text: string, call: CallSite, withSemicolon: boolean): number | null => {
  if (call.closeParen === null) return null
  let end = call.closeParen + 1
  const rest = withSemicolon ? /^[ \t]*;/.exec(text.slice(end)) : null
  if (rest) end += rest[0].length
  if (text.slice(call.nameStart, end).includes('\n')) return null
  return end
}

const paramItem = (param: CallParam, start: number, end: number, lead: string, index: number): CallSuggestion => ({
  kind: 'param',
  label: `${param.name} ${operatorFor(param)}`,
  detail: ` ${param.type}`,
  badge: badgeFor(param),
  documentation: paramDocumentation(param),
  insertText: `${lead}${paramSnippet(param, 1)}`,
  start,
  end,
  filterText: param.name,
  sortText: `3${String(index).padStart(4, '0')}`,
})

/**
 * Suggestions inside the argument list of `call`, or `null` when the cursor is on a value rather
 * than on a new parameter.
 */
const insideCallSuggestions = (
  text: string,
  offset: number,
  call: CallSite,
  resolved: ResolvedCall,
): CallSuggestion[] | null => {
  const { callable, target } = resolved
  const index = argIndexAt(call, offset)
  const current = index === -1 ? undefined : call.args[index]
  const typed = current ? text.slice(current.start, offset) : ''
  if (current?.operator) return null
  if (typed.trim() !== '' && !/^\s*[A-Za-z_][A-Za-z0-9_]*$/.test(typed)) return null

  const { start } = prefixAt(text, offset)
  const others = call.args.filter((arg) => arg !== current)
  const written = new Set(others.filter((arg) => arg.name).map((arg) => (arg.name ?? '').toUpperCase()))
  const unnamedCount = others.filter((arg) => !arg.name && !isEmptyArg(arg)).length
  const namedCount = written.size
  const lead = text[start - 1] === ',' ? ' ' : ''
  const suggestions: CallSuggestion[] = []

  if (unnamedCount > 0 && namedCount === 0) {
    if (callable.kind !== 'function' || typed.trim() !== '') return null
    const inputs = callable.params.filter((param) => param.direction === 'input')
    const slot = Math.max(0, index)
    const name = slot < inputs.length ? inputs[slot].name : extensibleInputName(callable, slot - inputs.length)
    const param = slot < inputs.length ? inputs[slot] : inputs[inputs.length - 1]
    if (!name || !param) return null
    suggestions.push({
      kind: 'param',
      label: NEXT_INPUT,
      detail: ` ${name} : ${param.type}`,
      badge: 'IN',
      documentation: paramDocumentation({ ...param, name }),
      insertText: '$0',
      start,
      end: offset,
      filterText: NEXT_INPUT,
      sortText: '0',
      preselect: true,
    })
    return suggestions
  }

  const emptyCall = namedCount === 0
  const statementEnd = emptyCall ? callEndOnLine(text, call, callable.kind === 'function-block') : null
  const multiline = text.slice(call.openParen, call.argsEnd).includes('\n')
  const separator = multiline ? `,\n${lineIndentAt(text, offset)}` : ', '

  const group = (label: string, part: CallPart, sortText: string, preselect: boolean) => {
    const params = selectParams(callable, part, written)
    if (params.length === 0) return
    if (part === 'outputs' && callable.kind === 'function' && callable.extensible) return
    const whole = statementEnd !== null && others.length === 0
    const insertText = whole
      ? buildCallSnippet(callable, { target, part })
      : callable.extensible && emptyCall && part !== 'outputs'
        ? null
        : `${lead}${paramsSnippet(params, separator)}`
    if (insertText === null) return
    suggestions.push({
      kind: 'group',
      label,
      detail: ` ${params.map((param) => param.name).join(', ')}`,
      documentation: resolved.documentation,
      insertText,
      start: whole ? call.nameStart : start,
      end: whole ? (statementEnd ?? offset) : offset,
      filterText: whole ? text.slice(call.nameStart, offset) : label,
      sortText,
      ...(preselect ? { preselect: true } : {}),
    })
  }

  if (emptyCall) group(ALL_PARAMETERS, 'all', '0', true)
  else group(ALL_REMAINING, 'all', '0', false)
  if (!callable.extensible) {
    group('inputs', 'inputs', '1', false)
    group('outputs', 'outputs', '2', false)
  }

  const missing = selectParams(callable, 'all', written)
  missing.forEach((param, position) => suggestions.push(paramItem(param, start, offset, lead, position)))

  if (callable.extensible) {
    const inputs = callable.params.filter((param) => param.direction === 'input')
    const last = inputs[inputs.length - 1]
    let extra = 0
    let next = extensibleInputName(callable, extra)
    while (next && written.has(next.toUpperCase())) {
      extra += 1
      next = extensibleInputName(callable, extra)
    }
    const allDeclaredWritten = inputs.every((param) => written.has(param.name.toUpperCase()))
    if (next && last && allDeclaredWritten) {
      suggestions.push(paramItem({ ...last, name: next }, start, offset, lead, missing.length))
    }
  }
  return suggestions
}

/** The call suggestions at `offset`. */
export const callSuggestionsAt = (text: string, offset: number, scope: CallScope): CallSuggestion[] => {
  const mask = codeMask(text)
  if (offset > 0 && !mask[offset - 1] && (offset >= text.length || !mask[offset])) return []
  const call = findCallAt(text, offset, mask)
  const resolved = call ? resolveCall(call.name, scope) : null
  if (!call || !resolved) return nameSuggestions(text, offset, scope)
  const inside = insideCallSuggestions(text, offset, call, resolved)
  if (inside === null) return nameSuggestions(text, offset, scope)
  return prefixAt(text, offset).prefix ? [...inside, ...nameSuggestions(text, offset, scope)] : inside
}
