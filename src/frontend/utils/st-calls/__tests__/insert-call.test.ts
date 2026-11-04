import { bodyInsertion, instanceOnDeclarationLine } from '../insert-call'
import { scope } from './fixtures/scope'

describe('instanceOnDeclarationLine', () => {
  it('finds an instance declaration', () => {
    expect(instanceOnDeclarationLine('    timer1 : TON;', 6, scope)?.name).toBe('timer1')
    expect(instanceOnDeclarationLine('timer1 : TON := (PT := T#1s); (* delay *)', 1, scope)?.callable.name).toBe('TON')
  })

  it('takes the name under the cursor on a line with several names', () => {
    const multi = { ...scope, pouVariables: [...scope.pouVariables, { ...scope.pouVariables[0], name: 'timer2' }] }
    expect(instanceOnDeclarationLine('timer1, timer2 : TON;', 10, multi)?.name).toBe('timer2')
    expect(instanceOnDeclarationLine('timer1, timer2 : TON;', 20, multi)?.name).toBe('timer1')
  })

  it('refuses other lines', () => {
    expect(instanceOnDeclarationLine('start : BOOL;', 1, scope)).toBeNull()
    expect(instanceOnDeclarationLine('VAR', 1, scope)).toBeNull()
    expect(instanceOnDeclarationLine('(* timer1 : TON; *)', 4, scope)).toBeNull()
    expect(instanceOnDeclarationLine('other : TON;', 1, scope)).toBeNull()
    expect(instanceOnDeclarationLine('lost : MISSING_FB;', 1, scope)).toBeNull()
  })
})

describe('bodyInsertion', () => {
  it('uses the cursor when there is one', () => {
    expect(bodyInsertion('a := 1;\nb := 2;', 8)).toEqual({ offset: 8, prefix: '' })
    expect(bodyInsertion('ab', 9)).toEqual({ offset: 2, prefix: '' })
  })

  it('appends on a new line otherwise', () => {
    expect(bodyInsertion('a := 1;', null)).toEqual({ offset: 7, prefix: '\n' })
    expect(bodyInsertion('a := 1;\n', null)).toEqual({ offset: 8, prefix: '' })
    expect(bodyInsertion('', null)).toEqual({ offset: 0, prefix: '' })
  })
})
