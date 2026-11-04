import { argIndexAt, codeMask, findCallAt, findCalls, isEmptyArg, removeEmptyArgs } from '../parse-call'

const at = (source: string) => {
  const offset = source.indexOf('|')
  return { text: source.replace('|', ''), offset }
}

describe('codeMask', () => {
  it('clears comments and strings', () => {
    const text = 'a (* b *) \'c\' "d" /* e */ // f\ng'
    const mask = codeMask(text)
    const code = [...text].filter((_, i) => mask[i]).join('')
    expect(code.replace(/\s+/g, '')).toBe('ag')
  })

  it('handles escapes and unclosed comments', () => {
    const text = "'it$'s' x (* open"
    const mask = codeMask(text)
    expect(
      [...text]
        .filter((_, i) => mask[i])
        .join('')
        .trim(),
    ).toBe('x')
  })
})

describe('findCallAt', () => {
  it('finds the call and its written parameters', () => {
    const { text, offset } = at('timer1(IN := start, PT := T#5s, |);')
    const call = findCallAt(text, offset)
    expect(call?.name).toBe('timer1')
    expect(call?.args.map((a) => a.name)).toEqual(['IN', 'PT', null])
    expect(call?.args[1]).toMatchObject({ operator: ':=', value: 'T#5s' })
    expect(call && argIndexAt(call, offset)).toBe(2)
  })

  it('reads outputs and NOT outputs', () => {
    const call = findCallAt('t(Q => x, NOT ET => y)', 2)
    expect(call?.args.map((a) => `${a.name}${a.operator}${a.value}`)).toEqual(['Q=>x', 'ET=>y'])
  })

  it('returns an empty argument list for empty parentheses', () => {
    const { text, offset } = at('timer1(|);')
    expect(findCallAt(text, offset)?.args).toEqual([])
  })

  it('picks the innermost call and skips nested ones in the outer list', () => {
    const { text, offset } = at('x := LIMIT(MN := ADD(a, |), IN := b, MX := c);')
    expect(findCallAt(text, offset)?.name).toBe('ADD')
    const outer = findCallAt(text, text.indexOf('IN :='))
    expect(outer?.name).toBe('LIMIT')
    expect(outer?.args.map((a) => a.name)).toEqual(['MN', 'IN', 'MX'])
  })

  it('ignores grouping parentheses, members, comments and strings', () => {
    expect(findCallAt('x := (a + |b);'.replace('|', ''), 9)).toBeNull()
    expect(findCallAt('a.b(c)', 4)).toBeNull()
    expect(findCallAt('(* t( *) x := 1;', 5)).toBeNull()
    expect(findCallAt("s := 't(';", 8)).toBeNull()
  })

  it('reads AND as a call only where an expression starts', () => {
    expect(findCallAt('x := AND(a, b);', 9)?.name).toBe('AND')
    expect(findCallAt('IF a AND (b) THEN', 10)).toBeNull()
  })

  it('stops at the end of the statement', () => {
    expect(findCallAt('a; b', 3)).toBeNull()
    const { text, offset } = at('t(IN := a, |\nx := 1;')
    const call = findCallAt(text, offset)
    expect(call?.closeParen).toBeNull()
    expect(call?.args.length).toBe(2)
  })

  it('handles array indexes and literals before parentheses', () => {
    expect(findCallAt('t(IN := arr[1], |)', 16)?.args.map((a) => a.name)).toEqual(['IN', null])
    expect(findCallAt('x := 16#(1)', 9)).toBeNull()
    expect(findCallAt('x := 1(2)', 7)).toBeNull()
  })

  it('returns null outside any call', () => {
    expect(findCallAt('x := 1;', 3)).toBeNull()
    expect(findCallAt('t(a) + |'.replace('|', ''), 7)).toBeNull()
  })
})

describe('findCalls', () => {
  it('lists outer calls before nested ones', () => {
    expect(findCalls('a(b(1), (2)); c()').map((c) => c.name)).toEqual(['a', 'b', 'c'])
  })
})

describe('removeEmptyArgs', () => {
  const fix = (text: string) => {
    const call = findCalls(text)[0]
    const edit = removeEmptyArgs(text, call)
    return edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : null
  }

  it('removes empty named parameters on one line', () => {
    expect(fix('timer1(IN := start, PT := T#5s, Q => , ET => );')).toBe('timer1(IN := start, PT := T#5s);')
  })

  it('keeps the layout of a multi-line call', () => {
    expect(fix('timer1(\n\tIN := start,\n\tPT := T#5s,\n\tQ => ,\n\tET => \n);')).toBe(
      'timer1(\n\tIN := start,\n\tPT := T#5s\n);',
    )
  })

  it('removes an empty unnamed value and a leading empty one', () => {
    expect(fix('x := ADD(a, , c);')).toBe('x := ADD(a, c);')
    expect(fix('x := ADD(, b);')).toBe('x := ADD(b);')
    expect(fix('t(\n\tQ => ,\n\tIN := a\n);')).toBe('t(\n\tIN := a\n);')
  })

  it('empties a call whose values are all empty', () => {
    expect(fix('t(Q => , ET => );')).toBe('t();')
  })

  it('returns null when every parameter has a value', () => {
    expect(fix('t(IN := a);')).toBeNull()
    expect(fix('t();')).toBeNull()
  })

  it('tells empty parameters apart', () => {
    const call = findCalls('t(Q => , x, )')[0]
    expect(call.args.map(isEmptyArg)).toEqual([true, false, true])
  })
})
