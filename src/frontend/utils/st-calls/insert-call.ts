/**
 * "Insert call" from the variables code view: which declaration line names a function block
 * instance, and where the call goes in the POU body.
 */

import { type Callable, findVariable, instanceCallable } from './callable'
import type { CallScope } from './completions'
import { codeMask } from './parse-call'

const DECLARATION =
  /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|:=|$)/

/**
 * The instance declared on `line` whose type is a function block, or `null`. With several names on
 * one line, the one under `column` (1-based) is taken, else the first.
 */
export const instanceOnDeclarationLine = (
  line: string,
  column: number,
  scope: CallScope,
): { name: string; callable: Callable } | null => {
  const mask = codeMask(line)
  const code = [...line].map((char, index) => (mask[index] ? char : ' ')).join('')
  const match = DECLARATION.exec(code)
  if (!match) return null
  const names = match[1].split(',').map((name) => name.trim())
  const offset = column - 1
  let picked = names[0]
  let searchFrom = 0
  for (const name of names) {
    const start = code.indexOf(name, searchFrom)
    searchFrom = start + name.length
    if (offset >= start && offset <= start + name.length) picked = name
  }
  const found = findVariable(picked, scope.pouVariables, [])
  if (!found) return null
  const callable = instanceCallable(found.variable, scope.sources)
  return callable ? { name: found.variable.name, callable } : null
}

/** Where the call goes: at the body's cursor, or on a new line at the end when it has none. */
export const bodyInsertion = (body: string, cursorOffset: number | null): { offset: number; prefix: string } => {
  if (cursorOffset !== null) return { offset: Math.min(cursorOffset, body.length), prefix: '' }
  const prefix = body === '' || body.endsWith('\n') ? '' : '\n'
  return { offset: body.length, prefix }
}
