import { buildCallSnippet, defaultValueFor, escapeSnippet, selectParams } from '../build-call'
import { extensibleInputName, findCallable, listFunctions, listInstances } from '../callable'
import { scope, sources } from './fixtures/scope'

const callable = (name: string) => {
  const found = findCallable(name, sources)
  if (!found) throw new Error(`no ${name}`)
  return found
}

describe('findCallable', () => {
  it('reads a library block with inputs before outputs', () => {
    const ton = callable('ton')
    expect(ton.kind).toBe('function-block')
    expect(ton.params.map((p) => `${p.name}:${p.direction}`)).toEqual(['IN:input', 'PT:input', 'Q:output', 'ET:output'])
  })

  it('drops the synthetic return pin of a library function', () => {
    const limit = callable('LIMIT')
    expect(limit.params.map((p) => p.name)).toEqual(['MN', 'IN', 'MX'])
    expect(limit.returnType).toBe('ANY_ELEMENTARY')
  })

  it('orders a project block as inputs, in-outs, outputs and skips locals', () => {
    expect(callable('Motor').params.map((p) => p.name)).toEqual(['Start', 'Counter', 'Running'])
  })

  it('reads a project function with its return type', () => {
    expect(callable('Scale')).toMatchObject({ kind: 'function', returnType: 'REAL' })
  })

  it('returns null for an unknown name', () => {
    expect(findCallable('NOPE', sources)).toBeNull()
  })

  it('lets a project program shadow nothing callable', () => {
    const program = { name: 'TON', pouType: 'program' as const, body: { language: 'st' as const, value: '' } }
    expect(findCallable('TON', { ...sources, pous: [program] })).toBeNull()
  })

  it('lists project and library functions once each', () => {
    expect(listFunctions(sources).map((f) => f.name)).toEqual(['Scale', 'LIMIT', 'ADD', 'MUX'])
  })

  it('lists the instances in scope, locals first, unknown types left out', () => {
    expect(listInstances(scope.pouVariables, scope.globalVariables, sources).map((i) => i.variable.name)).toEqual([
      'timer1',
      'm1',
      'gTimer',
    ])
  })

  it('names the next input of an extensible function', () => {
    expect(extensibleInputName(callable('ADD'), 0)).toBe('IN3')
    expect(extensibleInputName(callable('MUX'), 1)).toBe('IN3')
    expect(extensibleInputName(callable('LIMIT'), 0)).toBeNull()
  })
})

describe('buildCallSnippet', () => {
  it('writes a timer call with defaults, empty outputs and a final stop', () => {
    expect(buildCallSnippet(callable('TON'), { target: 'timer1' })).toBe(
      'timer1(\n\tIN := ${1:TRUE},\n\tPT := ${2:T#100ms},\n\tQ => ${3},\n\tET => ${4}\n);$0',
    )
  })

  it('writes only the inputs when asked', () => {
    expect(buildCallSnippet(callable('TON'), { target: 't', part: 'inputs' })).toBe(
      't(\n\tIN := ${1:TRUE},\n\tPT := ${2:T#100ms}\n);$0',
    )
  })

  it('writes in-outs with := and no default', () => {
    expect(buildCallSnippet(callable('Motor'), { target: 'm1' })).toBe(
      'm1(\n\tStart := ${1:TRUE},\n\tCounter := ${2},\n\tRunning => ${3}\n);$0',
    )
  })

  it('writes a function call on one line', () => {
    expect(buildCallSnippet(callable('LIMIT'), { target: 'LIMIT' })).toBe('LIMIT(MN := ${1}, IN := ${2}, MX := ${3})$0')
  })

  it('writes an extensible function in the unnamed form', () => {
    expect(buildCallSnippet(callable('ADD'), { target: 'ADD' })).toBe('ADD(${1}, ${2})$0')
    expect(buildCallSnippet(callable('MUX'), { target: 'MUX' })).toBe('MUX(${1}, ${2}, ${3})$0')
  })

  it('writes an empty call for a block without parameters', () => {
    const empty = { ...callable('TON'), params: [] }
    expect(buildCallSnippet(empty, { target: 'x' })).toBe('x();$0')
  })

  it('knows the type defaults', () => {
    expect(['BOOL', 'time', 'INT', 'DINT', 'REAL', 'STRING', 'WORD'].map(defaultValueFor)).toEqual([
      'TRUE',
      'T#100ms',
      '0',
      '0',
      '0.0',
      "''",
      '',
    ])
  })

  it('escapes snippet syntax', () => {
    expect(escapeSnippet('a$b}c\\')).toBe('a\\$b\\}c\\\\')
  })

  it('selects groups and leaves out written parameters', () => {
    const names = (part: 'all' | 'inputs' | 'outputs', exclude: string[] = []) =>
      selectParams(callable('TON'), part, new Set(exclude)).map((p) => p.name)
    expect(names('outputs')).toEqual(['Q', 'ET'])
    expect(names('all', ['IN', 'PT'])).toEqual(['Q', 'ET'])
  })
})
