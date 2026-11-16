import type * as Monaco from 'monaco-editor'

import { pouUri } from '../../st-lsp/types'
import { insertIntoBody } from '../insert-call'

const READ_ONLY = 91

function fakeBody(readOnly: boolean) {
  const uri = pouUri('main')
  const insert = jest.fn()
  const model = {
    uri: { toString: () => uri },
    getValue: () => 'x := 1;\n',
    getOffsetAt: () => 0,
    getPositionAt: () => ({ lineNumber: 2, column: 1 }),
  }
  const editor = {
    getModel: () => model,
    getOption: (option: number) => (option === READ_ONLY ? readOnly : undefined),
    getPosition: () => null,
    setPosition: jest.fn(),
    focus: jest.fn(),
    getContribution: () => ({ insert }),
  }
  const monaco = {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: { EditorOption: { readOnly: READ_ONLY }, getEditors: () => [editor] },
  } as unknown as typeof Monaco
  return { monaco, insert, editor }
}

describe('insertIntoBody', () => {
  it('inserts the call into an editable body', () => {
    const { monaco, insert } = fakeBody(false)
    expect(insertIntoBody(monaco, 'main', 'fb1();')).toBe(true)
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('leaves a read-only body unchanged, as during a debug session', () => {
    const { monaco, insert, editor } = fakeBody(true)
    expect(insertIntoBody(monaco, 'main', 'fb1();')).toBe(false)
    expect(insert).not.toHaveBeenCalled()
    expect(editor.setPosition).not.toHaveBeenCalled()
  })

  it('does nothing when no body editor of the POU is open', () => {
    const { monaco } = fakeBody(false)
    expect(insertIntoBody(monaco, 'other', 'fb1();')).toBe(false)
  })
})
