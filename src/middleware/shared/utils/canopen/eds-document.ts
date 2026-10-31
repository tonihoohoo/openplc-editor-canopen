/**
 * The line structure of an EDS or DCF text (CiA 306 4.2): sections, entries and the line each
 * comes from. Lenient: lines CiA 306 does not allow are kept as read issues for the check, not
 * thrown, so a vendor file with a stray comment still loads.
 */

export interface EdsEntry {
  /** Key as written. */
  key: string
  value: string
  /** 1-based line number. */
  line: number
}

export interface EdsSection {
  /** Section name as written. */
  name: string
  /** 1-based line of the header. */
  line: number
  /** Entries by lower-case key; the last of duplicate keys wins. */
  entries: Map<string, EdsEntry>
}

export type EdsReadIssueKind =
  | 'trailing-comment'
  | 'not-key-value'
  | 'outside-section'
  | 'leftmost-column'
  | 'duplicate-key'
  | 'duplicate-section'
  | 'unclosed-section'
  | 'line-too-long'
  | 'not-ascii'

export interface EdsReadIssue {
  kind: EdsReadIssueKind
  line: number
  section?: string
  key?: string
  text: string
}

export interface EdsDocument {
  /** Sections by upper-case name; a repeated section adds to the first. */
  sections: Map<string, EdsSection>
  /** The text's lines without line ends. */
  lines: string[]
  issues: EdsReadIssue[]
}

/** CiA 306 4.2: at most 255 characters per line. */
export const EDS_MAX_LINE = 255

const STRING_KEYS = new Set([
  'parametername',
  'denotation',
  'description',
  'vendorname',
  'productname',
  'createdby',
  'modifiedby',
  'ordercode',
  'filename',
  'lasteds',
  'nodename',
  'networkname',
  'uploadfile',
  'downloadfile',
])

/** Sections whose numbered entries are names or text, so a ";" there is part of the value. */
const TEXT_LIST_SECTION = /^([0-9A-F]{4}(NAME|DENOTATION)|COMMENTS|M\d+MODULEINFO|SUPPORTEDMODULES)$/

function isTextValue(section: string, key: string): boolean {
  return STRING_KEYS.has(key.toLowerCase()) || TEXT_LIST_SECTION.test(section.toUpperCase())
}

/** Reads the text into sections and entries; never throws. */
export function readEdsDocument(text: string): EdsDocument {
  const sections = new Map<string, EdsSection>()
  const issues: EdsReadIssue[] = []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let current: EdsSection | null = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = i + 1
    if (raw.length > EDS_MAX_LINE)
      issues.push({ kind: 'line-too-long', line, section: current?.name, text: `${raw.length} characters` })
    if ([...raw].some((c) => c !== '\t' && (c < ' ' || c > '~')))
      issues.push({ kind: 'not-ascii', line, section: current?.name, text: raw.trim().slice(0, 60) })
    const trimmed = raw.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith(';')) {
      if (raw !== trimmed && !raw.startsWith(';'))
        issues.push({ kind: 'leftmost-column', line, section: current?.name, text: 'comment' })
      continue
    }
    if (trimmed.startsWith('[')) {
      if (!raw.startsWith('[')) issues.push({ kind: 'leftmost-column', line, text: trimmed })
      const end = trimmed.indexOf(']')
      if (end < 0) {
        issues.push({ kind: 'unclosed-section', line, text: trimmed })
        current = null
        continue
      }
      const name = trimmed.slice(1, end).trim()
      const upper = name.toUpperCase()
      const known = sections.get(upper)
      if (known) {
        issues.push({ kind: 'duplicate-section', line, section: name, text: `first at line ${known.line}` })
        current = known
      } else {
        current = { name, line, entries: new Map() }
        sections.set(upper, current)
      }
      const rest = trimmed.slice(end + 1).trim()
      if (rest !== '') issues.push({ kind: 'trailing-comment', line, section: name, text: rest })
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq < 0) {
      issues.push({ kind: 'not-key-value', line, section: current?.name, text: trimmed.slice(0, 60) })
      continue
    }
    if (!current) {
      issues.push({ kind: 'outside-section', line, text: trimmed.slice(0, 60) })
      continue
    }
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (!isTextValue(current.name, key)) {
      const comment = /\s*[;#].*$/.exec(value)
      if (comment && comment.index > 0) {
        issues.push({ kind: 'trailing-comment', line, section: current.name, key, text: comment[0].trim() })
        value = value.slice(0, comment.index).trim()
      }
    }
    const lower = key.toLowerCase()
    const previous = current.entries.get(lower)
    if (previous)
      issues.push({
        kind: 'duplicate-key',
        line,
        section: current.name,
        key,
        text: `first at line ${previous.line}`,
      })
    current.entries.set(lower, { key, value, line })
  }
  return { sections, lines, issues }
}

/** The section by name, any case. */
export function edsSection(doc: EdsDocument, name: string): EdsSection | undefined {
  return doc.sections.get(name.toUpperCase())
}

/**
 * [DeviceComissioning] (CiA 306 5.2, spelled so), or the common misspelling [DeviceCommissioning]
 * when the file has only that one.
 */
export function commissioningSection(doc: EdsDocument): EdsSection | undefined {
  return doc.sections.get('DEVICECOMISSIONING') ?? doc.sections.get('DEVICECOMMISSIONING')
}

/** The entry's value in the section, any case; undefined when the section or key is missing. */
export function edsValue(doc: EdsDocument, section: string, key: string): string | undefined {
  return edsSection(doc, section)?.entries.get(key.toLowerCase())?.value
}
