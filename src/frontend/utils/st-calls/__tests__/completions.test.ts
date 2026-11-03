import { callSuggestionsAt, resolveCall } from '../completions'
import { scope } from './fixtures/scope'

const suggest = (source: string) => {
  const offset = source.indexOf('|')
  const text = source.replace('|', '')
  return { text, items: callSuggestionsAt(text, offset, scope) }
}

const labels = (source: string) => suggest(source).items.map((item) => item.label)

const apply = (source: string, label: string) => {
  const { text, items } = suggest(source)
  const item = items.find((entry) => entry.label === label)
  if (!item) throw new Error(`no ${label} in ${items.map((i) => i.label).join(', ')}`)
  return text.slice(0, item.start) + item.insertText + text.slice(item.end)
}

describe('call suggestions after a name', () => {
  it('offers the full call of an instance next to its name', () => {
    const { items } = suggest('tim|')
    expect(items.map((i) => i.label)).toEqual(['timer1 — all parameters'])
    expect(items[0]).toMatchObject({ filterText: 'timer1', sortText: '1', start: 0, end: 3 })
    expect(apply('tim|', 'timer1 — all parameters')).toBe(
      'timer1(\n\tIN := ${1:TRUE},\n\tPT := ${2:T#100ms},\n\tQ => ${3},\n\tET => ${4}\n);$0',
    )
  })

  it('offers globals after locals and functions last', () => {
    const { items } = suggest('g|')
    expect(items.map((i) => [i.label, i.sortText])).toEqual([['gTimer — all parameters', '2']])
    expect(labels('LIM|')).toEqual([])
    expect(labels('limit|')).toEqual(['LIMIT — all parameters'])
    expect(suggest('LIMIT|').items[0].sortText).toBe('4')
  })

  it('replaces the whole word under the cursor', () => {
    const { items } = suggest('ti|mer1')
    expect(items[0]).toMatchObject({ start: 0, end: 6 })
  })

  it('offers nothing for a plain variable, an unknown block or a member', () => {
    expect(labels('sta|')).toEqual([])
    expect(labels('los|')).toEqual([])
    expect(labels('timer1.Q|')).toEqual([])
    expect(labels('|')).toEqual([])
  })

  it('offers nothing in a comment or a string', () => {
    expect(labels('(* tim| *)')).toEqual([])
    expect(labels("'tim|'")).toEqual([])
  })
})

describe('call suggestions in an instance call', () => {
  it('lists groups and every parameter in empty parentheses, all parameters preselected', () => {
    const { items } = suggest('timer1(|);')
    expect(items.map((i) => i.label)).toEqual([
      'all parameters',
      'inputs',
      'outputs',
      'IN :=',
      'PT :=',
      'Q =>',
      'ET =>',
    ])
    expect(items[0].preselect).toBe(true)
    expect(items.slice(3).map((i) => i.badge)).toEqual(['IN', 'IN', 'OUT', 'OUT'])
    expect(items[4].detail).toBe(' TIME')
    expect(items[4].documentation).toBe('`PT : TIME`\n\nPreset time\\.')
  })

  it('turns empty parentheses into the full call', () => {
    expect(apply('timer1(|);', 'all parameters')).toBe(
      'timer1(\n\tIN := ${1:TRUE},\n\tPT := ${2:T#100ms},\n\tQ => ${3},\n\tET => ${4}\n);$0',
    )
    expect(apply('  timer1(|)', 'inputs')).toBe('  timer1(\n\tIN := ${1:TRUE},\n\tPT := ${2:T#100ms}\n);$0')
  })

  it('adds a single parameter at the cursor', () => {
    expect(apply('timer1(|);', 'PT :=')).toBe('timer1(PT := ${1:T#100ms});')
  })

  it('offers only what is missing after a comma', () => {
    const source = 'timer1(IN := start, PT := T#5s,|);'
    expect(labels(source)).toEqual(['all remaining', 'outputs', 'Q =>', 'ET =>'])
    expect(apply(source, 'Q =>')).toBe('timer1(IN := start, PT := T#5s, Q => ${1});')
    expect(apply(source, 'all remaining')).toBe('timer1(IN := start, PT := T#5s, Q => ${1}, ET => ${2});')
  })

  it('keeps one parameter per line in a multi-line call', () => {
    expect(apply('timer1(\n\tIN := start,\n\t|\n);', 'outputs')).toBe(
      'timer1(\n\tIN := start,\n\tQ => ${1},\n\tET => ${2}\n);',
    )
  })

  it('inserts at the cursor when an empty call spans lines or is not closed', () => {
    expect(apply('timer1(\n|);', 'inputs')).toBe('timer1(\nIN := ${1:TRUE},\nPT := ${2:T#100ms});')
    expect(apply('timer1(|', 'outputs')).toBe('timer1(Q => ${1}, ET => ${2}')
  })

  it('filters parameters by the typed prefix and keeps value suggestions', () => {
    const { items } = suggest('timer1(IN := start, P|);')
    expect(items.find((i) => i.label === 'PT :=')).toMatchObject({ filterText: 'PT', start: 20, end: 21 })
  })

  it('suggests values, not parameters, after an operator', () => {
    expect(labels('timer1(IN := tim|);')).toEqual(['timer1 — all parameters'])
    expect(labels('timer1(IN := a + |);')).toEqual([])
  })

  it('marks in-outs and works for a project block', () => {
    const { items } = suggest('m1(|);')
    expect(items.filter((i) => i.kind === 'param').map((i) => `${i.label} ${i.badge}`)).toEqual([
      'Start := IN',
      'Counter := IN/OUT',
      'Running => OUT',
    ])
    expect(items[0].documentation).toBe('Drives a motor\\.')
  })

  it('offers no parameters for an unknown block type', () => {
    expect(labels('lost(|);')).toEqual([])
  })
})

describe('call suggestions in a function call', () => {
  it('lists the inputs of a fixed function without outputs', () => {
    expect(labels('y := LIMIT(|);')).toEqual(['all parameters', 'inputs', 'MN :=', 'IN :=', 'MX :='])
    expect(apply('y := LIMIT(|);', 'all parameters')).toBe('y := LIMIT(MN := ${1}, IN := ${2}, MX := ${3})$0;')
  })

  it('offers the unnamed full call and named inputs for an extensible function', () => {
    expect(labels('y := ADD(|);')).toEqual(['all parameters', 'IN1 :=', 'IN2 :='])
    expect(apply('y := ADD(|);', 'all parameters')).toBe('y := ADD(${1}, ${2})$0;')
  })

  it('offers the next unnamed input after a comma', () => {
    const { items } = suggest('y := ADD(a, b, |);')
    expect(items.map((i) => [i.label, i.detail])).toEqual([['next input', ' IN3 : ANY_NUM']])
    expect(labels('y := ADD(a, b, c, |);')).toEqual(['next input'])
    expect(suggest('y := ADD(a, b, c, |);').items[0].detail).toBe(' IN4 : ANY_NUM')
    expect(suggest('y := MUX(k, a, b, |);').items[0].detail).toBe(' IN2 : ANY')
    expect(suggest('y := LIMIT(a, |);').items[0].detail).toBe(' IN : ANY_ELEMENTARY')
  })

  it('offers nothing past the last input of a fixed unnamed call', () => {
    expect(labels('y := LIMIT(a, b, c, |);')).toEqual([])
  })

  it('continues a named extensible call with names', () => {
    expect(labels('y := ADD(IN1 := a, IN2 := b, |);')).toEqual(['IN3 :='])
    expect(labels('y := ADD(IN1 := a, IN2 := b, IN3 := c, |);')).toEqual(['IN4 :='])
    expect(labels('y := ADD(IN1 := a, |);')).toEqual(['all remaining', 'IN2 :='])
  })

  it('does not offer function calls in unnamed values of block instances', () => {
    expect(labels('y := ADD(a, LIMIT|);')).toEqual(['LIMIT — all parameters'])
  })

  it('offers no call items for an unknown function', () => {
    expect(labels('y := NOPE(|);')).toEqual([])
  })

  it('resolves instances, functions and nothing else', () => {
    expect(resolveCall('timer1', scope)?.target).toBe('timer1')
    expect(resolveCall('limit', scope)?.target).toBe('LIMIT')
    expect(resolveCall('start', scope)).toBeNull()
    expect(resolveCall('TON', scope)).toBeNull()
  })
})

describe('filtering', () => {
  it('lets a group item that rewrites the call match the text it replaces', () => {
    const { items } = suggest('timer1(|);')
    expect(items[0]).toMatchObject({ start: 0, filterText: 'timer1(' })
  })
})
