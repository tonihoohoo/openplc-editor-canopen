import { variableDropSnippet } from '../variable-drop'
import { scope } from './fixtures/scope'

describe('variableDropSnippet', () => {
  it('inserts the full call for an instance', () => {
    expect(variableDropSnippet('timer1', scope)).toBe(
      'timer1(\n\tIN := ${1:TRUE},\n\tPT := ${2:T#100ms},\n\tQ => ${3},\n\tET => ${4}\n);$0',
    )
  })

  it('inserts the name of any other variable', () => {
    expect(variableDropSnippet('start', scope)).toBe('start')
    expect(variableDropSnippet('lost', scope)).toBe('lost')
  })

  it('inserts nothing for a name that is not in scope', () => {
    expect(variableDropSnippet('nothing', scope)).toBeNull()
  })
})
