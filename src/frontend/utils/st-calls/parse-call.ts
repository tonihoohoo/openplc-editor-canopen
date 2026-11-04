/**
 * A light Structured Text scanner for calls: finds the call around an offset and the parameters
 * written in it, skipping comments and string literals. Offsets are 0-based into the text.
 */

export interface CallArg {
  /** Segment between the separating commas, untrimmed. */
  start: number
  end: number
  /** Trimmed text of the segment. */
  text: string
  name: string | null
  operator: ':=' | '=>' | null
  value: string
}

export interface CallSite {
  name: string
  nameStart: number
  openParen: number
  /** Offset of the matching `)`, or `null` when the call is not closed yet. */
  closeParen: number | null
  /** End of the argument list: `closeParen`, or where an unclosed call stops. */
  argsEnd: number
  args: CallArg[]
}

/** Marks each offset that is code (1) rather than a comment or a string literal (0). */
export const codeMask = (text: string): Uint8Array => {
  const mask = new Uint8Array(text.length).fill(1)
  let index = 0
  const clear = (from: number, to: number) => mask.fill(0, from, Math.min(to, text.length))
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '(' && next === '*') {
      const end = text.indexOf('*)', index + 2)
      const stop = end === -1 ? text.length : end + 2
      clear(index, stop)
      index = stop
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      const stop = end === -1 ? text.length : end + 2
      clear(index, stop)
      index = stop
    } else if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index)
      const stop = end === -1 ? text.length : end
      clear(index, stop)
      index = stop
    } else if (char === "'" || char === '"') {
      let stop = index + 1
      while (stop < text.length && text[stop] !== char && text[stop] !== '\n') {
        stop += text[stop] === '$' ? 2 : 1
      }
      stop = Math.min(stop + 1, text.length)
      clear(index, stop)
      index = stop
    } else {
      index += 1
    }
  }
  return mask
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/
/** Operators that are also standard functions; read as a call only where an expression starts. */
const OPERATOR_NAMES = new Set(['AND', 'OR', 'XOR', 'NOT', 'MOD'])
const EXPRESSION_START = new Set(['', '(', ',', '=', ';', '>'])

const previousCodeChar = (text: string, mask: Uint8Array, from: number): { char: string; index: number } => {
  let index = from
  while (index >= 0 && (!mask[index] || /\s/.test(text[index]))) index -= 1
  return index < 0 ? { char: '', index } : { char: text[index], index }
}

/** The identifier that ends right before `openParen`, or `null` for a grouping parenthesis. */
const calleeBefore = (text: string, mask: Uint8Array, openParen: number): { name: string; start: number } | null => {
  let end = openParen - 1
  while (end >= 0 && /\s/.test(text[end]) && mask[end]) end -= 1
  if (end < 0 || !mask[end] || !IDENTIFIER_CHAR.test(text[end])) return null
  let start = end
  while (start > 0 && mask[start - 1] && IDENTIFIER_CHAR.test(text[start - 1])) start -= 1
  const name = text.slice(start, end + 1)
  if (/^\d/.test(name)) return null
  const before = previousCodeChar(text, mask, start - 1)
  if (before.char === '.' || before.char === '#') return null
  if (OPERATOR_NAMES.has(name.toUpperCase()) && !EXPRESSION_START.has(before.char)) return null
  return { name, start }
}

const ARG_PATTERN = /^(?:NOT\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(:=|=>)([\s\S]*)$/i

const parseArg = (text: string, start: number, end: number): CallArg => {
  const raw = text.slice(start, end)
  const trimmed = raw.trim()
  const match = ARG_PATTERN.exec(trimmed)
  if (!match) return { start, end, text: trimmed, name: null, operator: null, value: trimmed }
  const operator = match[2] === '=>' ? '=>' : ':='
  return { start, end, text: trimmed, name: match[1], operator, value: match[3].trim() }
}

/** Parses the call whose `(` is at `openParen`. */
export const parseCallAt = (text: string, openParen: number, mask: Uint8Array = codeMask(text)): CallSite | null => {
  const callee = calleeBefore(text, mask, openParen)
  if (!callee) return null
  const args: CallArg[] = []
  let depth = 0
  let segmentStart = openParen + 1
  let closeParen: number | null = null
  let index = openParen + 1
  for (; index < text.length; index += 1) {
    if (!mask[index]) continue
    const char = text[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ']') depth = Math.max(0, depth - 1)
    else if (char === ')') {
      if (depth === 0) {
        closeParen = index
        break
      }
      depth -= 1
    } else if (char === ',' && depth === 0) {
      args.push(parseArg(text, segmentStart, index))
      segmentStart = index + 1
    } else if (char === ';' && depth === 0) break
  }
  const argsEnd = closeParen ?? index
  args.push(parseArg(text, segmentStart, argsEnd))
  if (args.length === 1 && args[0].text === '') args.length = 0
  return { name: callee.name, nameStart: callee.start, openParen, closeParen, argsEnd, args }
}

/**
 * The innermost call whose argument list holds `offset`, or `null` when the offset is outside any
 * call, in a grouping parenthesis, in a comment or in a string.
 */
export const findCallAt = (text: string, offset: number, mask: Uint8Array = codeMask(text)): CallSite | null => {
  if (offset > 0 && offset <= text.length && !mask[offset - 1] && (offset === text.length || !mask[offset])) {
    return null
  }
  let depth = 0
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (!mask[index]) continue
    const char = text[index]
    if (char === ')' || char === ']') depth += 1
    else if (char === '[') depth = Math.max(0, depth - 1)
    else if (char === '(') {
      if (depth === 0) {
        const call = parseCallAt(text, index, mask)
        if (!call || call.argsEnd < offset) return null
        return call
      }
      depth -= 1
    } else if (char === ';' && depth === 0) return null
  }
  return null
}

/** Every call in the text, outer calls before the calls nested in them. */
export const findCalls = (text: string, mask: Uint8Array = codeMask(text)): CallSite[] => {
  const calls: CallSite[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (!mask[index] || text[index] !== '(') continue
    const call = parseCallAt(text, index, mask)
    if (call) calls.push(call)
  }
  return calls
}

/** The index of the argument that holds `offset`. */
export const argIndexAt = (call: CallSite, offset: number): number =>
  call.args.findIndex((arg) => offset >= arg.start && offset <= arg.end)

/** A parameter written without a value: `Q => ` or an empty slot between commas. */
export const isEmptyArg = (arg: CallArg): boolean => (arg.name ? arg.value === '' : arg.text === '')

export interface TextEditRange {
  start: number
  end: number
  text: string
}

/**
 * The edit that removes every empty parameter of `call` and the commas around them, keeping the
 * layout of the others, or `null` when there is nothing to remove.
 */
export const removeEmptyArgs = (text: string, call: CallSite): TextEditRange | null => {
  if (!call.args.some(isEmptyArg)) return null
  const kept = call.args.filter((arg) => !isEmptyArg(arg))
  const start = call.openParen + 1
  const end = call.argsEnd
  if (kept.length === 0) return { start, end, text: '' }
  const last = call.args[call.args.length - 1]
  const lastRaw = text.slice(last.start, last.end)
  const trailingSpace = /\s*$/.exec(lastRaw)?.[0] ?? ''
  const lineBreak = trailingSpace.lastIndexOf('\n')
  const trailing = lineBreak === -1 ? '' : trailingSpace.slice(lineBreak)
  const keptLast = kept[kept.length - 1]
  const leading = /^\s*/.exec(text.slice(call.args[0].start, call.args[0].end))?.[0] ?? ''
  const segments = kept.map((arg, index) => {
    let raw = text.slice(arg.start, arg.end)
    if (index === 0 && arg !== call.args[0]) raw = leading + raw.replace(/^\s*/, '')
    return arg === keptLast ? raw.replace(/\s*$/, '') : raw
  })
  return { start, end, text: segments.join(',') + trailing }
}
