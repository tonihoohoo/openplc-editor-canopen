import { parseLibraryDropToStText } from '../drag-and-drop/st'

const pin = (name: string, cls: string, value: string) => ({
  name,
  class: cls,
  type: { definition: 'base-type', value },
})

describe('parseLibraryDropToStText', () => {
  it('inserts a function block call with its outputs under the instance name', () => {
    const ton = {
      name: 'TON',
      type: 'function-block',
      variables: [pin('IN', 'input', 'BOOL'), pin('PT', 'input', 'TIME'), pin('Q', 'output', 'BOOL')],
    }
    expect(parseLibraryDropToStText(ton, 'TON0')).toBe(
      'TON0(\n\tIN := ${1:TRUE},\n\tPT := ${2:T#100ms},\n\tQ => ${3}\n);$0',
    )
  })

  it('keeps the inputs-only text for a function', () => {
    const limit = {
      name: 'LIMIT',
      type: 'function',
      variables: [pin('MN', 'input', 'INT'), pin('OUT', 'output', 'INT')],
    }
    expect(parseLibraryDropToStText(limit, 'LIMIT')).toBe('LIMIT (\n    MN := ${1:0}\n);')
  })
})
