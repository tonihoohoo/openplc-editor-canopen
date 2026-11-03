import { escapeMarkdown, hoverDocumentation, identifierAt } from '../documentation'
import { scope } from './fixtures/scope'

const hover = (source: string) => {
  const offset = source.indexOf('|')
  return hoverDocumentation(source.replace('|', ''), offset, scope)
}

describe('hoverDocumentation', () => {
  it('shows the variable Documentation and the block description for an instance', () => {
    expect(hover('ti|mer1(IN := start);')).toBe('pump delay\n\nThe on\\-delay timer\\.')
  })

  it('shows the parameter description inside a call', () => {
    expect(hover('timer1(IN := start, P|T := T#5s);')).toBe('`PT : TIME`\n\nPreset time\\.')
  })

  it('adds nothing for a parameter without a description', () => {
    expect(hover('timer1(Q| => x);')).toBeNull()
  })

  it('shows a function description and nothing for a plain variable', () => {
    expect(hover('y := LIM|IT(1, 2, 3);')).toBe('Limits a value\\.')
    expect(hover('sta|rt')).toBeNull()
    expect(hover('ADD|(a, b)')).toBeNull()
  })

  it('shows a plain variable Documentation', () => {
    const withDocs = { ...scope, pouVariables: [{ ...scope.pouVariables[1], documentation: 'run *now*' }] }
    expect(hoverDocumentation('start', 2, withDocs)).toBe('run \\*now\\*')
  })

  it('shows nothing in comments, members or numbers', () => {
    expect(hover('(* timer|1 *)')).toBeNull()
    expect(hover('x.tim|er1')).toBeNull()
    expect(hover('x := 1|2;')).toBeNull()
    expect(hover('x := 1 + |;')).toBeNull()
  })

  it('reads the instance from a global', () => {
    expect(hover('gTi|mer()')).toBe('The on\\-delay timer\\.')
  })
})

describe('helpers', () => {
  it('escapes Markdown', () => {
    expect(escapeMarkdown('a_b [c](d)')).toBe('a\\_b \\[c\\]\\(d\\)')
  })

  it('finds the identifier around an offset', () => {
    expect(identifierAt('ab cd', 4)).toEqual({ word: 'cd', start: 3, end: 5 })
    expect(identifierAt('ab  cd', 3)).toBeNull()
  })
})
