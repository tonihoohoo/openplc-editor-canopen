/**
 * Monaco providers for Structured Text calls next to the language server: call completion, the
 * "Remove empty parameters" quick fix and documentation hovers. Only POU body models
 * (`pouUri`) are served; the logic lives in `utils/st-calls`.
 */

import type * as Monaco from 'monaco-editor'

import type { PLCVariable } from '../../../middleware/shared/ports/types'
import type { OpenPLCStore } from '../../store'
import { type CallScope, callSuggestionsAt } from '../../utils/st-calls/completions'
import { hoverDocumentation } from '../../utils/st-calls/documentation'
import { codeMask, findCalls, isEmptyArg, removeEmptyArgs } from '../../utils/st-calls/parse-call'
import { parsePouUri } from '../st-lsp/types'

export const REMOVE_EMPTY_PARAMETERS = 'Remove empty parameters'

/** The variables, globals and libraries a POU body sees, or `null` for a model that is not a body. */
export const callScopeFor = (store: OpenPLCStore, uri: string): CallScope | null => {
  const parsed = parsePouUri(uri)
  if (!parsed || parsed.kind !== 'pou') return null
  const state = store.getState()
  const pous = state.project.data.pous
  const pou = pous.find((entry) => entry.name === parsed.name)
  if (!pou) return null
  const visible = new Set([...state.bundledLibraryNames, ...state.enabledLibraries])
  const globalVariables: readonly PLCVariable[] = state.project.data.configurations.resource.globalVariables
  return {
    pouVariables: pou.interface?.variables ?? [],
    globalVariables,
    sources: { pous, libraries: state.libraries.system.filter((library) => visible.has(library.name)) },
  }
}

const rangeOf = (model: Monaco.editor.ITextModel, monaco: typeof Monaco, start: number, end: number) => {
  const from = model.getPositionAt(start)
  const to = model.getPositionAt(end)
  return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column)
}

export const createCallCompletionProvider = (
  store: OpenPLCStore,
  monaco: typeof Monaco,
): Monaco.languages.CompletionItemProvider => ({
  triggerCharacters: ['(', ','],
  provideCompletionItems(model, position) {
    const scope = callScopeFor(store, model.uri.toString())
    if (!scope) return { suggestions: [] }
    const text = model.getValue()
    const offset = model.getOffsetAt(position)
    const suggestions = callSuggestionsAt(text, offset, scope).map((item) => ({
      label: {
        label: item.label,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.badge ? { description: item.badge } : {}),
      },
      kind:
        item.kind === 'param'
          ? monaco.languages.CompletionItemKind.Field
          : monaco.languages.CompletionItemKind.Function,
      insertText: item.insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range: rangeOf(model, monaco, item.start, item.end),
      sortText: item.sortText,
      ...(item.filterText ? { filterText: item.filterText } : {}),
      ...(item.preselect ? { preselect: true } : {}),
      ...(item.documentation ? { documentation: { value: item.documentation } } : {}),
    }))
    return { suggestions }
  },
})

export const createEmptyParametersCodeActionProvider = (
  store: OpenPLCStore,
  monaco: typeof Monaco,
): Monaco.languages.CodeActionProvider => ({
  provideCodeActions(model, range, context) {
    if (!callScopeFor(store, model.uri.toString())) return { actions: [], dispose: () => undefined }
    const text = model.getValue()
    const start = model.getOffsetAt(range.getStartPosition())
    const end = model.getOffsetAt(range.getEndPosition())
    const candidates = findCalls(text, codeMask(text)).filter(
      (call) => call.nameStart <= end && call.argsEnd >= start && call.args.some(isEmptyArg),
    )
    const call = candidates.sort((a, b) => a.argsEnd - a.nameStart - (b.argsEnd - b.nameStart))[0]
    const edit = call ? removeEmptyArgs(text, call) : null
    if (!edit) return { actions: [], dispose: () => undefined }
    const editRange = rangeOf(model, monaco, edit.start, edit.end)
    const action: Monaco.languages.CodeAction = {
      title: REMOVE_EMPTY_PARAMETERS,
      kind: 'quickfix',
      isPreferred: true,
      diagnostics: context.markers.filter((marker) => monaco.Range.areIntersectingOrTouching(marker, editRange)),
      edit: {
        edits: [
          { resource: model.uri, versionId: model.getVersionId(), textEdit: { range: editRange, text: edit.text } },
        ],
      },
    }
    return { actions: [action], dispose: () => undefined }
  },
})

export const createCallHoverProvider = (store: OpenPLCStore): Monaco.languages.HoverProvider => ({
  provideHover(model, position) {
    const scope = callScopeFor(store, model.uri.toString())
    if (!scope) return null
    const docs = hoverDocumentation(model.getValue(), model.getOffsetAt(position), scope)
    return docs ? { contents: [{ value: docs }] } : null
  },
})

/** Registers the three providers for `st`; dispose to remove them. */
export const registerStCallProviders = (store: OpenPLCStore, monaco: typeof Monaco): { dispose(): void } => {
  const disposables = [
    monaco.languages.registerCompletionItemProvider('st', createCallCompletionProvider(store, monaco)),
    monaco.languages.registerCodeActionProvider('st', createEmptyParametersCodeActionProvider(store, monaco), {
      providedCodeActionKinds: ['quickfix'],
    }),
    // '*' scores below the language server's 'st', so its hover part comes first.
    monaco.languages.registerHoverProvider('*', createCallHoverProvider(store)),
  ]
  return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) }
}
