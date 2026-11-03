import type * as Monaco from 'monaco-editor'

import type { PLCPou } from '../../../../middleware/shared/ports/types'
import type { OpenPLCStore } from '../../../store'
import { createTestStore } from '../../../store/testing'
import { library, variable } from '../../../utils/st-calls/__tests__/fixtures/scope'
import { pouUri } from '../../st-lsp/types'
import {
  callScopeFor,
  createCallCompletionProvider,
  createCallHoverProvider,
  createEmptyParametersCodeActionProvider,
  REMOVE_EMPTY_PARAMETERS,
  registerStCallProviders,
} from '../providers'

class FakeRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
  getStartPosition() {
    return { lineNumber: this.startLineNumber, column: this.startColumn }
  }
  getEndPosition() {
    return { lineNumber: this.endLineNumber, column: this.endColumn }
  }
  static areIntersectingOrTouching() {
    return true
  }
}

const disposable = { dispose: jest.fn() }
const fakeMonaco = {
  Range: FakeRange,
  languages: {
    CompletionItemKind: { Variable: 4, Function: 1 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: jest.fn(() => disposable),
    registerCodeActionProvider: jest.fn(() => disposable),
    registerHoverProvider: jest.fn(() => disposable),
  },
} as unknown as typeof Monaco

const fakeModel = (text: string, uri = pouUri('main')) => {
  const positionAt = (offset: number) => {
    const before = text.slice(0, offset).split('\n')
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 }
  }
  const offsetAt = (position: { lineNumber: number; column: number }) =>
    text
      .split('\n')
      .slice(0, position.lineNumber - 1)
      .reduce((sum, line) => sum + line.length + 1, 0) +
    position.column -
    1
  return {
    uri: { toString: () => uri },
    getValue: () => text,
    getVersionId: () => 1,
    getOffsetAt: offsetAt,
    getPositionAt: positionAt,
  } as unknown as Monaco.editor.ITextModel
}

const main: PLCPou = {
  name: 'main',
  pouType: 'program',
  body: { language: 'st', value: '' },
  interface: { variables: [variable('timer1', 'TON', { documentation: 'pump delay' }), variable('start', 'BOOL')] },
}

let store: OpenPLCStore

beforeEach(() => {
  store = createTestStore()
  store.setState((state) => ({
    project: { ...state.project, data: { ...state.project.data, pous: [main] } },
    libraries: { ...state.libraries, system: [library, { ...library, name: 'hidden' }] },
    bundledLibraryNames: ['std'],
  }))
})

const position = (model: Monaco.editor.ITextModel, offset: number) => model.getPositionAt(offset) as Monaco.Position

describe('callScopeFor', () => {
  it('serves POU bodies with the visible libraries only', () => {
    const scope = callScopeFor(store, pouUri('main'))
    expect(scope?.pouVariables.map((v) => v.name)).toEqual(['timer1', 'start'])
    expect(scope?.sources.libraries.map((l) => l.name)).toEqual(['std'])
  })

  it('ignores other models and unknown POUs', () => {
    expect(callScopeFor(store, 'inmemory://pouvars/main.st')).toBeNull()
    expect(callScopeFor(store, pouUri('other'))).toBeNull()
  })
})

describe('completion provider', () => {
  it('maps suggestions to Monaco items with ranges, badges and docs', () => {
    const provider = createCallCompletionProvider(store, fakeMonaco)
    const model = fakeModel('x := 1;\ntimer1();')
    const result = provider.provideCompletionItems(model, position(model, 15), {} as never, {} as never) as {
      suggestions: Monaco.languages.CompletionItem[]
    }
    const pt = result.suggestions.find((item) => typeof item.label !== 'string' && item.label.label === 'PT :=')
    expect(pt).toMatchObject({ label: { detail: ' TIME', description: 'IN' }, kind: 4, insertTextRules: 4 })
    expect(pt?.range).toEqual(new FakeRange(2, 8, 2, 8))
    expect(result.suggestions[0]).toMatchObject({ preselect: true, kind: 1 })
    expect(provider.triggerCharacters).toEqual(['(', ','])
  })

  it('returns nothing outside a POU body', () => {
    const provider = createCallCompletionProvider(store, fakeMonaco)
    const model = fakeModel('tim', 'inmemory://other')
    expect(provider.provideCompletionItems(model, position(model, 3), {} as never, {} as never)).toEqual({
      suggestions: [],
    })
  })
})

describe('code action provider', () => {
  const actionsFor = (text: string, offset: number, uri?: string) => {
    const provider = createEmptyParametersCodeActionProvider(store, fakeMonaco)
    const model = fakeModel(text, uri)
    const at = model.getPositionAt(offset)
    const range = new FakeRange(at.lineNumber, at.column, at.lineNumber, at.column) as unknown as Monaco.Range
    return provider.provideCodeActions(model, range, { markers: [{}] } as never, {} as never) as unknown as {
      actions: Monaco.languages.CodeAction[]
    }
  }

  it('offers the quick fix on a call with empty parameters', () => {
    const { actions } = actionsFor('timer1(IN := start, Q => );', 3)
    expect(actions.map((a) => a.title)).toEqual([REMOVE_EMPTY_PARAMETERS])
    const edit = actions[0].edit?.edits[0] as Monaco.languages.IWorkspaceTextEdit
    expect(edit.textEdit.text).toBe('IN := start')
    expect(actions[0]).toMatchObject({ kind: 'quickfix', isPreferred: true })
  })

  it('offers nothing when every parameter has a value or outside a body', () => {
    expect(actionsFor('timer1(IN := start);', 3).actions).toEqual([])
    expect(actionsFor('timer1(Q => );', 3, 'inmemory://other').actions).toEqual([])
  })
})

describe('hover provider', () => {
  it('shows documentation and nothing when there is none', () => {
    const provider = createCallHoverProvider(store)
    const model = fakeModel('timer1(); start')
    expect(provider.provideHover(model, position(model, 2), {} as never)).toEqual({
      contents: [{ value: 'pump delay\n\nThe on\\-delay timer\\.' }],
    })
    expect(provider.provideHover(model, position(model, 12), {} as never)).toBeNull()
    expect(provider.provideHover(fakeModel('x', 'inmemory://other'), position(model, 0), {} as never)).toBeNull()
  })
})

describe('registerStCallProviders', () => {
  it('registers three providers for st and disposes them', () => {
    const handle = registerStCallProviders(store, fakeMonaco)
    expect(fakeMonaco.languages.registerCompletionItemProvider).toHaveBeenCalledWith('st', expect.anything())
    expect(fakeMonaco.languages.registerHoverProvider).toHaveBeenCalledWith('*', expect.anything())
    handle.dispose()
    expect(disposable.dispose).toHaveBeenCalledTimes(3)
  })
})
