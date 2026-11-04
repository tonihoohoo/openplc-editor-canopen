/**
 * Markdown documentation for ST hovers and suggestion details: a variable's Documentation, a block's
 * or function's description and a parameter's description. All user text is escaped.
 */

import type { PLCVariable } from '../../../middleware/shared/ports/types'
import {
  type Callable,
  type CallableSources,
  type CallParam,
  findCallable,
  findVariable,
  instanceCallable,
} from './callable'
import { argIndexAt, codeMask, findCallAt } from './parse-call'

/** Escape text so Markdown shows it literally. */
export const escapeMarkdown = (text: string): string => text.replace(/([\\`*_{}[\]()#+\-.!|<>~])/g, '\\$1')

const paragraphs = (texts: readonly string[]): string =>
  texts
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .map(escapeMarkdown)
    .join('\n\n')

/** A function block's or function's description, after the variable's Documentation when given. */
export const callDocumentation = (callable: Callable, variable?: PLCVariable): string =>
  paragraphs([variable?.documentation ?? '', callable.documentation])

/** `PT : TIME` and the parameter's description. */
export const paramDocumentation = (param: CallParam): string => {
  const heading = `\`${param.name} : ${param.type}\``
  const description = paragraphs([param.documentation])
  return description ? `${heading}\n\n${description}` : heading
}

export interface HoverScope {
  pouVariables: readonly PLCVariable[]
  globalVariables: readonly PLCVariable[]
  sources: CallableSources
}

const IDENTIFIER = /[A-Za-z0-9_]/

/** The identifier around `offset` and its start, or `null`. */
export const identifierAt = (text: string, offset: number): { word: string; start: number; end: number } | null => {
  let start = offset
  while (start > 0 && IDENTIFIER.test(text[start - 1])) start -= 1
  let end = offset
  while (end < text.length && IDENTIFIER.test(text[end])) end += 1
  if (start === end || /^\d/.test(text.slice(start, end))) return null
  return { word: text.slice(start, end), start, end }
}

/**
 * The documentation shown in a hover at `offset`, as Markdown, or `null` when there is none: a
 * parameter name inside a call, a variable or instance in scope, or a function or block name.
 */
export const hoverDocumentation = (text: string, offset: number, scope: HoverScope): string | null => {
  const mask = codeMask(text)
  const found = identifierAt(text, offset)
  if (!found || !mask[found.start]) return null
  const before = text.slice(0, found.start).replace(/\s+$/, '')
  if (before.endsWith('.') || before.endsWith('#')) return null

  const after = text.slice(found.end).replace(/^\s+/, '')
  if (after.startsWith(':=') || after.startsWith('=>')) {
    const call = findCallAt(text, found.start, mask)
    const index = call ? argIndexAt(call, found.start) : -1
    if (call && index !== -1 && call.args[index].name?.toUpperCase() === found.word.toUpperCase()) {
      const variable = findVariable(call.name, scope.pouVariables, scope.globalVariables)?.variable
      const callable = variable ? instanceCallable(variable, scope.sources) : findCallable(call.name, scope.sources)
      const param = callable?.params.find((entry) => entry.name.toUpperCase() === found.word.toUpperCase())
      return param && param.documentation.trim() !== '' ? paramDocumentation(param) : null
    }
  }

  const variable = findVariable(found.word, scope.pouVariables, scope.globalVariables)
  if (variable) {
    const callable = instanceCallable(variable.variable, scope.sources)
    const docs = callable
      ? callDocumentation(callable, variable.variable)
      : paragraphs([variable.variable.documentation ?? ''])
    return docs || null
  }

  const callable = findCallable(found.word, scope.sources)
  const docs = callable ? callDocumentation(callable) : ''
  return docs || null
}
