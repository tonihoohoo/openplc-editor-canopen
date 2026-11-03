/**
 * What dropping a variable from the POU variable table into an ST body inserts: the full call for a
 * function block instance, the variable's name otherwise.
 */

import { buildCallSnippet, escapeSnippet } from './build-call'
import { findVariable, instanceCallable } from './callable'
import type { CallScope } from './completions'

/** Drag data type of a variable dragged by its `#` cell; the value is the variable's name. */
export const VARIABLE_DRAG_TYPE = 'application/x-plc-variable'

/** The snippet for the dropped variable `name`, or `null` when no such variable is in scope. */
export const variableDropSnippet = (name: string, scope: CallScope): string | null => {
  const found = findVariable(name, scope.pouVariables, scope.globalVariables)
  if (!found) return null
  const callable = instanceCallable(found.variable, scope.sources)
  return callable ? buildCallSnippet(callable, { target: found.variable.name }) : escapeSnippet(found.variable.name)
}
