/**
 * "Insert call" in the context menu of the variables code view: writes the call of the instance on
 * the clicked declaration line into the POU's ST body editor.
 */

import type * as Monaco from 'monaco-editor'

import type { OpenPLCStore } from '../../store'
import { buildCallSnippet } from '../../utils/st-calls/build-call'
import { bodyInsertion, instanceOnDeclarationLine } from '../../utils/st-calls/insert-call'
import { pouUri } from '../st-lsp/types'
import { callScopeFor } from './providers'

export const INSERT_CALL_ACTION_ID = 'openplc.st.insertCall'
const CONTEXT_KEY = 'openplcInsertCallAvailable'

const bodiesWithCursor = new WeakSet<Monaco.editor.ITextModel>()

/** Remembers that the body editor's cursor was placed by the user, so "Insert call" uses it. */
export const trackBodyCursor = (editor: Monaco.editor.IStandaloneCodeEditor): Monaco.IDisposable =>
  editor.onDidFocusEditorText(() => {
    const model = editor.getModel()
    if (model) bodiesWithCursor.add(model)
  })

const findBodyEditor = (monaco: typeof Monaco, pouName: string): Monaco.editor.ICodeEditor | undefined => {
  const uri = monaco.Uri.parse(pouUri(pouName)).toString()
  return monaco.editor.getEditors().find((editor) => editor.getModel()?.uri.toString() === uri)
}

/** Inserts `snippet` into the body of `pouName`; `false` when no body editor is open. */
export const insertIntoBody = (monaco: typeof Monaco, pouName: string, snippet: string): boolean => {
  const body = findBodyEditor(monaco, pouName)
  const model = body?.getModel()
  if (!body || !model) return false
  const position = body.getPosition()
  const cursor = bodiesWithCursor.has(model) && position ? model.getOffsetAt(position) : null
  const { offset, prefix } = bodyInsertion(model.getValue(), cursor)
  body.setPosition(model.getPositionAt(offset))
  body.focus()
  const controller = body.getContribution('snippetController2') as unknown as { insert(text: string): void } | null
  controller?.insert(prefix + snippet)
  return true
}

/** Adds "Insert call" to the variables code view of `pouName`, shown on function block declaration lines. */
export const registerInsertCallAction = (
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  store: OpenPLCStore,
  pouName: string,
): Monaco.IDisposable => {
  const available = editor.createContextKey<boolean>(CONTEXT_KEY, false)
  const instanceAtCursor = () => {
    const model = editor.getModel()
    const position = editor.getPosition()
    const scope = callScopeFor(store, pouUri(pouName))
    if (!model || !position || !scope || !findBodyEditor(monaco, pouName)) return null
    return instanceOnDeclarationLine(model.getLineContent(position.lineNumber), position.column, scope)
  }
  const update = () => available.set(instanceAtCursor() !== null)
  const cursorListener = editor.onDidChangeCursorPosition(update)
  const contentListener = editor.onDidChangeModelContent(update)
  const action = editor.addAction({
    id: INSERT_CALL_ACTION_ID,
    label: 'Insert call',
    precondition: CONTEXT_KEY,
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 0,
    run: () => {
      const instance = instanceAtCursor()
      if (instance) insertIntoBody(monaco, pouName, buildCallSnippet(instance.callable, { target: instance.name }))
    },
  })
  update()
  return {
    dispose: () => {
      cursorListener.dispose()
      contentListener.dispose()
      action.dispose()
    },
  }
}
